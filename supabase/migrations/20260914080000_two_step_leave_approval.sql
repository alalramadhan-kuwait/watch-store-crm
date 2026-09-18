-- Two-step leave approval: the store manager first, the owners second.
--
-- Routing is by workplace, as the owners chose: anyone based at a shop goes to
-- the store manager first; head-office staff go straight to the owners. The
-- shops are listed in a table rather than hard-coded so opening a third shop is
-- an INSERT, not a migration.
--
-- approval_status keeps its old meaning — the FINAL answer — because the leave
-- balance, the dashboard, alerts and My Portal all read it. A manager's
-- approval is recorded beside it and consumes no balance on its own.

create table if not exists public.store_locations (
  name text primary key,
  created_at timestamptz not null default now()
);
comment on table public.store_locations is
  'employees.location values that count as a shop. Drives two-step leave approval: staff based here need the store manager''s approval before the owners see it.';

insert into public.store_locations (name) values ('Avenues'), ('Time Gallery')
  on conflict (name) do nothing;

alter table public.store_locations enable row level security;
drop policy if exists store_loc_read on public.store_locations;
create policy store_loc_read on public.store_locations for select to public using (true);
drop policy if exists store_loc_write on public.store_locations;
create policy store_loc_write on public.store_locations for all to public
  using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

alter table public.leave_records
  add column if not exists manager_status text not null default 'Pending',
  add column if not exists manager_decided_by uuid,
  add column if not exists manager_decided_at timestamptz,
  add column if not exists final_decided_by uuid,
  add column if not exists final_decided_at timestamptz;

comment on column public.leave_records.manager_status is
  'Store manager step: Pending | Approved | Rejected | Skipped (owner decided first) | Not required (head office, or the manager''s own leave).';

-- Everything already decided predates the rule; nothing should look like it is
-- waiting on a manager who never saw it.
-- Anything already decided predates the rule, and anything still pending from
-- head office was never the manager's to see.
update public.leave_records l
   set manager_status = 'Not required'
 where l.manager_status = 'Pending'
   and (l.approval_status <> 'Pending'
        or not exists (select 1 from employees e
                        where e.id = l.employee_id
                          and e.location in (select name from store_locations)));

/**
 * Does this employee's leave need the store manager first?
 *
 * A fact about the EMPLOYEE, never about who is signed in: checking auth.uid()
 * here made a salesperson applying for their own leave look like a self-
 * approval, and the request skipped the manager entirely. A manager or owner
 * based at a shop does not need their own approval either.
 */
create or replace function public.leave_needs_manager(p_employee_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from employees e
      left join profiles p on p.id = e.user_id
     where e.id = p_employee_id
       and e.location in (select name from store_locations)
       and coalesce(p.role, '') not in ('manager', 'admin')
  )
$$;

/** Is the caller a store manager — a manager whose own base is a shop? */
create or replace function public.is_store_manager()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select get_my_role() = 'manager'
     and exists (select 1 from employees e
                  where e.user_id = auth.uid()
                    and e.location in (select name from store_locations))
$$;

create or replace function public.leave_two_step_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  caller_role text := get_my_role();
begin
  -- No signed-in user means a server-side caller (service role, SQL, a cron
  -- job). The approval chain is a rule about people, not about the backend.
  if auth.uid() is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- An owner or HR entering leave directly has already decided it.
    if caller_role in ('admin', 'hr') then
      new.manager_status := 'Not required';
    else
      new.manager_status := case when leave_needs_manager(new.employee_id)
                                 then 'Pending' else 'Not required' end;
    end if;
    return new;
  end if;

  -- The manager's step: the store manager, or an owner correcting it.
  if new.manager_status is distinct from old.manager_status then
    -- nobody signs off their own leave, manager included
    if not (caller_role = 'admin'
            or (is_store_manager()
                and leave_needs_manager(new.employee_id)
                and not exists (select 1 from employees e
                                 where e.id = new.employee_id and e.user_id = auth.uid())))
    then
      raise exception 'Only the store manager can give the first approval for this employee';
    end if;
    if new.manager_status in ('Approved', 'Rejected') then
      new.manager_decided_by := auth.uid();
      new.manager_decided_at := now();
    end if;
    -- A rejection at the first step ends it; nothing reaches the owners.
    if new.manager_status = 'Rejected' then
      new.approval_status := 'Rejected';
    end if;
  end if;

  -- The final answer belongs to the owners, with one exception: the person
  -- whose leave it is may still cancel their own request.
  if new.approval_status is distinct from old.approval_status then
    if caller_role <> 'admin'
       and not (new.approval_status = 'Cancelled'
                and old.approval_status = 'Pending'
                and exists (select 1 from employees e
                             where e.id = new.employee_id and e.user_id = auth.uid()))
       and not (new.manager_status = 'Rejected')
    then
      raise exception 'Only an owner can give the final approval';
    end if;
    if caller_role = 'admin' and new.approval_status in ('Approved', 'Rejected') then
      new.final_decided_by := auth.uid();
      new.final_decided_at := now();
      -- decided before the manager got to it — say so rather than leave it Pending
      if new.manager_status = 'Pending' then
        new.manager_status := 'Skipped';
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_leave_two_step on public.leave_records;
create trigger trg_leave_two_step
  before insert or update on public.leave_records
  for each row execute function public.leave_two_step_guard();
