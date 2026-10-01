-- WhatsApp wording, Arabic names, and weekly sales targets (1 Oct 2026).
--
--   1. The five remaining Arabic messages are rewritten the way they would be
--      typed (the birthday one was done in 20261001131605). Old wording is kept
--      in the comments. They no longer assume the customer is a man.
--   2. employees.name_ar: the name an Arabic message is signed with. roster_arabic_names()
--      lets any login read it, like roster_employees().
--   3. Weekly sales targets. One row per person; the week runs Saturday to
--      Friday. team_week_sales() gives each person's credited sales for a
--      range with their target; a salesperson sees only their own row, an
--      owner or manager sees everybody's. set_weekly_target() is the only way
--      to change one. Seeded from the outlet goals: Avenues' 45,000 KD a
--      month is about 10,400 KD a week across its three salespeople (3,500
--      each) and Time Gallery's 9,000 KD is about 2,100 a week (2,000).

-- 1 · messages
update public.message_templates set updated_at = now(), body = $b$السلام عليكم {{first_name}}، معك {{salesperson}} من تايم كيبر {{store}}. حيّاك الله، وشكراً على زيارتك. حبيت أتابع معك بخصوص {{product}} اللي أعجبك. إذا عندك أي سؤال أو تحب أتأكد لك من التوفر، أنا بالخدمة.$b$
 where key = 'interested_followup' and lang = 'ar';   -- was: مرحباً … أحببت أن أتابع معك بخصوص {{product}} الذي أعجبك — يسعدني الإجابة عن أي استفسار …
update public.message_templates set updated_at = now(), body = $b$السلام عليكم {{first_name}}، معك {{salesperson}} من تايم كيبر {{store}}. أتمنى تجربتك مع {{product}} ممتازة. وإذا احتجت أي شيء، تعديل مقاس أو نصائح للعناية بالساعة أو أي استفسار، راسلني في أي وقت.$b$
 where key = 'post_sale_checkin' and lang = 'ar';     -- was: … أتمنى أن تكون سعيداً بـ {{product}} …
update public.message_templates set updated_at = now(), body = $b$ذكرى سعيدة {{first_name}}! 🎉 نتمنى لكم دوام السعادة، وأطيب التهاني من جميع الفريق في تايم كيبر {{store}}.$b$
 where key = 'anniversary' and lang = 'ar';           -- was: … أطيب الأمنيات من {{salesperson}} وفريق تايم كيبر {{store}}.
update public.message_templates set updated_at = now(), body = $b$السلام عليكم {{first_name}}، معك {{salesperson}} من تايم كيبر {{store}}. عندي لك خبر حلو، {{product}} اللي سألت عنها توفّرت عندنا. تحب أحجز لك قطعة؟$b$
 where key = 'back_in_stock' and lang = 'ar';         -- was: … خبر سار … الذي سألت عنه أصبح متوفراً الآن …
update public.message_templates set updated_at = now(), body = $b$السلام عليكم {{first_name}}، معك {{salesperson}} من تايم كيبر {{store}}. حبيت أطمّن عليك، وإذا تحتاج أي شيء أنا بالخدمة.$b$
 where key = 'general_followup' and lang = 'ar';      -- was: … أردت فقط الاطمئنان عليك — أخبرني إذا كان بإمكاني مساعدتك بأي شيء.

-- 2 · Arabic names
alter table public.employees add column if not exists name_ar text;
update public.employees set name_ar = v.n from (values
  ('Ahmad Khalaf', 'أحمد خلف'), ('Ahmad Ysari', 'أحمد الياسري'), ('Eman', 'إيمان'),
  ('Fadi', 'فادي'), ('Hussein Deeb', 'حسين ديب'), ('Raneen', 'رنين')) v(s, n)
 where public.employees.dsr_staff_name = v.s and public.employees.name_ar is null;

create or replace function public.roster_arabic_names()
returns table(staff_name text, name_ar text)
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
  select e.dsr_staff_name, e.name_ar
    from public.employees e
   where e.dsr_staff_name is not null
     and coalesce(e.status, 'active') <> 'inactive'
$function$;
grant execute on function public.roster_arabic_names() to authenticated;

-- 3 · weekly sales targets
create table if not exists public.weekly_sales_targets (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  target_kd numeric not null check (target_kd > 0),
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
alter table public.weekly_sales_targets enable row level security;
create policy weekly_sales_targets_read on public.weekly_sales_targets for select to authenticated
  using (public.get_my_role() in ('admin', 'manager') or employee_id = public.my_employee_id());

insert into public.weekly_sales_targets (employee_id, target_kd)
select e.id, v.t from (values ('Raneen', 3500), ('Ahmad Khalaf', 3500), ('Ahmad Ysari', 3500), ('Fadi', 2000)) v(s, t)
  join public.employees e on e.dsr_staff_name = v.s
on conflict (employee_id) do nothing;

create or replace function public.team_week_sales(p_from date, p_to date)
returns table(employee_id uuid, staff_name text, sales_count integer, sales_kd numeric, target_kd numeric)
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
  select e.id, e.dsr_staff_name, coalesce(c.n, 0)::int, coalesce(c.kd, 0), t.target_kd
    from public.employees e
    left join public.weekly_sales_targets t on t.employee_id = e.id
    left join lateral (
      select count(*) n, sum(s.total_price_incl) kd
        from public.sale_credits sc
        join public.lightspeed_sales s on s.id = sc.sale_id
       where sc.employee_id = e.id
         and s.return_for is null
         and s.status = any(public.lightspeed_sale_counts())
         and s.sale_date >= (p_from::text || ' 00:00+03')::timestamptz
         and s.sale_date <  ((p_to + 1)::text || ' 00:00+03')::timestamptz
    ) c on true
   where e.dsr_staff_name is not null
     and coalesce(e.status, 'active') <> 'inactive'
     and (public.get_my_role() in ('admin', 'manager') or e.id = public.my_employee_id())
$function$;
grant execute on function public.team_week_sales(date, date) to authenticated;

create or replace function public.set_weekly_target(p_employee uuid, p_kd numeric)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if public.get_my_role() not in ('admin', 'manager') then
    raise exception 'Only an owner or manager can set a target';
  end if;
  if p_kd is null or p_kd <= 0 then
    delete from public.weekly_sales_targets where employee_id = p_employee;
  else
    insert into public.weekly_sales_targets (employee_id, target_kd, updated_by, updated_at)
    values (p_employee, p_kd, auth.uid(), now())
    on conflict (employee_id) do update set target_kd = excluded.target_kd, updated_by = auth.uid(), updated_at = now();
  end if;
end $function$;
grant execute on function public.set_weekly_target(uuid, numeric) to authenticated;
