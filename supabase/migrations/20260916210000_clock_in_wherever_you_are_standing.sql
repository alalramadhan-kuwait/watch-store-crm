-- Clock in at whichever workplace you are standing in.
--
-- Two things were wrong, and between them they make a manager who covers two
-- shops look like someone the system is refusing on purpose. He is not: nothing
-- here has ever read employees.location when deciding a clock-in. That field
-- routes leave approvals and files reports; it does not pin anybody to a shop.
--
-- 1. The gate tested the NEAREST fence instead of the one you are inside.
--
--    It took the closest active geofence and measured you against that one's
--    radius. With sites far apart the two questions have the same answer, so it
--    never showed. Time Gallery and head office are 294 m apart with 120 m
--    radii, which is the only reason it has held so far — widen either one, or
--    add a fourth site near an existing one, and standing inside B while
--    marginally nearer to A is refused with a message about A.
--
--    The app has always looped over every fence and matched any one you are
--    inside. The database disagreed with it. Now it asks the same question.
--
-- 2. The Avenues geofence was called "Avenue".
--
--    The trigger writes the matched fence's name onto the record, so five
--    clock-ins are filed at "Avenue" while the four people who work there are
--    filed at "Avenues" — a workplace that matches nothing, in a column used to
--    join attendance to the roster.

update public.geofences set name = 'Avenues' where name = 'Avenue';
update public.attendance_records set location = 'Avenues' where location = 'Avenue';

create or replace function public.attendance_enforce_geofence()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
declare
  v_role     text;
  v_manager  boolean;
  v_fence    record;
  v_near     record;
  v_all      text;
  v_max_acc  numeric;
  v_require_acc boolean;
  v_repeat   boolean;
