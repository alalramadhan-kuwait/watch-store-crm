-- The same rules, decided once per query instead of once per row.
--
-- The first cut asked "is this customer mine?" and "what are my outlets?" for
-- every row a query touched. On a screen of sixteen entries that is nothing;
-- on a salesperson's view of eighteen thousand Lightspeed sales it is eighteen
-- thousand lookups, and the validation run itself timed out on it. Worse, the
-- sales policy looked at sale_credits directly, and that table's own policy
-- (admin only) answered the salesperson with nothing: they saw none of their
-- own sales. The rules are unchanged. Each one now fetches its set — my
-- customers, my credited sales, my scope — once, through a definer function
-- that the caches' policies cannot interfere with, and the row check is a
-- membership test the planner can hash.

-- ── the sets, each computed once ──────────────────────────────────────────
create or replace function public.my_related_customers() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select r.customer_id from public.customer_relationships r where r.employee_id = public.my_employee_id()
$$;
create or replace function public.my_scope_customers() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select o.customer_id from public.customer_outlets o where o.outlet_code = any(public.my_scope_codes())
$$;
create or replace function public.my_credited_sales() returns setof text
language sql stable security definer set search_path = public, pg_temp as $$
  select sc.sale_id from public.sale_credits sc where sc.employee_id = public.my_employee_id()
$$;
grant execute on function public.my_related_customers(), public.my_scope_customers(), public.my_credited_sales() to authenticated, service_role;

-- ── entries ───────────────────────────────────────────────────────────────
drop policy if exists "cases_visibility" on public.cases;
create policy "cases_visibility" on public.cases for select to authenticated using (
  deleted = false and (
       (select public.get_my_role()) = 'admin'
    or ((select public.get_my_role()) = 'manager' and public.resolve_outlet(outlet) in (select unnest(public.my_scope_codes())))
    or customer_id in (select public.my_related_customers())
    or ((select public.get_my_role()) in ('sales', 'staff') and public.kuwait_day_of(interaction_at) >= (select public.kuwait_today()) - 1)
    or (created_by = (select auth.uid()) and public.kuwait_day_of(interaction_at) >= (select public.kuwait_today()) - 1)
  )
);
drop policy if exists "Manager can update cases in scope" on public.cases;
create policy "Manager can update cases in scope" on public.cases for update to authenticated
  using ((select public.get_my_role()) = 'manager' and public.resolve_outlet(outlet) in (select unnest(public.my_scope_codes())))
  with check ((select public.get_my_role()) = 'manager' and public.resolve_outlet(outlet) in (select unnest(public.my_scope_codes())));

create or replace view public.cases_visible with (security_invoker = true) as
  with me as (
    select (select public.get_my_role()) as role,
           (select public.my_scope_codes()) as scopes,
           (select public.my_employee_id()) as employee_id,
           (select auth.uid()) as uid,
           (select public.kuwait_today()) as today
  )
  select c.id, c.case_id, c.date_logged, c.time_logged, c.staff, c.customer_name,
         case when v.ok then c.contact else null end as contact,
         (c.contact is not null and not v.ok) as contact_masked,
         c.case_type, c.product, c.amount_kd, c.lost_reason, c.follow_up_action, c.promised_callback,
         c.last_contact_date, c.channel, c.status, c.day_locked, c.linked_case_id, c.audit_log, c.deleted,
         c.created_by, c.created_at, c.updated_by, c.updated_at, c.brand, c.product_type, c.browsing_tags,
         c.outlet, c.notes, c.visitor_count, c.customer_id, c.contact_declined, c.interaction_at
    from public.cases c
   cross join me
   cross join lateral (select
         me.role = 'admin'
      or (me.role = 'manager' and public.resolve_outlet(c.outlet) = any(me.scopes))
      or c.customer_id in (select public.my_related_customers())
      or (me.employee_id is not null and c.created_by = me.uid and public.kuwait_day_of(c.interaction_at) = me.today)
     as ok) v;
grant select on public.cases_visible to authenticated;

-- ── customers ─────────────────────────────────────────────────────────────
drop policy if exists "customers_select" on public.customers;
drop policy if exists "customers_update" on public.customers;
drop policy if exists "customers_delete" on public.customers;
drop policy if exists "customers_insert" on public.customers;
create policy "customers_select" on public.customers for select to authenticated using (
     (select public.get_my_role()) = 'admin'
  or ((select public.get_my_role()) = 'manager' and id in (select public.my_scope_customers()))
  or id in (select public.my_related_customers())
);
create policy "customers_insert" on public.customers for insert to authenticated
  with check ((select public.get_my_role()) in ('admin', 'manager', 'sales', 'staff'));
create policy "customers_update" on public.customers for update to authenticated
  using ((select public.get_my_role()) = 'admin'
      or ((select public.get_my_role()) = 'manager' and id in (select public.my_scope_customers()))
      or id in (select public.my_related_customers()))
  with check ((select public.get_my_role()) = 'admin'
      or ((select public.get_my_role()) = 'manager' and id in (select public.my_scope_customers()))
      or id in (select public.my_related_customers()));
create policy "customers_delete" on public.customers for delete to authenticated
  using ((select public.get_my_role()) = 'admin');

-- ── the Lightspeed mirror ─────────────────────────────────────────────────
drop policy if exists "ls_sales_select"     on public.lightspeed_sales;
drop policy if exists "ls_items_select"     on public.lightspeed_sale_items;
drop policy if exists "ls_customers_select" on public.lightspeed_customers;
create policy "ls_sales_select" on public.lightspeed_sales for select to authenticated using (
     (select public.get_my_role()) = 'admin'
  or ((select public.get_my_role()) = 'manager' and scope_code in (select unnest(public.my_scope_codes())))
  or id in (select public.my_credited_sales())
);
create policy "ls_items_select" on public.lightspeed_sale_items for select to authenticated using (
  sale_id in (select s.id from public.lightspeed_sales s)
);
-- A Lightspeed record is visible exactly when the CRM customer with that
-- number is: the customers policy decides, and this simply follows it.
create policy "ls_customers_select" on public.lightspeed_customers for select to authenticated using (
     (select public.get_my_role()) = 'admin'
  or phone_e164 in (select cu.phone_e164 from public.customers cu)
);

-- ── the edit-path reveal, same rule, set-based ────────────────────────────
create or replace function public.case_contact_for_edit(p_case uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select c.contact
    from public.cases c
   where c.id = p_case and c.deleted = false
     and (   public.get_my_role() = 'admin'
          or (public.get_my_role() = 'manager' and public.resolve_outlet(c.outlet) = any(public.my_scope_codes()))
          or c.customer_id in (select public.my_related_customers())
          or (c.created_by = auth.uid() and public.kuwait_day_of(c.interaction_at) = public.kuwait_today()
              and (public.my_employee_id() is not null or c.day_locked = false)))
$$;

-- The per-row helpers stay for callers that already use them (single rows);
-- no policy depends on them any more.
comment on function public.is_related_to(uuid) is 'Single-row check. Policies use my_related_customers() instead.';
comment on function public.customer_in_my_scope(uuid) is 'Single-row check. Policies use my_scope_customers() instead.';
comment on function public.ls_customer_visible(text) is 'Single-row check. The lightspeed_customers policy follows the customers policy instead.';
