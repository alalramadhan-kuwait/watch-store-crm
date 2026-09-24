-- A clock-in counts once.
--
-- On 24 Sep a clock-in went through twice, ten seconds apart, and the two
-- records covering the same afternoon were added up: 13h 41m for a 6h 51m day.
-- Two changes, so it cannot happen again and would not be counted if it did.

-- 1. Nobody can open a second shift while one is already open. Shifts left
--    open past attendance_abandon_hours() were never clocked out; they do not
--    block, or a forgotten clock-out would lock someone out of the next day.
--    The advisory lock makes two taps that arrive together queue, so the
--    second sees the first.
create or replace function public.attendance_one_open_shift()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_open timestamptz;
begin
  if new.clock_out is not null or new.user_id is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('attendance-open:' || new.user_id::text, 0));
  select a.clock_in into v_open
    from public.attendance_records a
   where a.user_id = new.user_id
     and a.clock_out is null
     and a.id is distinct from new.id
     and a.clock_in > now() - make_interval(secs => (attendance_abandon_hours() * 3600)::double precision)
   order by a.clock_in desc
   limit 1;
  if v_open is not null then
    raise exception 'You are already clocked in since %. Clock out first.',
      to_char(v_open at time zone 'Asia/Kuwait', 'FMHH12:MI AM')
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists attendance_one_open_shift on public.attendance_records;
create trigger attendance_one_open_shift
  before insert on public.attendance_records
  for each row execute function public.attendance_one_open_shift();

-- 2. A day's hours count overlapping time once (mirrors dayHours() in
--    src/shared/workedHours.ts). Each usable shift is credited only for the
--    part that runs past the furthest end of the shifts that began before it.
create or replace view public.attendance_day_hours
with (security_invoker = true) as
with spans as (
  select s.*,
         case when s.hours is null then null else s.clock_in end as span_start,
         case when s.hours is null then null
              when s.clock_out is null then greatest(s.clock_in, now())
              else s.clock_out end as span_end
    from public.attendance_shifts s
), reach as (
  select sp.*,
         max(sp.span_end) over (
           partition by sp.employee_id, sp.user_id, sp.employee_name, sp.work_date
           order by sp.span_start nulls last, sp.id
           rows between unbounded preceding and 1 preceding) as prior_reach
    from spans sp
)
select employee_id,
       user_id,
       employee_name,
       work_date,
       round(sum(case when span_start is null then null
                      else greatest(0::numeric,
                             extract(epoch from (span_end - greatest(span_start, coalesce(prior_reach, span_start)))) / 3600.0)
                 end), 4) as hours,
       count(*) as shifts,
       count(*) filter (where hours is null) as unusable_shifts,
       bool_or(is_open and not is_abandoned) as on_the_floor,
       bool_or(is_abandoned) as has_abandoned,
       bool_or(is_late) as late,
       min(clock_in) as first_in,
       max(clock_out) as last_out,
       array_agg(distinct outlet_code) filter (where outlet_code is not null) as outlet_codes
  from reach
 group by employee_id, user_id, employee_name, work_date;
