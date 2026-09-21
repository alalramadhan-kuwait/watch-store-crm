-- What a follow-up is made of.
--
-- Stage C1: the foundations under the customer screens, none of them visible
-- yet. A message template in both languages that an employee chooses and
-- WhatsApp sends; a record that they did; a record of moving between shops
-- mid-shift; what a customer's occasions are and who should be reminded of
-- them. The screens come in C2–C5; nothing here changes what anyone sees.

-- ── 1. Templates, in both languages ───────────────────────────────────────
-- The master text is one voice for the whole company, so only an admin edits
-- it. Everyone else chooses one and reads it filled in.
create table if not exists public.message_templates (
  key        text not null,
  lang       text not null check (lang in ('en', 'ar')),
  title      text not null,
  body       text not null,
  active     boolean not null default true,
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now(),
  primary key (key, lang)
);
alter table public.message_templates enable row level security;
create policy "templates_read"  on public.message_templates for select to authenticated using (true);
create policy "templates_admin" on public.message_templates for all to authenticated
  using (public.get_my_role() = 'admin') with check (public.get_my_role() = 'admin');
grant select, insert, update, delete on public.message_templates to authenticated;

insert into public.message_templates (key, lang, title, body) values
  ('interested_followup', 'en', 'Interested customer follow-up',
   'Hello {{first_name}}, this is {{salesperson}} from Time Keeper {{store}}. Thank you for visiting us. I wanted to follow up about the {{product}} you were interested in — I''m happy to answer any questions or check availability for you.'),
  ('interested_followup', 'ar', 'متابعة عميل مهتم',
   'مرحباً {{first_name}}، معك {{salesperson}} من تايم كيبر {{store}}. شكراً لزيارتك لنا. أحببت أن أتابع معك بخصوص {{product}} الذي أعجبك — يسعدني الإجابة عن أي استفسار أو التأكد من توفره لك.'),
  ('post_sale_checkin', 'en', 'Post-sale check-in',
   'Hello {{first_name}}, {{salesperson}} from Time Keeper {{store}} here. I hope you''re enjoying your {{product}}. If there''s anything you need — sizing, care tips or anything else — just message me.'),
  ('post_sale_checkin', 'ar', 'اطمئنان بعد الشراء',
   'مرحباً {{first_name}}، معك {{salesperson}} من تايم كيبر {{store}}. أتمنى أن تكون سعيداً بـ {{product}}. إذا احتجت أي شيء — تعديل المقاس أو نصائح العناية أو غير ذلك — راسلني في أي وقت.'),
  ('birthday', 'en', 'Birthday',
   'Happy birthday, {{first_name}}! 🎂 Warm wishes from all of us at Time Keeper {{store}}. Wishing you a wonderful year ahead.'),
  ('birthday', 'ar', 'عيد ميلاد',
   'كل عام وأنت بخير {{first_name}}! 🎂 أطيب التهاني من جميعنا في تايم كيبر {{store}}. نتمنى لك عاماً رائعاً.'),
  ('anniversary', 'en', 'Anniversary',
   'Happy anniversary, {{first_name}}! 🎉 Best wishes from {{salesperson}} and the team at Time Keeper {{store}}.'),
  ('anniversary', 'ar', 'ذكرى سنوية',
   'ذكرى سعيدة {{first_name}}! 🎉 أطيب الأمنيات من {{salesperson}} وفريق تايم كيبر {{store}}.'),
  ('back_in_stock', 'en', 'Product back in stock',
   'Hello {{first_name}}, good news from Time Keeper {{store}} — the {{product}} you asked about is back in stock. Shall I hold one for you?'),
  ('back_in_stock', 'ar', 'المنتج متوفر من جديد',
   'مرحباً {{first_name}}، خبر سار من تايم كيبر {{store}} — {{product}} الذي سألت عنه أصبح متوفراً الآن. هل تود أن أحجز لك قطعة؟'),
  ('general_followup', 'en', 'General follow-up',
   'Hello {{first_name}}, this is {{salesperson}} from Time Keeper {{store}}. Just checking in — let me know if I can help with anything.'),
  ('general_followup', 'ar', 'متابعة عامة',
   'مرحباً {{first_name}}، معك {{salesperson}} من تايم كيبر {{store}}. أردت فقط الاطمئنان عليك — أخبرني إذا كان بإمكاني مساعدتك بأي شيء.')
