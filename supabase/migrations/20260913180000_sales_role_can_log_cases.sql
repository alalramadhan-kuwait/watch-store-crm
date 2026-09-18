-- The DSR's floor roles are 'staff' (the shared shop login) and 'sales' (a
-- salesperson's personal login). Only 'staff' could insert a case or close a
-- day, so a personal login created with role 'sales' — the obvious choice in
-- Team Access — could open the app, see the day and be refused on save.
-- Other shop tables (pre_orders, waiting_list) already grant both.

drop policy if exists "Staff and admin can insert cases" on public.cases;
create policy "Staff and admin can insert cases"
  on public.cases for insert to public
  with check (get_my_role() = any (array['admin', 'staff', 'sales']));

drop policy if exists "Staff can update own unlocked cases" on public.cases;
create policy "Staff can update own unlocked cases"
  on public.cases for update to public
  using (
    get_my_role() = any (array['staff', 'sales'])
    and deleted = false
    and (
      (created_by = auth.uid() and day_locked = false)
      or (case_type = 'Follow-up' and status = 'Open')
    )
  )
  with check (
    get_my_role() = any (array['staff', 'sales'])
    and deleted = false
    and (
      (created_by = auth.uid() and day_locked = false)
      or case_type = 'Follow-up'
    )
  );

drop policy if exists "Admin and staff can close a day" on public.day_closes;
create policy "Admin and staff can close a day"
  on public.day_closes for insert to public
  with check (get_my_role() = any (array['admin', 'staff', 'sales']));
