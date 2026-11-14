-- One place for each job (14 Nov 2026).
--
-- 1. Leave is decided in the Inbox only. A manager or HR could type a leave in on the Leave page with the
--    status already "Approved": the insert skipped both the store manager's step and the owner's. A leave
--    entered by anyone but an owner now starts Pending whatever status it arrives with, and is decided like
--    any other request. An owner, or a backfill with no login behind it, may still record one as given.
--
-- 2. The staff roster follows the Employees records. settings.staff_roster was a list typed in under
--    Settings, beside employees.dsr_staff_name (the same names, one per person). The list is now rebuilt
--    from the employee records whenever one changes: everybody Active or On leave with a sales-app name,
--    existing names keeping their order and new ones added at the end. The shop app goes on reading
--    settings.staff_roster, so it needs no change.

create or replace function public.leave_two_step_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare g record; owner_uid uuid;
begin
  select e.user_id into owner_uid from employees e where e.id = new.employee_id;
  -- only an owner may record a leave as already decided; everybody else's starts in the queue
  if tg_op = 'INSERT' and auth.uid() is not null and get_my_role() is distinct from 'admin' then
    new.approval_status := 'Pending';
  end if;
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
end $function$;

create or replace function public.staff_roster_from_employees() returns text[]
 language sql stable security definer set search_path to 'public', 'pg_temp'
as $$
  with want as (
    select btrim(dsr_staff_name) as name from employees
     where nullif(btrim(dsr_staff_name), '') is not null and status in ('Active', 'On leave')),
  had as (
    select r.name, r.ord from settings s, unnest(s.staff_roster) with ordinality as r(name, ord))
  select coalesce(array_agg(w.name order by h.ord nulls last, w.name), '{}')
    from want w left join had h on h.name = w.name;
$$;
revoke all on function public.staff_roster_from_employees() from public, anon, authenticated;

create or replace function public.trg_staff_roster_sync() returns trigger
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare fresh text[] := staff_roster_from_employees();
begin
  update settings set staff_roster = fresh where staff_roster is distinct from fresh;
  return null;
end $$;

create trigger employees_staff_roster_sync
  after insert or delete or update of dsr_staff_name, status on public.employees
  for each statement execute function public.trg_staff_roster_sync();

-- bring the list in step once (today it already matches, name for name)
update public.settings set staff_roster = public.staff_roster_from_employees()
 where staff_roster is distinct from public.staff_roster_from_employees();
