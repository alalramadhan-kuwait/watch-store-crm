-- Who may see whom.
--
-- Until now every logged-in person could read every entry and every customer
-- record in the company, and change any customer record. The screens hid most
-- of it; the database did not. This puts the rule in the database, where a
-- direct query meets it too.
--
-- The rule, in one line: you see the customers you have dealt with, the
-- floor sees today's store activity, managers see their outlets, admins see
-- everything. "Dealt with" is derived from the records themselves — a visit,
-- a follow-up, a lost opportunity, a manual sale, a Lightspeed sale line
-- credited to you (or the till you were on), a manager assigning you — and is
-- recomputed whenever those records change, so a mistaken entry that is
-- corrected takes its access away with it.
--
-- Additive except where a policy is deliberately replaced; each of those is
-- named below. Aggregate Lightspeed tables and their policies are untouched.

-- ── 1. Identity and scope helpers ─────────────────────────────────────────
-- SECURITY DEFINER so a policy can ask about employees, scopes and caches
-- without those tables' own policies recursing into it.
create or replace function public.kuwait_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Kuwait')::date $$;

create or replace function public.kuwait_day_of(ts timestamptz) returns date
language sql immutable as $$ select (ts at time zone 'Asia/Kuwait')::date $$;

create or replace function public.my_employee_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select e.id from public.employees e where e.user_id = auth.uid() limit 1
$$;

create or replace function public.my_scope_codes() returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct public.resolve_outlet(m.location)) filter (where public.resolve_outlet(m.location) is not null), '{}')
    from public.manager_scopes m where m.manager_id = auth.uid()
$$;

revoke all on function public.my_employee_id() from public, anon;
revoke all on function public.my_scope_codes() from public, anon;
grant execute on function public.my_employee_id(), public.my_scope_codes(), public.kuwait_today(), public.kuwait_day_of(timestamptz) to authenticated, service_role;

-- Eman manages the WhatsApp and Online channels as well as head office.
-- Explicit channel scope, not general access.
insert into public.manager_scopes (manager_id, location)
select p.id, v.location
  from public.profiles p, (values ('WhatsApp'), ('Online')) as v(location)
 where p.id = '43c3d8bf-82b9-48b4-8d65-34e05e19c51f'
on conflict do nothing;

-- ── 2. Customer record additions ──────────────────────────────────────────
alter table public.customers add column if not exists responsible_employee_id uuid references public.employees (id);
alter table public.customers add column if not exists responsible_assigned_by uuid references public.profiles (id);
alter table public.customers add column if not exists responsible_assigned_at timestamptz;
comment on column public.customers.lightspeed_customer_id is
  'Superseded: a customer can have several Lightspeed records (matched by phone). Kept empty; see lightspeed_customers.phone_e164.';

-- The phone number is the customer's identity, so it does not behave like a
-- text field. It is normalised on the way in, refused if it is not a number
-- we can match on, refused if it already belongs to somebody else, and every
-- change is written down.
create table if not exists public.customer_contact_changes (
  id          bigint generated always as identity primary key,
  customer_id uuid not null references public.customers (id) on delete cascade,
  old_contact text,
  new_contact text,
  old_e164    text,
  new_e164    text,
  changed_by  uuid,
  changed_at  timestamptz not null default now(),
  note        text
);
alter table public.customer_contact_changes enable row level security;
create policy "contact_changes_read" on public.customer_contact_changes for select to authenticated
  using (public.get_my_role() = any (array['admin','manager']));
grant select on public.customer_contact_changes to authenticated;

