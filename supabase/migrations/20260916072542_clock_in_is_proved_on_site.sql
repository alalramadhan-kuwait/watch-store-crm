-- Being on site is proved by the server, not promised by the phone.
--
-- Until now the geofence test lived only in the browser (MyPortal): the page
-- read the fences, measured the distance and simply chose not to insert when
-- the staff member was too far. The database accepted whatever arrived. The
-- `own_all` policy lets a signed-in person insert their own attendance row, so
-- anyone with the app open could clock in from anywhere by sending the insert
-- without coordinates, with invented coordinates, or from a stale tab — and
-- nothing downstream could tell. A clock-in that says "Timekeeper HQ" only
-- meant "the phone said so".
--
-- Three things change, all inside the database, where they cannot be skipped:
--   1. a self clock-in must carry coordinates, and the server re-measures them
--      against the active geofences. Outside every radius → refused.
--   2. the fix must be a real one: the device must say how accurate it is, and
--      a vague fix (a wifi/IP guess covering half of Kuwait City) is refused,
--      because inside a 200 m circle it proves nothing.
--   3. the site name is written by the server from the fence that matched. The
--      phone no longer gets to name where its owner was standing.
--
-- A manager filling in a missed clock-in by hand is untouched (those rows carry
-- no coordinates and a correction reason) — it is recorded as a manager entry
-- so the two kinds of row are never confused again. Clock-OUT is measured and
-- flagged but never refused: nobody may be trapped on the clock because they
-- stepped out.

-- ── what each clock-in actually proved ──────────────────────────────────────
alter table public.attendance_records
  add column if not exists clock_in_accuracy_m  numeric,
  add column if not exists clock_in_distance_m  numeric,
  add column if not exists clock_out_accuracy_m numeric,
  add column if not exists clock_out_distance_m numeric,
  add column if not exists geo_source           text,
  add column if not exists geo_flag             text;

comment on column public.attendance_records.clock_in_accuracy_m is
  'Radius of uncertainty the device reported for the clock-in fix, in metres. Small = a real GPS lock; large = a wifi/cell guess.';
comment on column public.attendance_records.clock_in_distance_m is
  'Server-measured distance from the matched geofence centre at clock-in, in metres. Written by the database, never by the client.';
comment on column public.attendance_records.geo_source is
  'device = clocked in from a phone and verified against a geofence; manager = entered by hand in Attendance.';
comment on column public.attendance_records.geo_flag is
  'Comma-separated review flags: repeat_fix (coordinates identical to an earlier clock-in — a replayed or mocked position), no_accuracy (the device did not say how accurate its fix was), offsite_clock_out (clocked out beyond the radius).';

-- How vague a fix may be and still count. Indoors in a mall a phone commonly
-- reports 20–80 m; 200 m leaves room for that without accepting a guess so
-- wide it would pass from the next block.
alter table public.settings
  add column if not exists geo_max_accuracy_m integer not null default 200,
  add column if not exists geo_require_accuracy boolean not null default false;

comment on column public.settings.geo_max_accuracy_m is
  'Clock-in is refused when the device reports its location is less accurate than this many metres.';
comment on column public.settings.geo_require_accuracy is
  'Refuse a clock-in that reports no accuracy at all. Off until every phone has reopened the app on the version that sends it — an installed PWA can serve yesterday''s code for days, and a locked-out shop floor at 9am is worse than a flagged row.';

-- ── distance, the same formula the app used, now server-side ────────────────
create or replace function public.geo_distance_m(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
returns numeric
language sql
immutable
parallel safe
as $$
  select (6371000 * 2 * asin(sqrt(
      power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  )))::numeric
$$;

comment on function public.geo_distance_m is 'Great-circle distance in metres (haversine).';

-- ── the gate ────────────────────────────────────────────────────────────────
create or replace function public.attendance_enforce_geofence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role     text;
  v_manager  boolean;
  v_fence    record;
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

    select g.name,
           g.radius_m,
           geo_distance_m(new.clock_in_lat, new.clock_in_lng, g.lat, g.lng) as distance_m
      into v_fence
      from public.geofences g
     where g.active
     order by 3
     limit 1;

    if not found then
      raise exception 'No active work location is configured. Ask your admin to add one in Settings.'
        using errcode = 'check_violation';
    end if;

    new.geo_source          := 'device';
    new.clock_in_distance_m := round(v_fence.distance_m);

    if v_fence.distance_m > v_fence.radius_m then
      raise exception 'Clock-in refused: you are % m from % — outside its % m radius. You must be on site to clock in.',
        round(v_fence.distance_m), v_fence.name, v_fence.radius_m
        using errcode = 'check_violation';
    end if;

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
  -- refuse it: an unclosed day costs more than a questionable one.
  if new.clock_out is not null and old.clock_out is null
     and new.clock_out_lat is not null and new.clock_out_lng is not null then
    select g.name,
           g.radius_m,
           geo_distance_m(new.clock_out_lat, new.clock_out_lng, g.lat, g.lng) as distance_m
      into v_fence
      from public.geofences g
     where g.active
     order by 3
     limit 1;

    if found then
      new.clock_out_distance_m := round(v_fence.distance_m);
      if v_fence.distance_m > v_fence.radius_m then
        new.geo_flag := nullif(concat_ws(',', nullif(new.geo_flag, ''), 'offsite_clock_out'), '');
      end if;
    end if;
  end if;

  return new;
end;
$$;

comment on function public.attendance_enforce_geofence is
  'Re-measures every self clock-in against the active geofences before it is stored, so being on site is proved server-side rather than trusted from the browser.';

drop trigger if exists attendance_geofence_gate on public.attendance_records;
create trigger attendance_geofence_gate
  before insert or update on public.attendance_records
  for each row execute function public.attendance_enforce_geofence();

-- ── history gets its distances, so the past can be read the same way ────────
update public.attendance_records a
   set clock_in_distance_m = (
         select round(geo_distance_m(a.clock_in_lat, a.clock_in_lng, g.lat, g.lng))
           from public.geofences g
          where g.active
          order by 1
          limit 1),
       geo_source = coalesce(a.geo_source, 'device')
 where a.clock_in_lat is not null
   and a.clock_in_distance_m is null;

update public.attendance_records
   set geo_source = 'manager'
 where clock_in_lat is null
   and geo_source is null;
