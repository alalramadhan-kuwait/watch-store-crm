-- One approval workflow, for every kind of request.
--
-- The audit found two parallel systems. leave_records had the chain that was
-- actually wanted — manager, then owner, each stamped with who and when, scoped
-- by outlet, guarded by a trigger. employee_requests had a single status column,
-- no manager stage, no scoping, and a policy that let any manager hard-delete
-- any request from any outlet.
--
-- This gives both tables the same spine, the same vocabulary and the same guard,
-- so neither app can compute a status of its own: Employee → Store Manager →
-- Owner → Completed, decided in the database.
--
-- Three things change in behaviour, not just in shape:
--
--   1. A request filed BY an admin or HR on somebody's behalf no longer skips
--      the manager. That single line is why fourteen of fifteen leave records
--      read 'Not required' and never reached the store manager.
--   2. The owner can still bypass the manager, but never silently. It now costs
--      a written reason and is recorded as 'Overridden' against the stage it
--      skipped.
--   3. An employee can withdraw or edit their own request while it is still
--      Pending, and nobody can hard-delete one.

begin;

-- ---------------------------------------------------------------------------
-- 1. The spine, added to employee_requests so it matches leave_records
-- ---------------------------------------------------------------------------

alter table public.employee_requests
  add column if not exists manager_status      text,
  add column if not exists manager_decided_by  uuid,
  add column if not exists manager_decided_at  timestamptz,
  add column if not exists final_decided_by    uuid,
  add column if not exists final_decided_at    timestamptz,
  add column if not exists withdrawn_at        timestamptz,
  add column if not exists on_behalf_by        uuid,
  -- Schedule change: the fourth request type, which had no path at all. An
  -- employee could not ask for one; schedules moved only through set_schedule().
  add column if not exists proposed_from        date,
  add column if not exists proposed_until       date,
  add column if not exists proposed_days        smallint[],
  add column if not exists proposed_shift_start time,
  add column if not exists proposed_shift_end   time;

comment on column public.employee_requests.manager_status is
  'First-stage decision. Pending / Approved / Rejected / Not required / Overridden. Never set to ''Not required'' by hand — request_needs_manager() decides it.';
comment on column public.employee_requests.on_behalf_by is
  'Set when somebody other than the employee filed this. Does NOT skip the manager stage.';

-- The override, on both tables. Bypassing a stage is a real event with an
-- author and a reason, not the absence of one.
alter table public.employee_requests
  add column if not exists override_by     uuid,
  add column if not exists override_at     timestamptz,
  add column if not exists override_reason text,
  add column if not exists override_stage  text;

alter table public.leave_records
  add column if not exists override_by     uuid,
  add column if not exists override_at     timestamptz,
  add column if not exists override_reason text,
  add column if not exists override_stage  text,
  add column if not exists on_behalf_by    uuid,
  add column if not exists withdrawn_at    timestamptz;

-- ---------------------------------------------------------------------------
-- 2. One vocabulary
-- ---------------------------------------------------------------------------

alter table public.employee_requests drop constraint if exists employee_requests_status_check;
alter table public.employee_requests add constraint employee_requests_status_check
  check (status = any (array['Pending','Approved','Rejected','Withdrawn','Completed']));

alter table public.employee_requests drop constraint if exists employee_requests_manager_status_check;
alter table public.employee_requests add constraint employee_requests_manager_status_check
  check (manager_status is null
         or manager_status = any (array['Pending','Approved','Rejected','Not required','Overridden']));

alter table public.leave_records drop constraint if exists leave_records_manager_status_check;
alter table public.leave_records add constraint leave_records_manager_status_check
  check (manager_status is null
         or manager_status = any (array['Pending','Approved','Rejected','Not required','Overridden']));