on conflict (key, lang) do nothing;

-- Fill a template in. A placeholder with no value disappears cleanly, and the
-- punctuation it leaves behind is tidied. Mirrored in src/shared/messageRules.ts.
create or replace function public.render_template(p_body text, p_vars jsonb)
returns text language plpgsql immutable as $$
declare out text := coalesce(p_body, ''); k text; v text;
begin
  for k, v in select * from jsonb_each_text(coalesce(p_vars, '{}'::jsonb)) loop
    out := replace(out, '{{' || k || '}}', coalesce(v, ''));
  end loop;
  out := regexp_replace(out, '\{\{[a-z_]+\}\}', '', 'g');
  out := regexp_replace(out, ' ([,.!?،؟])', '\1', 'g');
  out := regexp_replace(out, '[ ]{2,}', ' ', 'g');
  return btrim(out);
end $$;

create or replace function public.message_for(p_key text, p_lang text, p_vars jsonb)
returns text language sql stable as $$
  select public.render_template(t.body, p_vars)
    from public.message_templates t
   where t.key = p_key and t.lang = p_lang and t.active
$$;

-- ── 2. The WhatsApp handoff, written down ────────────────────────────────
-- Not the conversation: that the employee opened WhatsApp to this customer
-- with this template. Attributed to a person, always — on the shared device
-- the selected salesperson — while created_by keeps which login did it.
create table if not exists public.whatsapp_handoffs (
  id           bigint generated always as identity primary key,
  employee_id  uuid not null references public.employees (id),
  customer_id  uuid not null references public.customers (id),
  template_key text not null,
  lang         text not null check (lang in ('en', 'ar')),
  case_id      uuid references public.cases (id),
  phone_e164   text not null,
  created_by   uuid,
  via_shared_device boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists whatsapp_handoffs_customer_idx on public.whatsapp_handoffs (customer_id);
create index if not exists whatsapp_handoffs_employee_idx on public.whatsapp_handoffs (employee_id, created_at desc);

-- Who a floor action is attributed to. A personal login is itself; the
-- shared login must have selected a real salesperson; an admin may record on
-- anyone's behalf. Never the shared account as the salesperson.
create or replace function public.attributed_employee(p_employee uuid) returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me uuid := public.my_employee_id(); role text := public.get_my_role();
begin
  if role = 'admin' then
    if p_employee is null then raise exception 'Choose the salesperson this is attributed to' using errcode = 'check_violation'; end if;
    return p_employee;
  end if;
  if me is not null then
    if p_employee is not null and p_employee <> me then
      raise exception 'This is attributed to you, not to somebody else' using errcode = 'insufficient_privilege';
    end if;
    return me;
  end if;
  -- the shared device
  if role <> 'staff' then raise exception 'No employee record for this login' using errcode = 'insufficient_privilege'; end if;
  if p_employee is null or not exists (select 1 from public.employees e where e.id = p_employee and e.dsr_staff_name is not null and e.status = 'Active') then
    raise exception 'Select the salesperson first; the shared device is not a person' using errcode = 'check_violation';
  end if;
  return p_employee;
end $$;

create or replace function public.whatsapp_handoffs_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.created_by := coalesce(auth.uid(), new.created_by);
  new.employee_id := public.attributed_employee(new.employee_id);
  new.via_shared_device := public.my_employee_id() is null and public.get_my_role() = 'staff';
  if not exists (select 1 from public.message_templates t where t.key = new.template_key and t.lang = new.lang and t.active) then
    raise exception 'Unknown or inactive template % (%)', new.template_key, new.lang using errcode = 'check_violation';
  end if;
  if new.phone_e164 is null then select phone_e164 into new.phone_e164 from public.customers where id = new.customer_id; end if;
  if new.phone_e164 is null then raise exception 'This customer has no number WhatsApp can open' using errcode = 'check_violation'; end if;
  return new;
end $$;
drop trigger if exists whatsapp_handoffs_guard on public.whatsapp_handoffs;
create trigger whatsapp_handoffs_guard before insert on public.whatsapp_handoffs
  for each row execute function public.whatsapp_handoffs_guard();

alter table public.whatsapp_handoffs enable row level security;
create policy "handoffs_insert" on public.whatsapp_handoffs for insert to authenticated
  with check ((select public.get_my_role()) in ('admin', 'manager', 'sales', 'staff'));
create policy "handoffs_select" on public.whatsapp_handoffs for select to authenticated using (
     (select public.get_my_role()) = 'admin'
  or ((select public.get_my_role()) = 'manager' and customer_id in (select public.my_scope_customers()))
  or employee_id = (select public.my_employee_id())
);
grant select, insert on public.whatsapp_handoffs to authenticated;

-- A handoff is a CRM action, and a CRM action is a relationship source.
create or replace view public.customer_relationship_sources as
  select e.id as employee_id, c.customer_id, 'entry'::text as source, c.interaction_at as at
    from public.cases c
    join public.employees e on e.dsr_staff_name = c.staff
   where c.deleted = false and c.customer_id is not null
  union all
  select sc.employee_id, cu.id, 'lightspeed', s.sale_date
    from public.lightspeed_sales s
    join public.sale_credits sc on sc.sale_id = s.id
    join public.lightspeed_customers lc on lc.id = s.customer_id
    join public.customers cu on cu.phone_e164 = lc.phone_e164
   where s.status !~ 'VOID'
  union all
  select cu.responsible_employee_id, cu.id, 'assignment', cu.responsible_assigned_at
    from public.customers cu
   where cu.responsible_employee_id is not null
  union all
  select h.employee_id, h.customer_id, 'crm_action', h.created_at
    from public.whatsapp_handoffs h;
revoke all on public.customer_relationship_sources from public, anon, authenticated;

create or replace function public.trg_handoffs_refresh() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.refresh_customer_caches(array[new.customer_id]);
  return null;
end $$;
drop trigger if exists handoffs_refresh_relationships on public.whatsapp_handoffs;
create trigger handoffs_refresh_relationships after insert on public.whatsapp_handoffs
  for each row execute function public.trg_handoffs_refresh();

-- ── 3. Moving between shops mid-shift ─────────────────────────────────────
-- Logged, nothing more: attendance and worked hours are untouched in this
-- phase. The open shift, if there is one, is noted so the record can be read
-- against it later.
create table if not exists public.outlet_changes (
  id                   bigint generated always as identity primary key,
  employee_id          uuid not null references public.employees (id),
  from_outlet          text references public.outlets (code),
  to_outlet            text not null references public.outlets (code),
  attendance_record_id uuid references public.attendance_records (id),
  created_by           uuid,
  via_shared_device    boolean not null default false,
  created_at           timestamptz not null default now()
);
create index if not exists outlet_changes_employee_idx on public.outlet_changes (employee_id, created_at desc);

create or replace function public.outlet_changes_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare f text; t text; uid uuid;
begin
  new.created_by := coalesce(auth.uid(), new.created_by);
  new.employee_id := public.attributed_employee(new.employee_id);
  new.via_shared_device := public.my_employee_id() is null and public.get_my_role() = 'staff';
  f := public.resolve_outlet(new.from_outlet);
  t := public.resolve_outlet(new.to_outlet);
  if new.from_outlet is not null and f is null then raise exception 'Unknown outlet: %', new.from_outlet using errcode = 'check_violation'; end if;
  if t is null then raise exception 'Unknown outlet: %', new.to_outlet using errcode = 'check_violation'; end if;
  if f = t then raise exception 'Already at %', t using errcode = 'check_violation'; end if;
  new.from_outlet := f; new.to_outlet := t;
  select e.user_id into uid from public.employees e where e.id = new.employee_id;
  if new.attendance_record_id is null and uid is not null then
    select a.id into new.attendance_record_id from public.attendance_records a
     where a.user_id = uid and a.clock_out is null order by a.clock_in desc limit 1;
  end if;
  return new;
end $$;
drop trigger if exists outlet_changes_guard on public.outlet_changes;
create trigger outlet_changes_guard before insert on public.outlet_changes
  for each row execute function public.outlet_changes_guard();

alter table public.outlet_changes enable row level security;
create policy "outlet_changes_insert" on public.outlet_changes for insert to authenticated
  with check ((select public.get_my_role()) in ('admin', 'manager', 'sales', 'staff'));
create policy "outlet_changes_select" on public.outlet_changes for select to authenticated using (
     (select public.get_my_role()) = 'admin'
  or ((select public.get_my_role()) = 'manager' and (to_outlet in (select unnest(public.my_scope_codes())) or from_outlet in (select unnest(public.my_scope_codes()))))
  or employee_id = (select public.my_employee_id())
);
grant select, insert on public.outlet_changes to authenticated;

-- ── 4. Occasions ──────────────────────────────────────────────────────────
alter table public.customers add column if not exists anniversary date;
comment on column public.customers.occasions is 'Superseded by customer_occasions; kept empty.';

create table if not exists public.customer_occasions (
  id          bigint generated always as identity primary key,
  customer_id uuid not null references public.customers (id) on delete cascade,
  label       text not null,
  month       smallint not null check (month between 1 and 12),
  day         smallint not null check (day between 1 and 31),
  year        smallint,                      -- when known; the reminder repeats yearly regardless
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create index if not exists customer_occasions_customer_idx on public.customer_occasions (customer_id);
alter table public.customer_occasions enable row level security;
-- Follows the customer: whoever may see the customer sees these; whoever may
-- edit the customer edits these.
create policy "occasions_select" on public.customer_occasions for select to authenticated
  using (customer_id in (select id from public.customers));
create policy "occasions_write" on public.customer_occasions for all to authenticated
  using (customer_id in (select id from public.customers)) with check (customer_id in (select id from public.customers));
grant select, insert, update, delete on public.customer_occasions to authenticated;

-- Lightspeed birthdays become CRM birthdays, by phone. Never overwrites one
-- already entered here.
create or replace function public.customers_birthdays_from_lightspeed(p_ls_ids text[] default null)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  update public.customers cu
     set birthday = lc.date_of_birth
    from public.lightspeed_customers lc
   where lc.phone_e164 = cu.phone_e164 and lc.date_of_birth is not null and lc.ls_deleted_at is null
     and cu.birthday is null
     and (p_ls_ids is null or lc.id = any(p_ls_ids));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.customers_birthdays_from_lightspeed(text[]) from public, anon, authenticated;
select public.customers_birthdays_from_lightspeed();

create or replace function public.trg_ls_customers_refresh() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare ids text[]; cids uuid[];
begin
  select array_agg(distinct id) into ids from n;
  if ids is null then return null; end if;
  perform public.customers_from_lightspeed(ids);
  perform public.customers_birthdays_from_lightspeed(ids);
  select array_agg(distinct cu.id) into cids
    from n join public.customers cu on cu.phone_e164 = n.phone_e164;
  if cids is not null then perform public.refresh_customer_caches(cids); end if;
  return null;
end $$;

-- The next time a month/day comes round, from today. 29 February falls on
-- the 28th in a year without one.
create or replace function public.next_occurrence(p_month int, p_day int, p_from date default public.kuwait_today())
returns date language plpgsql immutable as $$
declare d date; y int := extract(year from p_from)::int;
begin
  begin d := make_date(y, p_month, p_day); exception when others then d := make_date(y, p_month, 28); end;
  if d < p_from then
    begin d := make_date(y + 1, p_month, p_day); exception when others then d := make_date(y + 1, p_month, 28); end;
  end if;
  return d;
end $$;

-- Every occasion, for the customers the caller may see, due within p_days.
create or replace function public.upcoming_occasions(p_days int default 7)
returns table (customer_id uuid, kind text, label text, occasion_date date, days_until int, occasion_year int)
language sql stable security invoker set search_path = public, pg_temp as $$
  with o (customer_id, kind, label, m, d, y) as (
    select c.id, 'birthday', 'Birthday', extract(month from c.birthday)::int, extract(day from c.birthday)::int, extract(year from c.birthday)::int
      from public.customers c where c.birthday is not null
    union all
    select c.id, 'anniversary', 'Anniversary', extract(month from c.anniversary)::int, extract(day from c.anniversary)::int, extract(year from c.anniversary)::int
      from public.customers c where c.anniversary is not null
    union all
    select x.customer_id, 'custom', x.label, x.month::int, x.day::int, x.year::int
      from public.customer_occasions x
  )
  select o.customer_id, o.kind, o.label, nx.next, (nx.next - public.kuwait_today())::int, o.y
    from o
   cross join lateral (select public.next_occurrence(o.m, o.d) as next) nx
   where nx.next - public.kuwait_today() between 0 and p_days
   order by nx.next, o.label
$$;
grant execute on function public.upcoming_occasions(int), public.next_occurrence(int, int, date) to authenticated;

-- ── 5. Who is reminded ────────────────────────────────────────────────────
-- One person, so two people do not contact the same customer: the
-- responsible salesperson; failing that, the most recent salesperson with a
-- live relationship; failing that, the managers of the customer's outlets,
-- as unassigned. A salesperson counts only while active with a login.
create or replace function public.occasion_recipients(p_customer uuid)
returns table (employee_id uuid, manager_user_id uuid, via text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare e uuid;
begin
  select cu.responsible_employee_id into e
    from public.customers cu join public.employees emp on emp.id = cu.responsible_employee_id
   where cu.id = p_customer and emp.status = 'Active' and emp.user_id is not null;
  if e is not null then return query select e, null::uuid, 'responsible'::text; return; end if;

  select r.employee_id into e
    from public.customer_relationships r join public.employees emp on emp.id = r.employee_id
   where r.customer_id = p_customer and emp.status = 'Active' and emp.user_id is not null
   order by r.last_at desc nulls last limit 1;
  if e is not null then return query select e, null::uuid, 'recent'::text; return; end if;

  return query
    select null::uuid, m.manager_id, 'manager_unassigned'::text
      from public.manager_scopes m
     where public.resolve_outlet(m.location) in (select o.outlet_code from public.customer_outlets o where o.customer_id = p_customer)
     group by m.manager_id;
  if not found then return query select null::uuid, null::uuid, 'unrouted'::text; end if;
end $$;

-- What a morning job would send: each occasion at a lead time, with its
-- recipient. Managers and admins only; the job itself runs as service role.
create or replace function public.occasion_reminders_due(p_lead_days int[] default array[7, 0])
returns table (customer_id uuid, kind text, label text, occasion_date date, days_until int,
               employee_id uuid, manager_user_id uuid, via text)
language sql stable security definer set search_path = public, pg_temp as $$
  select u.customer_id, u.kind, u.label, u.occasion_date, u.days_until, r.employee_id, r.manager_user_id, r.via
    from public.upcoming_occasions((select max(x) from unnest(p_lead_days) x)) u
   cross join lateral public.occasion_recipients(u.customer_id) r
   where u.days_until = any(p_lead_days)
     and (public.get_my_role() in ('admin', 'manager') or auth.uid() is null)
$$;
revoke all on function public.occasion_recipients(uuid), public.occasion_reminders_due(int[]) from public, anon;
grant execute on function public.occasion_recipients(uuid), public.occasion_reminders_due(int[]) to authenticated, service_role;

-- The event type exists; nothing raises it until C5.
insert into public.notification_settings (event_type, label, category, enabled, person_target, audience_roles, sort, shop_floor, outlet_scoped)
values ('occasion_due', 'Customer occasion coming up', 'CRM', true, true, array['manager'], 60, true, true)
on conflict (event_type) do nothing;
