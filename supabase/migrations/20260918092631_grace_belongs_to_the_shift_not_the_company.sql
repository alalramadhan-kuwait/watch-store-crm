-- The hour of grace is a company default, not a fact about every shift.
--
-- settings.late_grace_minutes is one number for everybody, and it was written
-- for the office's 09:00 start: turning up by 10:00 is on time. Applied on top
-- of somebody's own shift it quietly moves their deadline too. Ali Akbar starts
-- at 10:00, so the same rule gave him until 11:00 — and fourteen mornings that
-- anybody would call late scored as on time. Two hours of lateness in September
-- rather than seven and a half.
--
-- Grace now lives on the schedule, beside the shift it forgives. Null means
-- "use the company default", which is every existing row, so nothing changes
-- for anybody until a number is set. Zero is a real answer, not a missing one:
-- the shift start is the deadline.
--
-- set_schedule takes it too, so it is reachable from the HR screen rather than
-- being a column only SQL can write.

alter table public.employee_schedules
  add column if not exists grace_minutes smallint;

comment on column public.employee_schedules.grace_minutes is
  'Minutes after the shift start that still count as on time. Null = use settings.late_grace_minutes. 0 = the shift start is the deadline.';

alter table public.employee_schedules drop constraint if exists employee_schedules_grace_is_sane;
alter table public.employee_schedules add constraint employee_schedules_grace_is_sane
  check (grace_minutes is null or (grace_minutes >= 0 and grace_minutes <= 240));

-- v_requests reads schedule_on, so the view stands down while its return type
-- changes and is rebuilt immediately after. Recreated verbatim below.
drop view if exists public.v_requests;

drop function if exists public.schedule_on(uuid, date);

create function public.schedule_on(p_employee uuid, p_date date)
returns table (working_days smallint[], shift_start time, shift_end time,
               grace_minutes smallint, dated boolean)
language sql stable
set search_path to 'public', 'pg_temp'
as $$
  select s.working_days, s.shift_start, s.shift_end, s.grace_minutes, true
    from public.employee_schedules s
   where s.employee_id = p_employee
     and p_date >= s.effective_from
     and (s.effective_to is null or p_date <= s.effective_to)
   order by s.effective_from desc
   limit 1
$$;