create or replace function public.customers_guard_identity()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare e text; other uuid;
begin
  e := public.normalize_phone(new.contact);
  if e is null then
    raise exception 'Not a phone number we can match on: %', new.contact using errcode = 'check_violation';
  end if;
  -- stored the way a person here writes it; the E.164 form is generated beside it
  new.contact := case when e like '+965%' then substr(e, 5) else e end;

  if tg_op = 'UPDATE' and e is distinct from old.phone_e164 then
    select id into other from public.customers where phone_e164 = e and id <> new.id limit 1;
    if other is not null then
      raise exception 'That number already belongs to another customer (%). Merging customers is a manager action, not a phone edit.', other
        using errcode = 'unique_violation';
    end if;
    insert into public.customer_contact_changes (customer_id, old_contact, new_contact, old_e164, new_e164, changed_by)
    values (new.id, old.contact, new.contact, old.phone_e164, e, auth.uid());
  end if;

  if tg_op = 'UPDATE' and new.responsible_employee_id is distinct from old.responsible_employee_id then
    if public.get_my_role() not in ('admin', 'manager') and auth.uid() is not null then
      raise exception 'Only a manager or admin can assign a responsible salesperson' using errcode = 'insufficient_privilege';
    end if;
    new.responsible_assigned_by := auth.uid();
    new.responsible_assigned_at := case when new.responsible_employee_id is null then null else now() end;
  end if;
  return new;
end $$;
drop trigger if exists customers_guard_identity on public.customers;
create trigger customers_guard_identity before insert or update of contact, responsible_employee_id on public.customers
  for each row execute function public.customers_guard_identity();

-- ── 3. The relationship, derived ──────────────────────────────────────────
-- Cache tables, rebuilt from the sources below. Nothing writes them directly.
create table if not exists public.sale_credits (
  sale_id     text not null references public.lightspeed_sales (id) on delete cascade,
  employee_id uuid not null references public.employees (id),
  via         text not null check (via in ('line', 'till')),
  primary key (sale_id, employee_id)
);
create index if not exists sale_credits_employee_idx on public.sale_credits (employee_id);

create table if not exists public.customer_relationships (
  employee_id uuid not null references public.employees (id),
  customer_id uuid not null references public.customers (id) on delete cascade,
  source      text not null check (source in ('entry', 'lightspeed', 'assignment', 'crm_action')),
  first_at    timestamptz,
  last_at     timestamptz,
  primary key (employee_id, customer_id, source)
);
create index if not exists customer_relationships_customer_idx on public.customer_relationships (customer_id);

create table if not exists public.customer_outlets (
  customer_id uuid not null references public.customers (id) on delete cascade,
  outlet_code text not null references public.outlets (code),
  last_at     timestamptz,
  primary key (customer_id, outlet_code)
);

alter table public.sale_credits           enable row level security;
alter table public.customer_relationships enable row level security;
alter table public.customer_outlets       enable row level security;
create policy "caches_admin_read"   on public.sale_credits           for select to authenticated using (public.get_my_role() = 'admin');
create policy "caches_admin_read_r" on public.customer_relationships for select to authenticated using (public.get_my_role() = 'admin');
create policy "caches_admin_read_o" on public.customer_outlets       for select to authenticated using (public.get_my_role() = 'admin');
grant select on public.sale_credits, public.customer_relationships, public.customer_outlets to authenticated;

-- Which outlet or channel a Lightspeed sale belongs to, for manager scope.
-- The "Time Keeper" register serves both the online shop and the WhatsApp
-- orders; pos_channel_rules tells them apart by who rang it up.
alter table public.lightspeed_sales add column if not exists scope_code text;
create index if not exists lightspeed_sales_scope_idx on public.lightspeed_sales (scope_code);

create or replace function public.lightspeed_sales_scope()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.scope_code := public.resolve_channel(new.outlet,
    (select u.display_name from public.lightspeed_users u where u.lightspeed_user_id = new.user_id));
  return new;
end $$;
drop trigger if exists lightspeed_sales_scope on public.lightspeed_sales;
create trigger lightspeed_sales_scope before insert or update of outlet, user_id on public.lightspeed_sales
  for each row execute function public.lightspeed_sales_scope();
update public.lightspeed_sales s
   set scope_code = public.resolve_channel(s.outlet, (select u.display_name from public.lightspeed_users u where u.lightspeed_user_id = s.user_id))
 where scope_code is null;

