-- A clock-out has never needed a location, and refusing one for want of a GPS
-- fix leaves the shift open instead.
--
-- The rule was already this way: the block at the end only ever ran when the
-- device had produced coordinates, and even then it only flagged an off-site
-- clock-out rather than refusing it. There is no geofence test on leaving at
-- all. The app was the strict one, and the cost is shifts nobody could close —
-- ten of them open when this was written, the oldest running since 6 August.
-- A salesperson who could not clock out asked for a correction instead, which
-- is how a request to fix a leaving time arrived as a request to change a
-- check-in to the value it already had.
--
-- So a clock-out with no coordinates is now recorded, and the fact that nothing
-- confirmed where the person was is recorded with it.
--
-- Only the final block differs from 20260916210000; the rest is carried over
-- unchanged because create or replace takes the whole function.

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
  if auth.uid() is null then
    return new;
  end if;

  v_role    := coalesce(get_my_role(), '');
  v_manager := v_role in ('admin', 'manager', 'hr');

  if tg_op = 'INSERT' then
    if new.clock_in_lat is null or new.clock_in_lng is null then
      if v_manager then
        new.geo_source := 'manager';
        new.clock_in_distance_m := null;
        return new;
      end if;
      raise exception 'Clock-in needs your location. Allow location access in your browser and try again.'
        using errcode = 'check_violation';
    end if;

    -- The fence you are INSIDE, nearest first — not the nearest fence, which
    -- is a different question wherever two sites are close enough to matter.
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

    new.location := v_fence.name;

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

  if new.clock_out is not null and old.clock_out is null then
    if new.clock_out_lat is not null and new.clock_out_lng is not null then
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

    -- No coordinates. The leaving time is still true and is still recorded;
    -- what is missing is recorded with it, so somebody can ask about it later.
    -- Not flagged for a manager entering a day by hand, and not for an approved
    -- correction being applied — neither of those was ever a person standing
    -- somewhere with a phone.
    elsif coalesce(new.geo_source, 'device') = 'device'
      and new.correction_reason is not distinct from old.correction_reason
    then
      new.geo_flag := nullif(concat_ws(',', nullif(new.geo_flag, ''), 'no_clock_out_location'), '');
    end if;
  end if;

  return new;
end;
$function$;

comment on column public.attendance_records.geo_flag is
  'Comma-separated notes about how a record was placed, for a human deciding whether to ask: no_accuracy (the device did not say how precise it was), repeat_fix (identical coordinates to an earlier clock-in), offsite_clock_out (left outside every geofence), no_clock_out_location (the device could not produce a position at all when clocking out).';
