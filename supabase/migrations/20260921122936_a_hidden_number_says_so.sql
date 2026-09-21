-- A hidden number says so.
--
-- On an entry whose number matched no customer record, "is this customer
-- mine?" was neither true nor false but unknown, and unknown carried through:
-- the number was correctly hidden, but contact_masked came back null rather
-- than true. The apps use that flag to decide whether to offer the edit-path
-- reveal, so it has to be a plain yes or no.
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
   cross join lateral (select coalesce(
         me.role = 'admin'
      or (me.role = 'manager' and public.resolve_outlet(c.outlet) = any(me.scopes))
      or (c.customer_id is not null and c.customer_id in (select public.my_related_customers()))
      or (me.employee_id is not null and c.created_by = me.uid and public.kuwait_day_of(c.interaction_at) = me.today),
      false) as ok) v;
grant select on public.cases_visible to authenticated;