-- Who is credited with a sale: the salesperson on each line when one is set,
-- otherwise the till user. A sale with two people on different lines credits
-- both. A line credited to a channel or a former account credits nobody.
create or replace function public.refresh_sale_credits(p_sale_ids text[] default null)
returns void language sql security definer set search_path = public, pg_temp as $$
  delete from public.sale_credits sc where p_sale_ids is null or sc.sale_id = any(p_sale_ids);
  insert into public.sale_credits (sale_id, employee_id, via)
  select distinct s.id,
         coalesce(ul.employee_id, ut.employee_id),
         case when ul.employee_id is not null then 'line' else 'till' end
    from public.lightspeed_sales s
    left join public.lightspeed_sale_items i on i.sale_id = s.id
    left join public.lightspeed_users ul on ul.lightspeed_user_id = i.salesperson_id and ul.kind = 'employee'
    left join public.lightspeed_users ut on ut.lightspeed_user_id = s.user_id and ut.kind = 'employee'
                                          and i.salesperson_id is null
   where (p_sale_ids is null or s.id = any(p_sale_ids))
     and coalesce(ul.employee_id, ut.employee_id) is not null
  on conflict do nothing;
$$;

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
   where cu.responsible_employee_id is not null;

create or replace view public.customer_outlet_sources as
  select c.customer_id, public.resolve_outlet(c.outlet) as outlet_code, c.interaction_at as at
    from public.cases c
   where c.deleted = false and c.customer_id is not null and public.resolve_outlet(c.outlet) is not null
  union all
  select cu.id, s.scope_code, s.sale_date
    from public.lightspeed_sales s
    join public.lightspeed_customers lc on lc.id = s.customer_id
    join public.customers cu on cu.phone_e164 = lc.phone_e164
   where s.scope_code is not null;

revoke all on public.customer_relationship_sources, public.customer_outlet_sources from public, anon, authenticated;

create or replace function public.refresh_customer_caches(p_customers uuid[] default null)
returns void language sql security definer set search_path = public, pg_temp as $$
  delete from public.customer_relationships r where p_customers is null or r.customer_id = any(p_customers);
  insert into public.customer_relationships (employee_id, customer_id, source, first_at, last_at)
  select employee_id, customer_id, source, min(at), max(at)
    from public.customer_relationship_sources
   where p_customers is null or customer_id = any(p_customers)
   group by 1, 2, 3;
  delete from public.customer_outlets o where p_customers is null or o.customer_id = any(p_customers);
  insert into public.customer_outlets (customer_id, outlet_code, last_at)
  select customer_id, outlet_code, max(at)
    from public.customer_outlet_sources
   where p_customers is null or customer_id = any(p_customers)
   group by 1, 2;
$$;
revoke all on function public.refresh_sale_credits(text[]), public.refresh_customer_caches(uuid[]) from public, anon, authenticated;

-- ── 4. Every Lightspeed customer with a number is a CRM customer ──────────
-- One CRM record per phone, however many Lightspeed records share it. The
-- Lightspeed ids are untouched; the match is the number.
create or replace function public.customers_from_lightspeed(p_ls_ids text[] default null)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  insert into public.customers (contact, display_name, email)
  select distinct on (lc.phone_e164)
         case when lc.phone_e164 like '+965%' then substr(lc.phone_e164, 5) else lc.phone_e164 end,
         lc.name, lc.email
    from public.lightspeed_customers lc
   where lc.phone_e164 is not null and lc.ls_deleted_at is null
     and (p_ls_ids is null or lc.id = any(p_ls_ids))
     and not exists (select 1 from public.customers x where x.phone_e164 = lc.phone_e164)
   order by lc.phone_e164, lc.ls_updated_at desc nulls last
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.customers_from_lightspeed(text[]) from public, anon, authenticated;

-- Backfill, then a full rebuild, before any trigger exists to fire per row.
select public.customers_from_lightspeed();
select public.refresh_sale_credits();
select public.refresh_customer_caches();

