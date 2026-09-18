-- Twelve shifts that were never clocked out of, the oldest running since
-- 6 August — 1,021 hours by the time anybody noticed.
--
-- They exist because the app refused to record a clock-out without a GPS fix,
-- for a check the database never made. That is fixed; this is the mess it left.
--
-- Each is closed at the latest time that person could still have been there:
-- their own shift end where they have one, otherwise their shop's closing time.
-- Anything that cannot be answered honestly — no closing time, or an end that
-- falls before the clock-in — is left open rather than given an invented day.
--
-- Every row written is marked twice, in correction_reason and in geo_flag, so
-- all of them can be listed and reverted with one query. audit_attendance_records
-- records the before-state independently.

begin;

-- The UPDATE branch of this fires on clock_out going from null to set, so
-- without it the owner would get twelve "checked out" push notifications today,
-- one of them for 25 August.
alter table public.attendance_records disable trigger attendance_notify;

with stuck as (
  select a.id, a.clock_in, e.id as emp_id, a.location, a.geo_flag,
         (a.clock_in at time zone 'Asia/Kuwait')::date as day
    from public.attendance_records a
    left join public.employees e on e.user_id = a.user_id
   where a.clock_out is null
     and now() - a.clock_in > interval '16 hours'
),
resolved as (
  select s.*,
         coalesce(sc.shift_end, o.closes_at) as end_at
    from stuck s
    left join lateral (select * from public.schedule_on(s.emp_id, s.day)) sc on true
    left join public.outlets o on o.code = public.resolve_outlet(s.location)
),
closing as (
  select id, geo_flag, (day + end_at) at time zone 'Asia/Kuwait' as closed_at
    from resolved
   where end_at is not null
     and (day + end_at) at time zone 'Asia/Kuwait' > clock_in
)
update public.attendance_records a
   set clock_out = c.closed_at,
       correction_reason = '[estimated clock-out — never recorded; closed at the scheduled shift end]',
       geo_flag = nullif(concat_ws(',', nullif(a.geo_flag, ''), 'estimated_clock_out'), '')
  from closing c
 where a.id = c.id;

alter table public.attendance_records enable trigger attendance_notify;

commit;
