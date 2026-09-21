-- A customer is one page, not a search across tables.
--
-- Stage C4. Both apps used to rebuild "who is this customer" on the phone,
-- from every visit row that happened to carry the same phone string. Since
-- Stage A a customer is a row in customers, a visit points at it, and their
-- Lightspeed purchases are matched by number. These two functions answer the
-- list and the profile from that, and they answer under the caller's own
-- rules: SECURITY INVOKER, so a salesperson's list is their customers, a
-- manager's is the shop's, and what each sees of a customer's purchases is
-- what the ls_sales policy already lets them see.

-- Statuses that mean the sale happened. VOIDED and SAVED are not sales.
create or replace function public.lightspeed_sale_counts()
returns text[] language sql immutable as $$
  select array['CLOSED','ONACCOUNT_CLOSED','LAYBY_CLOSED','PICKED_UP_CLOSED','DISPATCHED_CLOSED','ONACCOUNT','LAYBY']
$$;

create or replace function public.customer_list()
returns table(
  id uuid, name text, contact text, phone_e164 text, is_vip boolean,
  responsible_employee_id uuid, responsible text, mine boolean,
  visits bigint, last_visit timestamptz, open_followups bigint,
  purchases bigint, purchases_kd numeric, last_purchase timestamptz,
  next_occasion date, next_occasion_label text, next_occasion_days integer
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with mine as (select public.my_related_customers() as id),
  v as (
    select customer_id, count(*) as visits, max(interaction_at) as last_visit,
           count(*) filter (where case_type = 'Follow-up' and status = 'Open') as open_followups
      from public.cases
     where customer_id is not null and not deleted
     group by customer_id),
  p as (
    select lc.phone_e164,
           count(*) filter (where s.return_for is null) as purchases,
           sum(s.total_price_incl) as kd,
           max(s.sale_date) filter (where s.return_for is null) as last_purchase
      from public.lightspeed_sales s
      join public.lightspeed_customers lc on lc.id = s.customer_id
     where s.status = any(public.lightspeed_sale_counts())
     group by lc.phone_e164),
  o as (
    select distinct on (customer_id) customer_id, occasion_date, label, days_until
      from public.upcoming_occasions(60)
     order by customer_id, days_until)
  select c.id,
         coalesce(nullif(trim(c.display_name), ''), c.contact),
         c.contact, c.phone_e164, coalesce(c.is_vip, false),
         c.responsible_employee_id, r.staff_name,
         (c.id in (select id from mine)),
         coalesce(v.visits, 0), v.last_visit, coalesce(v.open_followups, 0),
         coalesce(p.purchases, 0), coalesce(p.kd, 0), p.last_purchase,
         o.occasion_date, o.label, o.days_until
    from public.customers c
    left join v on v.customer_id = c.id
    left join p on p.phone_e164 = c.phone_e164
    left join public.roster_employees() r on r.employee_id = c.responsible_employee_id
    left join o on o.customer_id = c.id
$$;

-- Who knows this customer: the salespeople with a relationship, and how it
-- began. The cache table is admin-only, so this is a definer function that
-- first asks whether the caller may see the customer at all.
create or replace function public.customer_known_by(p_customer uuid)
returns table(employee_id uuid, staff_name text, source text, first_at timestamptz, last_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.employee_id, e.dsr_staff_name, r.source, r.first_at, r.last_at
    from public.customer_relationships r
    left join public.employees e on e.id = r.employee_id
   where r.customer_id = p_customer
     and (public.get_my_role() = 'admin'
          or (public.get_my_role() = 'manager' and public.customer_in_my_scope(p_customer))
          or p_customer in (select public.my_related_customers()))
   order by r.last_at desc
$$;

create or replace function public.customer_profile(p_customer uuid)
returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select case when not exists (select 1 from public.customers c where c.id = p_customer) then null else
  jsonb_build_object(
    'customer', (select to_jsonb(c) - 'occasions' - 'staff_responsible' from public.customers c where c.id = p_customer),
    'responsible', (select r.staff_name from public.customers c
                      join public.roster_employees() r on r.employee_id = c.responsible_employee_id
                     where c.id = p_customer),
    'mine', (p_customer in (select public.my_related_customers())),
    'known_by', coalesce((select jsonb_agg(jsonb_build_object('name', k.staff_name, 'source', k.source, 'last_at', k.last_at))
                            from public.customer_known_by(p_customer) k), '[]'::jsonb),
    'visits', coalesce((select jsonb_agg(jsonb_build_object(
                          'id', v.id, 'case_id', v.case_id, 'at', v.interaction_at, 'staff', v.staff, 'outlet', v.outlet,
                          'case_type', v.case_type, 'brand', v.brand, 'product', v.product, 'amount_kd', v.amount_kd,
                          'status', v.status, 'notes', v.notes, 'promised_callback', v.promised_callback,
                          'lost_reason', v.lost_reason, 'follow_up_action', v.follow_up_action)
                          order by v.interaction_at desc)
                          from public.cases_visible v where v.customer_id = p_customer and not v.deleted), '[]'::jsonb),
    'purchases', coalesce((select jsonb_agg(jsonb_build_object(
                          'id', s.id, 'at', s.sale_date, 'outlet', s.outlet, 'total', s.total_price_incl, 'status', s.status,
                          'is_return', s.return_for is not null, 'receipt', s.receipt_number,
                          'salesperson', (select e.staff_name from public.lightspeed_users u
                                            left join public.roster_employees() e on e.employee_id = u.employee_id
                                           where u.lightspeed_user_id = s.user_id),
                          'items', (select jsonb_agg(jsonb_build_object('name', i.name, 'brand', i.brand, 'sku', i.sku,
                                                                        'qty', i.quantity, 'total', i.price_total)
                                                     order by i.sequence)
                                      from public.lightspeed_sale_items i where i.sale_id = s.id))
                          order by s.sale_date desc)
                          from public.lightspeed_sales s
                          join public.lightspeed_customers lc on lc.id = s.customer_id
                          join public.customers c on c.phone_e164 = lc.phone_e164
                         where c.id = p_customer and s.status = any(public.lightspeed_sale_counts())), '[]'::jsonb),
    'handoffs', coalesce((select jsonb_agg(jsonb_build_object('at', h.created_at, 'template', h.template_key, 'lang', h.lang,
                                                              'by', r.staff_name, 'shared', h.via_shared_device)
                                          order by h.created_at desc)
                            from public.whatsapp_handoffs h
                            left join public.roster_employees() r on r.employee_id = h.employee_id
                           where h.customer_id = p_customer), '[]'::jsonb),
    'occasions', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label, 'month', o.month, 'day', o.day, 'year', o.year)
                                           order by o.month, o.day)
                             from public.customer_occasions o where o.customer_id = p_customer), '[]'::jsonb),
    'contact_changes', coalesce((select jsonb_agg(jsonb_build_object('at', x.changed_at, 'from', x.old_contact, 'to', x.new_contact)
                                                 order by x.changed_at desc)
                                   from public.customer_contact_changes x where x.customer_id = p_customer), '[]'::jsonb)
  ) end
$$;

revoke all on function public.customer_list() from public;
revoke all on function public.customer_known_by(uuid) from public;
revoke all on function public.customer_profile(uuid) from public;
grant execute on function public.customer_list() to authenticated;
grant execute on function public.customer_known_by(uuid) to authenticated;
grant execute on function public.customer_profile(uuid) to authenticated;
grant execute on function public.lightspeed_sale_counts() to authenticated, anon;