-- ── 5. Keeping the caches current ─────────────────────────────────────────
create or replace function public.trg_cases_refresh() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare ids uuid[] := '{}';
begin
  if tg_op in ('INSERT', 'UPDATE') and new.customer_id is not null then ids := ids || new.customer_id; end if;
  if tg_op in ('UPDATE', 'DELETE') and old.customer_id is not null then ids := ids || old.customer_id; end if;
  if array_length(ids, 1) > 0 then perform public.refresh_customer_caches(ids); end if;
  return null;
end $$;
drop trigger if exists cases_refresh_relationships on public.cases;
create trigger cases_refresh_relationships after insert or update or delete on public.cases
  for each row execute function public.trg_cases_refresh();

create or replace function public.trg_customers_refresh() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.refresh_customer_caches(array[new.id]);
  return null;
end $$;
drop trigger if exists customers_refresh_relationships on public.customers;
create trigger customers_refresh_relationships after insert or update of contact, responsible_employee_id on public.customers
  for each row execute function public.trg_customers_refresh();

-- Lightspeed rows arrive in pages of up to 500, so these run once per statement.
create or replace function public.trg_ls_sales_refresh() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare sids text[]; cids uuid[];
begin
  select array_agg(distinct id) into sids from n;
  if sids is null then return null; end if;
  perform public.refresh_sale_credits(sids);
  select array_agg(distinct cu.id) into cids
    from n join public.lightspeed_customers lc on lc.id = n.customer_id
    join public.customers cu on cu.phone_e164 = lc.phone_e164;
  if cids is not null then perform public.refresh_customer_caches(cids); end if;
  return null;
end $$;
drop trigger if exists ls_sales_refresh_ins on public.lightspeed_sales;
drop trigger if exists ls_sales_refresh_upd on public.lightspeed_sales;
create trigger ls_sales_refresh_ins after insert on public.lightspeed_sales referencing new table as n
  for each statement execute function public.trg_ls_sales_refresh();
create trigger ls_sales_refresh_upd after update on public.lightspeed_sales referencing new table as n
  for each statement execute function public.trg_ls_sales_refresh();

create or replace function public.trg_ls_items_refresh_ins() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare sids text[]; cids uuid[];
begin
  select array_agg(distinct sale_id) into sids from n;
  if sids is null then return null; end if;
  perform public.refresh_sale_credits(sids);
  select array_agg(distinct cu.id) into cids
    from public.lightspeed_sales s join public.lightspeed_customers lc on lc.id = s.customer_id
    join public.customers cu on cu.phone_e164 = lc.phone_e164
   where s.id = any(sids);
  if cids is not null then perform public.refresh_customer_caches(cids); end if;
  return null;
end $$;
create or replace function public.trg_ls_items_refresh_del() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare sids text[]; cids uuid[];
begin
  select array_agg(distinct sale_id) into sids from o;
  if sids is null then return null; end if;
  perform public.refresh_sale_credits(sids);
  select array_agg(distinct cu.id) into cids
    from public.lightspeed_sales s join public.lightspeed_customers lc on lc.id = s.customer_id
    join public.customers cu on cu.phone_e164 = lc.phone_e164
   where s.id = any(sids);
  if cids is not null then perform public.refresh_customer_caches(cids); end if;
  return null;
end $$;
drop trigger if exists ls_items_refresh_ins on public.lightspeed_sale_items;
drop trigger if exists ls_items_refresh_del on public.lightspeed_sale_items;
create trigger ls_items_refresh_ins after insert on public.lightspeed_sale_items referencing new table as n
  for each statement execute function public.trg_ls_items_refresh_ins();
create trigger ls_items_refresh_del after delete on public.lightspeed_sale_items referencing old table as o
  for each statement execute function public.trg_ls_items_refresh_del();

create or replace function public.trg_ls_customers_refresh() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare ids text[]; cids uuid[];
begin
  select array_agg(distinct id) into ids from n;
  if ids is null then return null; end if;
  perform public.customers_from_lightspeed(ids);
  select array_agg(distinct cu.id) into cids
    from n join public.customers cu on cu.phone_e164 = n.phone_e164;
  if cids is not null then perform public.refresh_customer_caches(cids); end if;
  return null;
