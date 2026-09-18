-- Staging a request does not depend on who is inserting it.
--
-- Both guards opened with `if auth.uid() is null then return new; end if`, which
-- is right for the permission checks — a migration or a backfill has no
-- signed-in person to judge, and should not be refused for it. But it also
-- skipped the INSERT branch, which is not a permission question at all: whether
-- a request needs its store manager depends on the employee's outlet and
-- nothing else.
--
-- So anything inserted without an auth context — an import, an edge function, a
-- backfill — got a null manager_status, and v_requests reads a null as
-- 'Not required'. Silence became a skipped manager: the exact bypass this
-- workflow was built to remove, arriving through a different door. Found by
-- raising a real schedule-change request and seeing it land on the owner's desk
-- instead of Hussein's.
--
-- The stage is now always set on INSERT. Only the UPDATE branch, which is about
-- who may move what, still stands down when there is no caller to judge.

create or replace function public.workflow_guard(
  p_op text, p_employee_id uuid, p_owner_user_id uuid,
  p_old_manager text, p_new_manager text,
  p_old_final text, p_new_final text, p_override_reason text,
  inout o_manager text default null, inout o_final text default null,
  out o_mgr_by uuid, out o_mgr_at timestamptz,
  out o_fin_by uuid, out o_fin_at timestamptz,
  out o_ovr_by uuid, out o_ovr_at timestamptz, out o_ovr_stage text)
language plpgsql stable security definer
set search_path to 'public', 'pg_temp' as $$
declare caller text := get_my_role();
begin
  o_manager := p_new_manager;
  o_final   := p_new_final;

  /* Always. The employee's outlet decides this, not the caller — and a request
     that arrives with no stage is a request nobody is waiting on. */
  if p_op = 'INSERT' then
    o_manager := case when request_needs_manager(p_employee_id)
                      then 'Pending' else 'Not required' end;
    return;
  end if;

  /* From here it is all "who may move what", which needs somebody to judge.
     A migration or a backfill passes through untouched. */
  if auth.uid() is null then return; end if;

  if p_new_manager is distinct from p_old_manager then
    if not (caller = 'admin' or can_give_first_approval(p_employee_id)) then
      raise exception 'Only this employee''s store manager can give the first approval';
    end if;
    if p_new_manager in ('Approved', 'Rejected') then
      o_mgr_by := auth.uid(); o_mgr_at := now();
    end if;
    if p_new_manager = 'Rejected' then o_final := 'Rejected'; end if;
  end if;

  if p_new_final is distinct from p_old_final then
    if p_new_final in ('Withdrawn','Cancelled') and p_old_final = 'Pending'
       and p_owner_user_id = auth.uid() then
      return;
    end if;
    if caller <> 'admin' and o_manager is distinct from 'Rejected' then
      raise exception 'Only an owner can give the final approval';
    end if;
    if caller = 'admin' and p_new_final in ('Approved', 'Rejected') then
      o_fin_by := auth.uid(); o_fin_at := now();
      if o_manager = 'Pending' then
        if p_override_reason is null or btrim(p_override_reason) = '' then
          raise exception 'This is still waiting for the store manager. To decide it anyway, give a reason in override_reason.';
        end if;
        o_manager := 'Overridden';
        o_ovr_by := auth.uid(); o_ovr_at := now(); o_ovr_stage := 'Store manager';
      end if;
    end if;
  end if;
end $$;

create or replace function public.emp_request_two_step_guard()
returns trigger language plpgsql security definer
set search_path to 'public', 'pg_temp' as $$
declare g record;
begin
  select * into g from workflow_guard(
    tg_op, new.employee_id, coalesce(old.user_id, new.user_id),
    case when tg_op = 'UPDATE' then old.manager_status end, new.manager_status,
    case when tg_op = 'UPDATE' then old.status end, new.status,
    new.override_reason);
  new.manager_status := g.o_manager;
  new.status         := g.o_final;
  if g.o_mgr_by is not null then new.manager_decided_by := g.o_mgr_by; new.manager_decided_at := g.o_mgr_at; end if;
  if g.o_fin_by is not null then new.final_decided_by := g.o_fin_by; new.final_decided_at := g.o_fin_at; end if;
  if g.o_ovr_by is not null then
    new.override_by := g.o_ovr_by; new.override_at := g.o_ovr_at; new.override_stage := g.o_ovr_stage;
  end if;
  if tg_op = 'INSERT' and auth.uid() is not null and new.user_id is distinct from auth.uid() then
    new.on_behalf_by := auth.uid();
  end if;
  if new.status = 'Withdrawn' and new.withdrawn_at is null then
    new.withdrawn_at := now();
  end if;
  return new;
end $$;

create or replace function public.leave_two_step_guard()
returns trigger language plpgsql security definer
set search_path to 'public', 'pg_temp' as $$
declare g record; owner_uid uuid;
begin
  select e.user_id into owner_uid from employees e where e.id = new.employee_id;
  select * into g from workflow_guard(
    tg_op, new.employee_id, owner_uid,
    case when tg_op = 'UPDATE' then old.manager_status end, new.manager_status,
    case when tg_op = 'UPDATE' then old.approval_status end, new.approval_status,
    new.override_reason);
  new.manager_status  := g.o_manager;
  new.approval_status := g.o_final;
  if g.o_mgr_by is not null then new.manager_decided_by := g.o_mgr_by; new.manager_decided_at := g.o_mgr_at; end if;
  if g.o_fin_by is not null then new.final_decided_by := g.o_fin_by; new.final_decided_at := g.o_fin_at; end if;
  if g.o_ovr_by is not null then
    new.override_by := g.o_ovr_by; new.override_at := g.o_ovr_at; new.override_stage := g.o_ovr_stage;
  end if;
  if tg_op = 'INSERT' and auth.uid() is not null and owner_uid is distinct from auth.uid() then
    new.on_behalf_by := auth.uid();
  end if;
  return new;
end $$;

update public.employee_requests
   set manager_status = case when public.request_needs_manager(employee_id)
                             then 'Pending' else 'Not required' end
 where status = 'Pending' and manager_status is null;