-- Schedule change joins the list. 'Leave' is deliberately NOT added here —
-- leave keeps its own table because it carries dates, balances and documents;
-- what it shares is the workflow, not the storage.
alter table public.employee_requests drop constraint if exists employee_requests_request_type_check;
alter table public.employee_requests add constraint employee_requests_request_type_check
  check (request_type = any (array['HR update','Attendance correction','Schedule change']));

-- A schedule change has to say when it starts.
alter table public.employee_requests drop constraint if exists employee_requests_schedule_has_a_start;
alter table public.employee_requests add constraint employee_requests_schedule_has_a_start
  check (request_type <> 'Schedule change' or proposed_from is not null);

alter table public.employee_requests drop constraint if exists employee_requests_schedule_ends_after_it_starts;
alter table public.employee_requests add constraint employee_requests_schedule_ends_after_it_starts
  check (proposed_until is null or proposed_from is null or proposed_until >= proposed_from);

-- ---------------------------------------------------------------------------
-- 3. Who decides — shared by both tables
-- ---------------------------------------------------------------------------

/* Does this request need a store manager's first approval?
   Unlike the leave version this replaces, it does NOT care who is filing it.
   An admin or HR entering a request on somebody's behalf is still that
   person's request, and their manager still sees it. */
create or replace function public.request_needs_manager(p_employee_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1
      from employees e
      left join profiles p on p.id = e.user_id
      join manager_scopes ms on ms.location = e.location
     where e.id = p_employee_id
       -- a manager or an owner has no first approver above them but the owner
       and coalesce(p.role, '') not in ('manager', 'admin')
       -- and nobody is their own first approver
       and ms.manager_id is distinct from e.user_id
  )
$$;

comment on function public.request_needs_manager(uuid) is
  'True when this employee has a store manager who is not themselves. Decides the first stage for every request type. Deliberately blind to who filed the request.';

/* Is the caller the store manager for this employee's outlet? */
create or replace function public.request_in_my_scope(p_employee_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1
      from employees e
      join manager_scopes ms on ms.location = e.location
     where e.id = p_employee_id
       and ms.manager_id = auth.uid()
  )
$$;

/* The same question for an employee_requests row, which may name the person by
   employee_id or only by the login that filed it. */
create or replace function public.req_row_in_my_scope(p_employee_id uuid, p_user_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1
      from employees e
      join manager_scopes ms on ms.location = e.location
     where (e.id = p_employee_id or (p_employee_id is null and e.user_id = p_user_id))
       and ms.manager_id = auth.uid()
  )
$$;