create or replace function public.set_schedule(
  p_employee uuid,
  p_from     date,
  p_to       date       default null,
  p_days     smallint[] default null,
  p_start    time       default null,
  p_end      time       default null,
  p_note     text       default null,
  p_grace    smallint   default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  tail_days  smallint[];
  tail_start time;
  tail_end   time;
  tail_note  text;
  tail_grace smallint;
  tail_to    date;
  tail_found boolean := false;
begin
  if get_my_role() is null or get_my_role() not in ('admin', 'manager', 'hr') then
    raise exception 'Only HR, a manager or an admin can change a work schedule';
  end if;
  if p_to is not null and p_to < p_from then
    raise exception 'The end of a schedule cannot come before its start';
  end if;
  if not exists (select 1 from public.employees where id = p_employee) then
    raise exception 'No such employee';
  end if;

  if p_to is not null then
    select s.working_days, s.shift_start, s.shift_end, s.note, s.grace_minutes, s.effective_to, true
      into tail_days, tail_start, tail_end, tail_note, tail_grace, tail_to, tail_found
      from public.employee_schedules s
     where s.employee_id = p_employee
       and s.effective_from <= p_to
       and (s.effective_to is null or s.effective_to >= p_to)
     order by s.effective_from desc
     limit 1;
  end if;

  update public.employee_schedules
     set effective_to = p_from - 1
   where employee_id = p_employee
     and effective_from < p_from
     and (effective_to is null or effective_to >= p_from);

  delete from public.employee_schedules
   where employee_id = p_employee
     and effective_from >= p_from
     and (p_to is null or (effective_to is not null and effective_to <= p_to));

  if p_to is null then
    delete from public.employee_schedules
     where employee_id = p_employee and effective_from >= p_from;
  else
    update public.employee_schedules
       set effective_from = p_to + 1
     where employee_id = p_employee
       and effective_from between p_from and p_to
       and (effective_to is null or effective_to > p_to);
  end if;

  insert into public.employee_schedules
    (employee_id, effective_from, effective_to, working_days, shift_start, shift_end,
     grace_minutes, note, created_by)
  values
    (p_employee, p_from, p_to, coalesce(p_days, '{0,1,2,3,4,6}'::smallint[]),
     p_start, p_end, p_grace, p_note, auth.uid());

  if p_to is not null
     and tail_found
     and (tail_to is null or tail_to > p_to)
     and not exists (
       select 1 from public.employee_schedules
        where employee_id = p_employee and effective_from = p_to + 1)
  then
    insert into public.employee_schedules
      (employee_id, effective_from, effective_to, working_days, shift_start, shift_end,
       grace_minutes, note, created_by)
    values
      (p_employee, p_to + 1, tail_to, tail_days, tail_start, tail_end,
       tail_grace, tail_note, auth.uid());
  end if;
end $$;

grant execute on function public.set_schedule(uuid, date, date, smallint[], time, time, text, smallint) to authenticated;

/* Ali Akbar starts at 10:00 and arriving after 10:00 is late — his shift start
   is the deadline, with no hour laid on top of it. */
update public.employee_schedules s
   set grace_minutes = 0
  from public.employees e
 where e.id = s.employee_id
   and e.full_name = 'Ali Akbar Modi'
   and s.effective_to is null;

-- The view, unchanged, rebuilt on the new schedule_on.
drop view if exists public.v_requests;

create view public.v_requests
with (security_invoker = true) as
select
  q.source, q.id, q.kind,
  q.employee_id, q.employee_name, q.employee_user_id, q.outlet,
  q.details,
  case when position(': ' in q.details) > 0
       then left(q.details, position(': ' in q.details) - 1)
       else q.details end                                   as reason,
  q.attendance_date, q.attendance_record_id,
  q.proposed_clock_in, q.proposed_clock_out,
  q.proposed_from, q.proposed_until, q.proposed_days,
  q.proposed_shift_start, q.proposed_shift_end,
  cur.clock_in                                              as current_clock_in,
  cur.clock_out                                             as current_clock_out,
  coalesce(cur.shifts, 0)                                   as current_shifts,
  sch.shift_start                                           as current_shift_start,
  sch.shift_end                                             as current_shift_end,
  sch.working_days                                          as current_working_days,
  case when q.kind <> 'Attendance correction' then false else coalesce(
    (q.proposed_clock_in is null
      or to_char(q.proposed_clock_in  at time zone 'Asia/Kuwait', 'HH24:MI')
       = to_char(cur.clock_in         at time zone 'Asia/Kuwait', 'HH24:MI'))
    and
    (q.proposed_clock_out is null
      or to_char(q.proposed_clock_out at time zone 'Asia/Kuwait', 'HH24:MI')
       = to_char(cur.clock_out        at time zone 'Asia/Kuwait', 'HH24:MI')),
    false) end                                              as changes_nothing,
  q.status, q.manager_status,
  public.stage_owner(q.status, q.manager_status)            as stage_owner,
  round(extract(epoch from (now() - q.submitted_at)) / 3600.0, 1) as hours_pending,
  (public.stage_owner(q.status, q.manager_status) <> 'nobody'
   and now() - q.submitted_at > interval '24 hours')        as is_overdue,
  rem.last_at                                               as last_reminder_at,
  coalesce(rem.n, 0)                                        as reminder_count,
  q.submitted_at,
  q.on_behalf_by,   ob.full_name                            as on_behalf_name,
  fa.manager_id                                             as first_approver_id,
  fa.full_name                                              as first_approver_name,
  q.manager_remarks,
  q.manager_decided_by, md.full_name                        as manager_decided_name,
  q.manager_decided_at,
  q.final_decided_by,   fd.full_name                        as final_decided_name,
  q.final_decided_at,
  q.withdrawn_at,
  q.override_by,        ov.full_name                        as override_name,
  q.override_at, q.override_reason, q.override_stage
from (
  select
    'employee_requests'::text as source, r.id, r.request_type as kind,
    r.employee_id, e.full_name as employee_name, r.user_id as employee_user_id,
    e.location as outlet, r.details,
    r.attendance_date, r.attendance_record_id,
    r.proposed_clock_in, r.proposed_clock_out,
    r.proposed_from, r.proposed_until, r.proposed_days,
    r.proposed_shift_start, r.proposed_shift_end,
    r.status, coalesce(r.manager_status, 'Not required') as manager_status,
    r.created_at as submitted_at, r.on_behalf_by, r.manager_remarks,
    r.manager_decided_by, r.manager_decided_at,
    r.final_decided_by, r.final_decided_at, r.withdrawn_at,
    r.override_by, r.override_at, r.override_reason, r.override_stage
  from public.employee_requests r
  left join public.employees e on e.id = r.employee_id
  union all
  select
    'leave_records', l.id, 'Leave',
    l.employee_id, e.full_name, e.user_id, e.location,
    coalesce(l.leave_type, 'Leave') || ' - ' || l.leave_start || ' to ' || l.leave_end
      || coalesce(' - ' || l.notes, ''),
    null, null, null, null,
    l.leave_start, l.leave_end, null, null, null,
    l.approval_status, coalesce(l.manager_status, 'Not required'),
    l.created_at, l.on_behalf_by, null,
    l.manager_decided_by, l.manager_decided_at,
    l.final_decided_by, l.final_decided_at, l.withdrawn_at,
    l.override_by, l.override_at, l.override_reason, l.override_stage
  from public.leave_records l
  left join public.employees e on e.id = l.employee_id
) q
left join lateral public.attendance_on_day(q.employee_user_id, q.attendance_date) cur on true
left join lateral public.schedule_on(q.employee_id, coalesce(q.proposed_from, current_date)) sch on true
left join lateral (
  select max(sent_at) as last_at, count(*)::int as n
    from public.request_reminders rr
   where rr.source = q.source and rr.request_id = q.id
) rem on true
left join lateral (
  select ms.manager_id, pr.full_name
    from public.manager_scopes ms
    join public.profiles pr on pr.id = ms.manager_id
   where ms.location = q.outlet
   limit 1
) fa on true
left join public.profiles ob on ob.id = q.on_behalf_by
left join public.profiles md on md.id = q.manager_decided_by
left join public.profiles fd on fd.id = q.final_decided_by
left join public.profiles ov on ov.id = q.override_by;

comment on view public.v_requests is
  'Every request of every type, with everything either inbox needs already resolved. Neither app computes a stage, a name, a comparison or a reminder state of its own.';

grant select on public.v_requests to authenticated;
