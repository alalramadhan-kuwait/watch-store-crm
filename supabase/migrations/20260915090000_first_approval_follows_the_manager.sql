-- The first approval belongs to the employee's own manager, wherever they work.
--
-- Routing asked "is this person based at a shop?". That gave the shops a first
-- approver and left head office without one: HQ leave was stamped
-- 'Not required' the moment it was created and went straight to the owners,
-- even though head office has a manager. Nothing was waiting on her because
-- nothing was ever sent to her.
--
-- It now asks "who approves for this person's workplace?". A manager covers a
-- SET of locations rather than the one they happen to be filed under: the shops
-- manager sits at Time Gallery and also runs Avenues, so routing by the
-- manager's own location would have cut the Avenues staff loose.
--
-- approval_status keeps its meaning — the FINAL answer — because the leave
-- balance, the dashboard, alerts and My Portal all read it.

create table if not exists public.manager_scopes (
  manager_id uuid not null references public.profiles(id) on delete cascade,
  location   text not null,
  created_at timestamptz not null default now(),
  primary key (manager_id, location)
);

comment on table public.manager_scopes is
  'Which workplaces each manager gives the first leave approval for. A manager may cover several (the shops manager runs both shops); a workplace with no row here has no first step and goes straight to the owners.';

alter table public.manager_scopes enable row level security;
-- Readable by everyone signed in: My Portal tells an employee which desk their
-- request is sitting on, and that answer comes from here.
drop policy if exists mgr_scope_read on public.manager_scopes;
create policy mgr_scope_read on public.manager_scopes for select to public using (true);
drop policy if exists mgr_scope_write on public.manager_scopes;
create policy mgr_scope_write on public.manager_scopes for all to public
  using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

-- Seed from what is already true, so no one's routing changes by surprise.
-- Every manager covers their own workplace …
insert into public.manager_scopes (manager_id, location)
select p.id, e.location
  from public.employees e
  join public.profiles p on p.id = e.user_id
 where p.role = 'manager' and e.status = 'Active' and e.location is not null
on conflict do nothing;

-- … and a manager based at a shop covers every shop, which is what the old
-- rule did and what the shops manager's job actually is.
insert into public.manager_scopes (manager_id, location)
select p.id, s.name
  from public.employees e
  join public.profiles p on p.id = e.user_id
 cross join public.store_locations s
 where p.role = 'manager' and e.status = 'Active'
   and e.location in (select name from public.store_locations)
on conflict do nothing;

/**
 * Does this employee's leave need a manager's approval first?
 *
 * A fact about the EMPLOYEE, never about who is signed in: testing auth.uid()
 * here once made a salesperson applying for their own leave look like a
 * self-approval, and the request skipped the manager entirely.
 *
 * Nobody signs off their own leave, so a manager who is the only approver for
 * their own workplace has no first step — their leave goes to the owners.
 * Managers and owners are excluded outright, as before.
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
      join manager_scopes ms on ms.location = e.location
     where e.id = p_employee_id
       and coalesce(p.role, '') not in ('manager', 'admin')
       and ms.manager_id is distinct from e.user_id
  )
$$;

comment on function public.leave_needs_manager(uuid) is
  'True when someone other than the employee approves for the employee''s workplace.';

/** May the caller give the first approval on this employee's leave? */
create or replace function public.can_give_first_approval(p_employee_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select get_my_role() = 'manager'
     and exists (
       select 1
         from employees e
         join manager_scopes ms on ms.location = e.location
        where e.id = p_employee_id
          and ms.manager_id = auth.uid()
          and e.user_id is distinct from auth.uid()   -- never your own
     )
$$;

/** The workplaces the caller approves for — the Inbox asks this to decide
    which requests are theirs. Without it every manager saw every pending
    first approval, which was invisible while there was only one manager. */
create or replace function public.my_approval_locations()
  returns setof text
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select location from manager_scopes where manager_id = auth.uid()
$$;

comment on function public.is_store_manager() is
  'Superseded by can_give_first_approval / my_approval_locations. Kept so an older client already loaded in someone''s browser keeps working.';

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

  -- The first step: the manager who covers this employee, or an owner
  -- correcting it.
  if new.manager_status is distinct from old.manager_status then
    if not (caller_role = 'admin' or can_give_first_approval(new.employee_id)) then
      raise exception 'Only this employee''s manager can give the first approval';
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

-- Requests still waiting on the owners that now have a first approver were
-- stamped 'Not required' under the old rule. Put them in front of the manager
-- rather than leaving them looking like a step that was deliberately waived.
-- Runs with no auth.uid(), so the guard above lets it through.
update public.leave_records l
   set manager_status = 'Pending'
 where l.approval_status = 'Pending'
   and l.manager_status = 'Not required'
   and leave_needs_manager(l.employee_id);
