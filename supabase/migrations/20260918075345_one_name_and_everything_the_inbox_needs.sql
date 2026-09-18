-- One name for Hussein, and a view that answers every question both inboxes ask.
--
-- Two jobs, together because the second displays the first.
--
-- The name: he was three people. 'Hussein Deeb' in the staff roster, on his
-- sales identity and across 492 case records; 'Hussain Deeb' on his login;
-- 'Hussain Dib' on his employee record and his attendance. The roster spelling
-- wins because it is the analytics key those 492 rows join on — renaming it
-- would orphan them, while renaming the other two costs nothing.
--
-- The view: v_requests existed but stopped at the workflow columns, so an app
-- wanting to show "Current 14:12 → Requested 15:00", or the name of the manager
-- it is waiting on, had to go and work it out. That is the duplicate logic this
-- whole exercise is meant to kill. Everything either inbox needs is now a
-- column: the names behind the ids, the attendance actually on record, whether
-- the request changes anything at all, and how long it has been waiting.

begin;

-- ---------------------------------------------------------------------------
-- 1. One spelling
-- ---------------------------------------------------------------------------

update public.employees
   set full_name = 'Hussein Deeb'
 where user_id = '9722777c-1065-41b7-9715-dd27c23cf726'
   and full_name is distinct from 'Hussein Deeb';

update public.profiles
   set full_name = 'Hussein Deeb'
 where id = '9722777c-1065-41b7-9715-dd27c23cf726'
   and full_name is distinct from 'Hussein Deeb';

/* attendance_records carries a copy of the name, kept in step by
   attendance_set_canonical_name, which reads employees.full_name. Touching the
   rows makes that trigger recompute them rather than hard-coding the string
   twice. */
update public.attendance_records
   set employee_name = employee_name
 where user_id = '9722777c-1065-41b7-9715-dd27c23cf726';

-- ---------------------------------------------------------------------------
-- 2. What is actually on the attendance record for a day
-- ---------------------------------------------------------------------------

/* The "Current" column of a correction. A day may hold several shifts, so it
   opens at the first clock-in and closes at the last clock-out, and says how
   many there were — an approver moving a time on a two-shift day should be told
   that is what they are doing.

   SECURITY DEFINER because the view is security_invoker: a store manager must be
   able to see the attendance behind a request they are deciding without being
   given the attendance table. */
create or replace function public.attendance_on_day(p_user_id uuid, p_date date)
returns table (clock_in timestamptz, clock_out timestamptz, shifts int)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select min(a.clock_in), max(a.clock_out), count(*)::int
    from public.attendance_records a
   where a.user_id = p_user_id
     and (a.clock_in at time zone 'Asia/Kuwait')::date = p_date
$$;

grant execute on function public.attendance_on_day(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Everything both inboxes read
-- ---------------------------------------------------------------------------

drop view if exists public.v_requests;

create view public.v_requests
with (security_invoker = true) as
select
  -- identity ----------------------------------------------------------------
  q.source, q.id, q.kind,
  q.employee_id, q.employee_name, q.employee_user_id, q.outlet,

  -- what is being asked -----------------------------------------------------
  q.details,
  case when position(': ' in q.details) > 0
       then left(q.details, position(': ' in q.details) - 1)
       else q.details end                                   as reason,
  q.attendance_date, q.attendance_record_id,
  q.proposed_clock_in, q.proposed_clock_out,
  q.proposed_from, q.proposed_until, q.proposed_days,
  q.proposed_shift_start, q.proposed_shift_end,

  -- what is on the record today, for a Current → Requested table ------------
  cur.clock_in                                              as current_clock_in,
  cur.clock_out                                             as current_clock_out,
  coalesce(cur.shifts, 0)                                   as current_shifts,

  /* A request that asks for the times already recorded. The correction form
     used to pre-fill the arrival, so somebody wanting to fix only their
     leaving time submitted a request that changed nothing — which is exactly
     what happened on 17 September. Both apps warn on this rather than each
     working it out. */
  case when q.kind <> 'Attendance correction' then false else coalesce(
    (q.proposed_clock_in is null
      or to_char(q.proposed_clock_in  at time zone 'Asia/Kuwait', 'HH24:MI')
       = to_char(cur.clock_in         at time zone 'Asia/Kuwait', 'HH24:MI'))
    and
    (q.proposed_clock_out is null
      or to_char(q.proposed_clock_out at time zone 'Asia/Kuwait', 'HH24:MI')
       = to_char(cur.clock_out        at time zone 'Asia/Kuwait', 'HH24:MI')),
    false) end                                              as changes_nothing,

  -- where it is -------------------------------------------------------------
  q.status, q.manager_status,
  public.stage_owner(q.status, q.manager_status)            as stage_owner,
  round(extract(epoch from (now() - q.submitted_at)) / 3600.0, 1) as hours_pending,
  /* Overdue at a day. The reminder job will read the same number, so "Overdue"
     on the dashboard and a reminder firing never disagree. */
  (public.stage_owner(q.status, q.manager_status) <> 'nobody'
   and now() - q.submitted_at > interval '24 hours')        as is_overdue,

  -- who, by name, not by id -------------------------------------------------
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
    coalesce(l.leave_type, 'Leave') || ' · ' || l.leave_start || ' to ' || l.leave_end
      || coalesce(' · ' || l.notes, ''),
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
  'Every request of every type, with everything either inbox needs already resolved: names behind the ids, the attendance actually on record, whether the request changes anything, how long it has waited. Neither app computes a stage, a name or a comparison of its own.';

grant select on public.v_requests to authenticated;

commit;
