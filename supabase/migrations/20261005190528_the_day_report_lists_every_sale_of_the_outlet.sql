-- The PDF day report is the OUTLET's report, not the signed-in person's. A salesman can read only the sales credited
-- to him (lightspeed_sales row security), so his PDF could not list the shop's sales. This returns the day's counted
-- sales for the shops he is allowed to report on, with who sold and what, and takings hidden from the shared shop login
-- exactly as store_day_sales already hides them. Digital channels (Online, WhatsApp) stay out for everyone but
-- admin and manager, as in store_day_sales.
create or replace function public.store_day_sale_list(p_outlet text, p_date date)
 returns jsonb
 language sql stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  with me as (select public.get_my_role() as role),
  base as (
    select s.id, s.sale_date, s.receipt_number, s.invoice_number, s.total_price_incl, s.scope_code, s.return_for, o.kind
      from public.lightspeed_sales s
      join public.outlets o on o.code = s.scope_code, me
     where me.role in ('admin', 'manager', 'sales', 'staff')
       and s.sale_day = p_date
       and s.status = any(public.lightspeed_sale_counts())
       and o.sells
       and (o.kind = 'physical' or me.role in ('admin', 'manager'))
       and (me.role <> 'manager' or s.scope_code in (select unnest(public.my_scope_codes())))
       and case when coalesce(p_outlet, '') = '' then o.kind = 'physical'
                else s.scope_code = public.resolve_outlet(p_outlet) end
     order by s.sale_date desc
     limit 300
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id,
      'at', b.sale_date,
      'receipt', coalesce(b.receipt_number, b.invoice_number),
      'kd', case when (select role from me) = 'staff' then null else b.total_price_incl end,
      'scope', b.scope_code,
      'is_return', b.return_for is not null,
      'sold_by', (select e.dsr_staff_name from public.sale_credits sc join public.employees e on e.id = sc.employee_id
                   where sc.sale_id = b.id and e.dsr_staff_name is not null order by e.dsr_staff_name limit 1),
      'items', coalesce((select jsonb_agg(jsonb_build_object(
                    'name', nullif(i.name, ''), 'brand', nullif(i.brand, ''), 'qty', i.quantity,
                    'kd', case when (select role from me) = 'staff' then null else i.price_total end) order by i.sequence)
                  from public.lightspeed_sale_items i where i.sale_id = b.id), '[]'::jsonb)
    ) order by b.sale_date desc), '[]'::jsonb)
  from base b;
$function$;
revoke execute on function public.store_day_sale_list(text, date) from public, anon;
grant execute on function public.store_day_sale_list(text, date) to authenticated, service_role;
