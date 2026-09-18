-- The store manager runs the shops AND sells in them: Hussain Dib has 476
-- cases logged as "Hussein Deeb", the most recent two days before he was given
-- a login. Role 'manager' could not insert a case or close a day, so his first
-- sale under his own account would have been refused — the same trap the
-- 'sales' role hit the day before.
drop policy if exists "Staff and admin can insert cases" on public.cases;
create policy "Staff and admin can insert cases"
  on public.cases for insert to public
  with check (get_my_role() = any (array['admin', 'staff', 'sales', 'manager']));

drop policy if exists "Admin and staff can close a day" on public.day_closes;
create policy "Admin and staff can close a day"
  on public.day_closes for insert to public
  with check (get_my_role() = any (array['admin', 'staff', 'sales', 'manager']));