end $$;
drop trigger if exists ls_customers_refresh_ins on public.lightspeed_customers;
drop trigger if exists ls_customers_refresh_upd on public.lightspeed_customers;
create trigger ls_customers_refresh_ins after insert on public.lightspeed_customers referencing new table as n
  for each statement execute function public.trg_ls_customers_refresh();
create trigger ls_customers_refresh_upd after update on public.lightspeed_customers referencing new table as n
  for each statement execute function public.trg_ls_customers_refresh();

-- A full rebuild every night, so nothing the triggers missed can persist.
select cron.schedule('customer-caches-rebuild', '30 0 * * *',
  $cron$ select public.refresh_sale_credits(); select public.refresh_customer_caches(); $cron$);

-- ── 6. The questions a policy asks ────────────────────────────────────────
create or replace function public.is_related_to(p_customer uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_customer is not null and exists (
    select 1 from public.customer_relationships r
     where r.customer_id = p_customer and r.employee_id = public.my_employee_id())
$$;
create or replace function public.customer_in_my_scope(p_customer uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_customer is not null and exists (
    select 1 from public.customer_outlets o
     where o.customer_id = p_customer and o.outlet_code = any(public.my_scope_codes()))
$$;
create or replace function public.ls_customer_visible(p_phone_e164 text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.get_my_role() = 'admin'
      or (p_phone_e164 is not null and exists (
            select 1 from public.customers cu
             where cu.phone_e164 = p_phone_e164
               and (public.is_related_to(cu.id)
                    or (public.get_my_role() = 'manager' and public.customer_in_my_scope(cu.id)))))
$$;
-- The phone on an entry: yours to see when the customer is yours, when you
-- manage the outlet, or when you typed it yourself today and might need to
-- fix it. The shared floor login has no employee, so it never sees a number
-- in a list; it reaches one only through the edit path below.
create or replace function public.can_see_case_contact(p_created_by uuid, p_interaction_at timestamptz, p_customer uuid, p_outlet text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.get_my_role() = 'admin'
      or (public.get_my_role() = 'manager' and public.resolve_outlet(p_outlet) = any(public.my_scope_codes()))
      or public.is_related_to(p_customer)
      or (public.my_employee_id() is not null and p_created_by = auth.uid()
          and public.kuwait_day_of(p_interaction_at) = public.kuwait_today())
$$;
grant execute on function public.is_related_to(uuid), public.customer_in_my_scope(uuid), public.ls_customer_visible(text),
  public.can_see_case_contact(uuid, timestamptz, uuid, text) to authenticated, service_role;

-- ── 7. Entries ────────────────────────────────────────────────────────────
-- Replaces "View active cases" (every login saw every entry) and
-- "Manager can update any case" (unscoped).
drop policy if exists "View active cases" on public.cases;
drop policy if exists "Manager can update any case" on public.cases;

create policy "cases_visibility" on public.cases for select to authenticated using (
  deleted = false and (
       public.get_my_role() = 'admin'
    or (public.get_my_role() = 'manager' and public.resolve_outlet(outlet) = any(public.my_scope_codes()))
    or public.is_related_to(customer_id)
    -- the floor's live window: today and yesterday, so Close Day and the
    -- morning after both work. Outlet isolation inside this window is the
    -- app's selected outlet, because the database cannot know which shop a
    -- shared phone is in. See the Stage B notes.
    or (public.get_my_role() in ('sales', 'staff') and public.kuwait_day_of(interaction_at) >= public.kuwait_today() - 1)
    or (created_by = auth.uid() and public.kuwait_day_of(interaction_at) >= public.kuwait_today() - 1)
  )
);
create policy "Manager can update cases in scope" on public.cases for update to authenticated
  using (public.get_my_role() = 'manager' and public.resolve_outlet(outlet) = any(public.my_scope_codes()))
  with check (public.get_my_role() = 'manager' and public.resolve_outlet(outlet) = any(public.my_scope_codes()));

-- What the apps read. Row visibility is the policy above (the view runs as
-- the caller); the phone is blanked unless can_see_case_contact says otherwise.
create or replace view public.cases_visible with (security_invoker = true) as
  select c.id, c.case_id, c.date_logged, c.time_logged, c.staff, c.customer_name,
         case when public.can_see_case_contact(c.created_by, c.interaction_at, c.customer_id, c.outlet) then c.contact else null end as contact,
         (c.contact is not null and not public.can_see_case_contact(c.created_by, c.interaction_at, c.customer_id, c.outlet)) as contact_masked,
         c.case_type, c.product, c.amount_kd, c.lost_reason, c.follow_up_action, c.promised_callback,
         c.last_contact_date, c.channel, c.status, c.day_locked, c.linked_case_id, c.audit_log, c.deleted,
         c.created_by, c.created_at, c.updated_by, c.updated_at, c.brand, c.product_type, c.browsing_tags,
         c.outlet, c.notes, c.visitor_count, c.customer_id, c.contact_declined, c.interaction_at
    from public.cases c;
grant select on public.cases_visible to authenticated;

-- The one way to a masked number: opening an unlocked entry you made today,
-- to correct it. Returns null rather than raising, so a screen can simply
-- show the field empty.
create or replace function public.case_contact_for_edit(p_case uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select c.contact
    from public.cases c
   where c.id = p_case and c.deleted = false
     and (public.can_see_case_contact(c.created_by, c.interaction_at, c.customer_id, c.outlet)
          or (c.created_by = auth.uid() and c.day_locked = false
              and public.kuwait_day_of(c.interaction_at) = public.kuwait_today()))
$$;
grant execute on function public.case_contact_for_edit(uuid) to authenticated;

-- ── 8. Customers ──────────────────────────────────────────────────────────
-- Replaces all_authenticated_read_write (USING true, FOR ALL).
drop policy if exists "all_authenticated_read_write" on public.customers;
create policy "customers_select" on public.customers for select to authenticated using (
     public.get_my_role() = 'admin'
  or (public.get_my_role() = 'manager' and public.customer_in_my_scope(id))
  or public.is_related_to(id)
);
create policy "customers_insert" on public.customers for insert to authenticated
  with check (public.get_my_role() in ('admin', 'manager', 'sales', 'staff'));
create policy "customers_update" on public.customers for update to authenticated
  using (public.get_my_role() = 'admin'
      or (public.get_my_role() = 'manager' and public.customer_in_my_scope(id))
      or public.is_related_to(id))
  with check (public.get_my_role() = 'admin'
      or (public.get_my_role() = 'manager' and public.customer_in_my_scope(id))
      or public.is_related_to(id));
create policy "customers_delete" on public.customers for delete to authenticated
  using (public.get_my_role() = 'admin');

-- ── 9. Lightspeed mirror: no longer readable by every login ───────────────
drop policy if exists "read_authed_sales"       on public.lightspeed_sales;
drop policy if exists "read_authed_sale_items"  on public.lightspeed_sale_items;
drop policy if exists "read_managers_customers" on public.lightspeed_customers;
create policy "ls_sales_select" on public.lightspeed_sales for select to authenticated using (
     public.get_my_role() = 'admin'
  or (public.get_my_role() = 'manager' and scope_code = any(public.my_scope_codes()))
  or exists (select 1 from public.sale_credits sc where sc.sale_id = id and sc.employee_id = public.my_employee_id())
);
create policy "ls_items_select" on public.lightspeed_sale_items for select to authenticated using (
  exists (select 1 from public.lightspeed_sales s where s.id = sale_id)
);
create policy "ls_customers_select" on public.lightspeed_customers for select to authenticated using (
  public.ls_customer_visible(phone_e164)
);
-- sale_credits is consulted by the sales policy through my_employee_id(), which is
-- definer; the direct read stays admin-only.
