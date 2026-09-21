-- The roster knows who each name is.
--
-- Stage C3. The shared shop phone signs nothing as itself: an outlet change or
-- a WhatsApp handoff from it must name the salesperson, and the database wants
-- that as an employee id. The phone only knows roster names — the same list
-- Settings shows in the Served-by dropdown — and the shared login may not read
-- the employees table at all (rightly: it holds pay and documents).
--
-- So this answers exactly one question, for anyone signed in: which employee
-- id goes with which roster name. Nothing else about the person leaves the
-- table.
create or replace function public.roster_employees()
returns table(employee_id uuid, staff_name text)
language sql stable security definer set search_path = public, pg_temp as $$
  select e.id, e.dsr_staff_name
    from public.employees e
   where e.dsr_staff_name is not null
     and coalesce(e.status, 'active') <> 'inactive'
   order by e.dsr_staff_name;
$$;
revoke all on function public.roster_employees() from public;
grant execute on function public.roster_employees() to authenticated;
