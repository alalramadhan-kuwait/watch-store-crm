-- The company has three owners. Ali Alramadhan was given access in
-- 20261008120016; Ali AlYousifi and Mohammed AlYousifi are owners too and get
-- the same access. Admins who are not owners still do not.
insert into public.stock_ai_access (user_id, granted_by, note)
select u.id, 'Owner request 2026-10-08', 'Owner (' || coalesce(p.full_name, u.email) || ')'
  from auth.users u left join public.profiles p on p.id = u.id
 where u.email in ('ali@time-keeper.com', 'mucv@time-keeper.com')
on conflict (user_id) do nothing;