begin
  -- Service-role work (edge functions, cron, backfills) has no signed-in user
  -- and is not a clock-in; leave it alone.
  if auth.uid() is null then
    return new;
  end if;

  v_role    := coalesce(get_my_role(), '');
  v_manager := v_role in ('admin', 'manager', 'hr');

  if tg_op = 'INSERT' then
    -- No coordinates = not a clock-in from a phone. Only a manager may write
    -- one of those, and it is marked as theirs.
    if new.clock_in_lat is null or new.clock_in_lng is null then
      if v_manager then
        new.geo_source := 'manager';
        new.clock_in_distance_m := null;
        return new;
      end if;
      raise exception 'Clock-in needs your location. Allow location access in your browser and try again.'
        using errcode = 'check_violation';
    end if;

    -- The fence you are INSIDE, nearest first. Not the nearest fence, which is
    -- a different question and gives a different answer wherever two sites are
    -- close enough for their circles to matter.
    select g.name,
           g.radius_m,
           geo_distance_m(new.clock_in_lat, new.clock_in_lng, g.lat, g.lng) as distance_m
      into v_fence
      from public.geofences g
     where g.active
       and geo_distance_m(new.clock_in_lat, new.clock_in_lng, g.lat, g.lng) <= g.radius_m
     order by 3
     limit 1;

    if not found then
      -- Nowhere contains you. Measure the nearest so the refusal can say how
      -- far off you are, and name every site, because somebody who covers two
      -- shops should not have to guess which one the app had in mind.
      select g.name,
             g.radius_m,
             geo_distance_m(new.clock_in_lat, new.clock_in_lng, g.lat, g.lng) as distance_m
        into v_near
        from public.geofences g
       where g.active
       order by 3
       limit 1;

      if not found then
        raise exception 'No active work location is configured. Ask your admin to add one in Settings.'
          using errcode = 'check_violation';
      end if;

      new.geo_source          := 'device';
      new.clock_in_distance_m := round(v_near.distance_m);

      select string_agg(
               g.name || ' ' || round(geo_distance_m(new.clock_in_lat, new.clock_in_lng, g.lat, g.lng)) || ' m',
               ', ' order by geo_distance_m(new.clock_in_lat, new.clock_in_lng, g.lat, g.lng))
        into v_all
        from public.geofences g
       where g.active;

      raise exception 'Clock-in refused: you are not at any workplace. You can clock in at whichever one you are standing in — right now you are %.',
        v_all
        using errcode = 'check_violation';
    end if;

    new.geo_source          := 'device';
    new.clock_in_distance_m := round(v_fence.distance_m);

    select coalesce(s.geo_max_accuracy_m, 200), coalesce(s.geo_require_accuracy, false)
      into v_max_acc, v_require_acc
      from public.settings s limit 1;
    v_max_acc     := coalesce(v_max_acc, 200);
    v_require_acc := coalesce(v_require_acc, false);

    -- An older app version (an installed PWA can serve cached code for days)
    -- sends no accuracy. The distance test above has already been passed, so
    -- the row is kept and flagged rather than refused — until the admin turns
    -- the requirement on, once every phone has been reopened.
    if new.clock_in_accuracy_m is null then
      if v_require_acc then
        raise exception 'Clock-in refused: your device did not report how accurate its location is. Close and reopen the app, then try again.'
          using errcode = 'check_violation';
      end if;
      new.geo_flag := 'no_accuracy';
    elsif new.clock_in_accuracy_m > v_max_acc then
      raise exception 'Clock-in refused: your phone only placed you within % m, which is too vague to prove you are at %. Turn on precise location (and wifi), stand near a window or door, and try again.',
        round(new.clock_in_accuracy_m), v_fence.name
        using errcode = 'check_violation';
    end if;

    -- The fence that matched names the site. The phone does not.
    new.location := v_fence.name;

    -- A live fix is never identical to an old one down to the last decimal;
    -- a repeat means a saved, cached or mocked position. Recorded, not refused,
    -- because a manager should judge it with the person in front of them.
    select exists (
      select 1 from public.attendance_records r
       where r.user_id = new.user_id
         and r.clock_in_lat = new.clock_in_lat
         and r.clock_in_lng = new.clock_in_lng
    ) into v_repeat;
    if v_repeat then
      new.geo_flag := nullif(concat_ws(',', nullif(new.geo_flag, ''), 'repeat_fix'), '');
    end if;

    return new;
  end if;

  -- ── UPDATE ────────────────────────────────────────────────────────────────
  -- Staff may only close their own day. Everything that decides the record —
  -- when it started, where it was, whether it was late — is a manager's to
  -- change, with a correction reason, in Attendance.
  if not v_manager then
    if new.clock_in       is distinct from old.clock_in
       or new.clock_in_lat  is distinct from old.clock_in_lat
       or new.clock_in_lng  is distinct from old.clock_in_lng
       or new.user_id       is distinct from old.user_id
       or new.employee_name is distinct from old.employee_name
       or new.location      is distinct from old.location
       or new.is_late       is distinct from old.is_late
       or new.justified     is distinct from old.justified
       or new.clock_in_distance_m is distinct from old.clock_in_distance_m
       or new.clock_in_accuracy_m is distinct from old.clock_in_accuracy_m
       or new.geo_source    is distinct from old.geo_source
       or new.geo_flag      is distinct from old.geo_flag then
      raise exception 'Only a manager can change a clock-in. Ask for an attendance correction from My Portal.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- Measure the clock-out and flag it if it happened off site — but never
  -- refuse it: an unclosed day costs more than a questionable one. Off site
  -- means outside every fence, for the same reason as above: a manager who
  -- finishes at the other shop has not left work.
  if new.clock_out is not null and old.clock_out is null
     and new.clock_out_lat is not null and new.clock_out_lng is not null then
    select g.name,
           g.radius_m,
           geo_distance_m(new.clock_out_lat, new.clock_out_lng, g.lat, g.lng) as distance_m
      into v_near
      from public.geofences g
     where g.active
     order by 3
     limit 1;

    if found then
      new.clock_out_distance_m := round(v_near.distance_m);
      if not exists (
        select 1 from public.geofences g
         where g.active
           and geo_distance_m(new.clock_out_lat, new.clock_out_lng, g.lat, g.lng) <= g.radius_m
      ) then
        new.geo_flag := nullif(concat_ws(',', nullif(new.geo_flag, ''), 'offsite_clock_out'), '');
      end if;
    end if;
  end if;

  return new;
end;
$function$;
