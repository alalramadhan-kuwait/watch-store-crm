-- customer_brand_rows: the Lightspeed brand list was inlined into the lookup for every visit row,
-- so the whole purchase join ran again per visit (over a minute). The lists are now built once
-- and each distinct brand typed on a visit is matched once. Same rules and results.
create or replace function public.customer_brand_rows()
returns table(customer_id uuid, brand text, source text, qty numeric, kd numeric, at timestamptz, model text)
language sql stable security invoker set search_path = public, pg_temp as $$
  with bought as materialized (
    select c.id customer_id, trim(i.brand) brand, 'bought'::text source, i.quantity::numeric qty,
           i.price_total::numeric kd, s.sale_date::timestamptz at, i.name model
      from public.customers c
      join public.lightspeed_customers lc on lc.phone_e164 = c.phone_e164
      join public.lightspeed_sales s on s.customer_id = lc.id
                                    and s.status = any(public.lightspeed_sale_counts()) and s.return_for is null
      join public.lightspeed_sale_items i on i.sale_id = s.id and not coalesce(i.is_return, false)
     where nullif(trim(i.brand), '') is not null),
  canon as materialized (
    select b.brand, public.name_skeleton(b.brand) sk, public.tk_name_key(b.brand) k
      from (select distinct brand from bought) b),
  asked as materialized (
    select cs.customer_id, trim(cs.brand) raw, cs.interaction_at at, nullif(trim(cs.product), '') model
      from public.cases cs
     where not cs.deleted and cs.customer_id is not null and cs.case_type in ('Follow-up', 'Lost Sale')
       and nullif(trim(cs.brand), '') is not null and lower(trim(cs.brand)) not in ('other', 'others')),
  raws as materialized (
    select r.raw, public.name_skeleton(r.raw) sk, public.tk_name_key(r.raw) k
      from (select distinct raw from asked) r),
  mapped as materialized (
    select r.raw,
           coalesce((select cb.brand from canon cb
                      where cb.sk = r.sk or (length(r.k) >= 3 and (cb.k like r.k || '%' or r.k like cb.k || '%'))
                      order by (cb.sk = r.sk) desc, length(cb.brand) limit 1), r.raw) brand
      from raws r)
  select customer_id, brand, source, qty, kd, at, model from bought
  union all
  select a.customer_id, m.brand, 'asked', null, null, a.at, a.model
    from asked a join mapped m on m.raw = a.raw
$$;