grant execute on function public.request_needs_manager(uuid) to authenticated;
grant execute on function public.request_in_my_scope(uuid) to authenticated;
grant execute on function public.req_row_in_my_scope(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. The guard, written once and applied to both tables
-- ---------------------------------------------------------------------------

/* Shared stage logic. Takes and returns the four workflow fields plus the
   override fields, so the two triggers below differ only in which columns they
   read — the rules themselves exist in exactly one place. */
create or replace function public.workflow_guard(
  p_op              text,
  p_employee_id     uuid,
  p_owner_user_id   uuid,        -- the employee's own login, for withdrawal
  p_old_manager     text,
  p_new_manager     text,
  p_old_final       text,
  p_new_final       text,
  p_override_reason text,
  inout o_manager   text default null,
  inout o_final     text default null,
  out   o_mgr_by    uuid,
  out   o_mgr_at    timestamptz,
  out   o_fin_by    uuid,
  out   o_fin_at    timestamptz,
  out   o_ovr_by    uuid,
  out   o_ovr_at    timestamptz,
  out   o_ovr_stage text
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  caller text := get_my_role();
begin
  o_manager := p_new_manager;
  o_final   := p_new_final;

  if p_op = 'INSERT' then
    -- The stage is decided by the employee's outlet, never by who is typing.
    o_manager := case when request_needs_manager(p_employee_id)
                      then 'Pending' else 'Not required' end;
    return;
  end if;

  -- First stage --------------------------------------------------------------
  if p_new_manager is distinct from p_old_manager then
    if not (caller = 'admin' or can_give_first_approval(p_employee_id)) then
      raise exception 'Only this employee''s store manager can give the first approval';
    end if;
    if p_new_manager in ('Approved', 'Rejected') then
      o_mgr_by := auth.uid();
      o_mgr_at := now();
    end if;
    -- A manager's rejection ends it; there is nothing for the owner to weigh.
    if p_new_manager = 'Rejected' then
      o_final := 'Rejected';
    end if;
  end if;

  -- Final stage --------------------------------------------------------------
  if p_new_final is distinct from p_old_final then
    -- The employee withdrawing their own pending request.
    if p_new_final in ('Withdrawn','Cancelled') and p_old_final = 'Pending'
       and p_owner_user_id = auth.uid() then
      return;
    end if;
    if caller <> 'admin' and o_manager is distinct from 'Rejected' then
      raise exception 'Only an owner can give the final approval';
    end if;
    if caller = 'admin' and p_new_final in ('Approved', 'Rejected') then
      o_fin_by := auth.uid();
      o_fin_at := now();
      -- Deciding while the manager stage is still open is a bypass. It is
      -- allowed, because somebody has to be able to unblock a request when a
      -- manager is away — but it is recorded, and it costs a sentence.
      if o_manager = 'Pending' then
        if p_override_reason is null or btrim(p_override_reason) = '' then
          raise exception 'This is still waiting for the store manager. To decide it anyway, give a reason in override_reason.';
        end if;
        o_manager   := 'Overridden';
        o_ovr_by    := auth.uid();
        o_ovr_at    := now();
        o_ovr_stage := 'Store manager';
      end if;
    end if;
  end if;
end $$;

create or replace function public.emp_request_two_step_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare g record;
begin
  if auth.uid() is null then return new; end if;

  select * into g from workflow_guard(
    tg_op, new.employee_id, coalesce(old.user_id, new.user_id),
    case when tg_op = 'UPDATE' then old.manager_status end, new.manager_status,
    case when tg_op = 'UPDATE' then old.status end,         new.status,
    new.override_reason);

  new.manager_status := g.o_manager;
  new.status         := g.o_final;
  if g.o_mgr_by is not null then new.manager_decided_by := g.o_mgr_by; new.manager_decided_at := g.o_mgr_at; end if;
  if g.o_fin_by is not null then new.final_decided_by   := g.o_fin_by; new.final_decided_at   := g.o_fin_at; end if;
  if g.o_ovr_by is not null then
    new.override_by := g.o_ovr_by; new.override_at := g.o_ovr_at; new.override_stage := g.o_ovr_stage;
  end if;
  if tg_op = 'INSERT' and new.user_id is distinct from auth.uid() then
    new.on_behalf_by := auth.uid();
  end if;
  if new.status = 'Withdrawn' and new.withdrawn_at is null then
    new.withdrawn_at := now();
  end if;
  return new;
end $$;

drop trigger if exists trg_emp_request_two_step on public.employee_requests;
create trigger trg_emp_request_two_step
  before insert or update on public.employee_requests
  for each row execute function public.emp_request_two_step_guard();

/* Leave now uses the same brain. The old function set manager_status to
   'Not required' outright whenever an admin or HR was the one filing — the
   bypass the audit found. That branch is gone. */
create or replace function public.leave_two_step_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  g record;
  owner_uid uuid;
begin
  if auth.uid() is null then return new; end if;

  select e.user_id into owner_uid from employees e where e.id = new.employee_id;

  select * into g from workflow_guard(
    tg_op, new.employee_id, owner_uid,
    case when tg_op = 'UPDATE' then old.manager_status end, new.manager_status,
    case when tg_op = 'UPDATE' then old.approval_status end, new.approval_status,
    new.override_reason);

  new.manager_status  := g.o_manager;
  new.approval_status := g.o_final;
  if g.o_mgr_by is not null then new.manager_decided_by := g.o_mgr_by; new.manager_decided_at := g.o_mgr_at; end if;
  if g.o_fin_by is not null then new.final_decided_by   := g.o_fin_by; new.final_decided_at   := g.o_fin_at; end if;
  if g.o_ovr_by is not null then
    new.override_by := g.o_ovr_by; new.override_at := g.o_ovr_at; new.override_stage := g.o_ovr_stage;
  end if;
  if tg_op = 'INSERT' and owner_uid is distinct from auth.uid() then
    new.on_behalf_by := auth.uid();
  end if;
  return new;
end $$;

-- Leave keeps 'Cancelled' as its employee-withdrawal word; the shared guard
-- speaks 'Withdrawn'. Both are permitted so nothing already written breaks.
alter table public.leave_records drop constraint if exists leave_records_approval_status_check;
alter table public.leave_records add constraint leave_records_approval_status_check
  check (approval_status = any (array['Pending','Approved','Rejected','Cancelled','Withdrawn']));

-- ---------------------------------------------------------------------------
-- 5. The permission holes the audit found
-- ---------------------------------------------------------------------------

/* Corrections were visible to every approver in the company: the policy was a
   blanket ALL for admin, manager and hr, with no outlet filter and no
   distinction between reading and destroying. A store manager could delete any
   request from any shop. */
drop policy if exists managers_req on public.employee_requests;

create policy req_read_office on public.employee_requests
  for select using (get_my_role() = any (array['admin','hr']));

create policy req_read_scoped on public.employee_requests
  for select using (
    get_my_role() = 'manager' and req_row_in_my_scope(employee_id, user_id));

create policy req_decide_office on public.employee_requests
  for update using (get_my_role() = any (array['admin','hr']))
  with check (get_my_role() = any (array['admin','hr']));

create policy req_decide_scoped on public.employee_requests
  for update using (
    get_my_role() = 'manager' and req_row_in_my_scope(employee_id, user_id))
  with check (
    get_my_role() = 'manager' and req_row_in_my_scope(employee_id, user_id));

/* An employee could raise a request and then had no way to take it back — the
   mistaken one sat in the inbox until a manager cleared it. They may now edit
   or withdraw their own, but only while it is still Pending, and only into
   Pending or Withdrawn: this is not a route to self-approval. */
create policy own_req_amend on public.employee_requests
  for update using (user_id = auth.uid() and status = 'Pending')
  with check (user_id = auth.uid() and status = any (array['Pending','Withdrawn']));

/* Nobody deletes a request. A withdrawn or rejected one stays, because the
   record of having asked is the point. No DELETE policy is created, and RLS
   denies what it does not permit. */

-- Leave gets the same treatment.
drop policy if exists lv_select on public.leave_records;
drop policy if exists lv_write  on public.leave_records;

create policy lv_read_office on public.leave_records
  for select using (get_my_role() = any (array['admin','hr']));

create policy lv_read_scoped on public.leave_records
  for select using (get_my_role() = 'manager' and request_in_my_scope(employee_id));

create policy lv_insert_office on public.leave_records
  for insert with check (get_my_role() = any (array['admin','hr','manager']));

create policy lv_decide_office on public.leave_records
  for update using (get_my_role() = any (array['admin','hr']))
  with check (get_my_role() = any (array['admin','hr']));

create policy lv_decide_scoped on public.leave_records
  for update using (get_my_role() = 'manager' and request_in_my_scope(employee_id))
  with check (get_my_role() = 'manager' and request_in_my_scope(employee_id));

-- ---------------------------------------------------------------------------
-- 6. An audit row that admits what it does not know
-- ---------------------------------------------------------------------------

/* Two in five audit rows carry no actor, because a trigger, a cron job or a
   service-role call has no auth.uid(). That is not a missing person — it is the
   system acting — but a null in a "who did this" column cannot tell the two
   apart. Labelling it can. */
alter table public.audit_log
  add column if not exists actor_kind text
  generated always as (case when changed_by is null then 'system' else 'user' end) stored;

comment on column public.audit_log.actor_kind is
  'user = a signed-in person, recorded in changed_by. system = a trigger, cron job or service-role write, which has no auth.uid(). Never an unknown person.';

-- ---------------------------------------------------------------------------
-- 7. One shape both apps read
-- ---------------------------------------------------------------------------

/* Who the request is waiting on right now. One function, so "Action Required",
   "Waiting on Manager" and "Completed" mean the same thing in both apps and in
   any reminder job. */
create or replace function public.stage_owner(p_status text, p_manager_status text)
returns text
language sql
immutable
as $$
  select case
    when p_status in ('Approved','Rejected','Withdrawn','Cancelled','Completed') then 'nobody'
    when coalesce(p_manager_status,'Not required') = 'Pending' then 'manager'
    else 'owner'
  end
$$;

comment on function public.stage_owner(text, text) is
  'manager = waiting on the store manager. owner = waiting on the owner''s final word. nobody = settled.';

grant execute on function public.stage_owner(text, text) to authenticated;

/* The rule that matters most: neither app computes a status of its own. Both
   select from this. security_invoker keeps each caller's RLS, so a store
   manager sees their outlets and an owner sees everything, from the same view. */
create or replace view public.v_requests
with (security_invoker = true) as
  select
    'employee_requests'::text                         as source,
    r.id,
    r.request_type                                    as kind,
    r.employee_id,
    e.full_name                                       as employee_name,
    e.location                                        as outlet,
    r.user_id,
    r.details,
    r.created_at                                      as submitted_at,
    r.on_behalf_by,
    r.status,
    coalesce(r.manager_status, 'Not required')        as manager_status,
    r.manager_remarks,
    r.manager_decided_by, r.manager_decided_at,
    r.final_decided_by,   r.final_decided_at,
    r.withdrawn_at,
    r.override_by, r.override_at, r.override_reason, r.override_stage,
    r.attendance_date, r.proposed_clock_in, r.proposed_clock_out,
    r.proposed_from, r.proposed_until, r.proposed_shift_start, r.proposed_shift_end,
    public.stage_owner(r.status, r.manager_status)   as stage_owner
  from public.employee_requests r
  left join public.employees e on e.id = r.employee_id
union all
  select
    'leave_records',
    l.id,
    'Leave',
    l.employee_id,
    e.full_name,
    e.location,
    e.user_id,
    coalesce(l.leave_type,'Leave') || ' · ' || l.leave_start || ' to ' || l.leave_end
      || coalesce(' · ' || l.notes, ''),
    l.created_at,
    l.on_behalf_by,
    l.approval_status,
    coalesce(l.manager_status, 'Not required'),
    null,
    l.manager_decided_by, l.manager_decided_at,
    l.final_decided_by,   l.final_decided_at,
    l.withdrawn_at,
    l.override_by, l.override_at, l.override_reason, l.override_stage,
    null, null, null,
    l.leave_start, l.leave_end, null, null,
    public.stage_owner(l.approval_status, l.manager_status)
  from public.leave_records l
  left join public.employees e on e.id = l.employee_id;

comment on view public.v_requests is
  'Every request of every type in one shape, for both apps. Neither app may compute a stage of its own — read stage_owner from here.';

grant select on public.v_requests to authenticated;

-- ---------------------------------------------------------------------------
-- 8. The requests already in flight
-- ---------------------------------------------------------------------------

/* Rows written before the spine existed have no stage. A settled one is left
   settled — reopening a decided request to route it through a manager would be
   rewriting history. Only the still-Pending ones get a real first stage. */
update public.employee_requests r
   set manager_status = case
         when r.status <> 'Pending' then 'Not required'
         when public.request_needs_manager(r.employee_id) then 'Pending'
         else 'Not required' end
 where r.manager_status is null;

commit;
