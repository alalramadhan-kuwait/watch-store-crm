-- Ask Mohammed as a business advisor: offer maths the model may quote.
-- Both read stock_analyst_metrics only and change nothing. Execute is granted
-- to service_role only, like the other analyst calculations.

create or replace function public.promo_candidates(
  p_brand text default null, p_product_type text default null,
  p_floor numeric default 0.25, p_limit integer default 15, p_as_of date default null)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare d date := coalesce(p_as_of, (now() at time zone 'Asia/Kuwait')::date - 1);
        n int := least(greatest(coalesce(p_limit, 15), 1), 40);
        fl numeric := least(greatest(coalesce(p_floor, 0.25), 0), 0.9);
        res jsonb;
begin
  perform stock_analyst_guard();
  with m as (
    select x.*, (select sku from lightspeed_products lp where lp.product_id = x.product_id) sku
      from stock_analyst_metrics(d, null) x
     where x.on_hand > 0
       and (p_brand is null or lower(x.brand) = lower(p_brand) or x.brand ilike p_brand || '%')
       and (p_product_type is null or lower(x.product_type) = lower(p_product_type))
  ),
  -- gifts come from the whole shop whatever brand is asked about
  gifts as (
    select x.product_id, x.name, x.product_type, x.on_hand, round(x.cost, 2) cost, x.price retail_value, x.class
      from stock_analyst_metrics(d, null) x
     where x.on_hand >= 3 and x.ownership = 'owned' and x.product_type in ('Straps', 'Accessories')
       and x.cost > 0 and x.cost <= 25 and x.price >= 5
  ),
  priced as (
    select m.*, round(m.price - m.cost, 2) profit_per_unit,
           round(m.cost / (1 - fl), 1) lowest_price_at_floor,
           greatest(0, floor((1 - m.cost / (1 - fl) / m.price) * 100))::int max_discount_pct_at_floor
      from m where m.cost > 0 and m.price > 0
  )
  select jsonb_build_object(
    'header', stock_analyst_header(d) || jsonb_build_object(
        'filters', jsonb_strip_nulls(jsonb_build_object('brand', p_brand, 'product_type', p_product_type)),
        'margin_floor', fl),
    'to_clear', (select jsonb_agg(x) from (
        select product_id, name, sku, brand, product_type, on_hand, round(cost, 2) cost, price, margin,
               profit_per_unit, round(stock_cost_value) stock_cost_value, u90 units_90d, u365 units_365d,
               last_sale, shelf_days, class, max_discount_pct_at_floor, lowest_price_at_floor
          from priced where ownership in ('owned', 'pre_owned') and class in ('dead', 'slow')
         order by stock_cost_value desc nulls last limit n) x),
    'best_sellers_keep_full_price', (select jsonb_agg(x) from (
        select product_id, name, sku, brand, on_hand, round(cost, 2) cost, price, margin, profit_per_unit,
               u90 units_90d, cover_months, class
          from priced where ownership = 'owned' and class in ('fast', 'healthy')
         order by u90 desc nulls last limit least(n, 10)) x),
    'gift_options', (select jsonb_agg(x) from (
        select * from gifts order by (class in ('dead', 'slow')) desc, on_hand desc, cost limit 12) x),
    'consignment_needs_supplier', (select jsonb_agg(x) from (
        select product_id, name, sku, brand, supplier, on_hand, price, u90 units_90d, u365 units_365d, class
          from m where ownership = 'consignment' and class in ('dead', 'slow')
         order by stock_retail_value desc nulls last limit least(n, 10)) x),
    'totals', (select jsonb_build_object(
        'owned_slow_dead_products', count(*) filter (where ownership in ('owned', 'pre_owned') and class in ('dead', 'slow')),
        'owned_slow_dead_units', coalesce(sum(on_hand) filter (where ownership in ('owned', 'pre_owned') and class in ('dead', 'slow')), 0),
        'owned_slow_dead_cost_value', round(coalesce(sum(stock_cost_value) filter (where ownership in ('owned', 'pre_owned') and class in ('dead', 'slow')), 0)),
        'products_without_cost', count(*) filter (where coalesce(cost, 0) <= 0 and ownership = 'owned'))
      from m),
    'notes', jsonb_build_array(
        'max_discount_pct_at_floor is the deepest discount that keeps the margin at margin_floor or above.',
        'Consignment stock belongs to the supplier: any offer needs their agreement.',
        'Products with no cost in Lightspeed are left out of the offer lists.')
  ) into res;
  return res;
end $function$;

create or replace function public.offer_plan(
  p_items jsonb, p_floor numeric default 0.25, p_as_of date default null)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare d date := coalesce(p_as_of, (now() at time zone 'Asia/Kuwait')::date - 1);
        fl numeric := least(greatest(coalesce(p_floor, 0.25), 0), 0.9);
        res jsonb;
begin
  perform stock_analyst_guard();
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'items must be a non-empty list';
  end if;
  with req as (
    select e.ord, e.v->>'product_id' product_id,
           nullif(e.v->>'discount_pct', '')::numeric disc_in,
           nullif(e.v->>'offer_price', '')::numeric price_in,
           nullif(e.v->>'gift_product_id', '') gift_id,
           nullif(e.v->>'units', '')::numeric units_in
      from jsonb_array_elements(p_items) with ordinality e(v, ord)
     limit 40
  ),
  m as (select * from stock_analyst_metrics(d, null)),
  j as (
    select r.ord, r.product_id, p.name, p.brand, p.ownership, p.class, p.on_hand, p.u90,
           round(p.cost, 2) cost, p.price,
           g.name gift_name, round(g.cost, 2) gift_cost, g.price gift_value, g.on_hand gift_on_hand, g.ownership gift_ownership,
           r.gift_id, r.units_in,
           round(coalesce(r.price_in,
             p.price * (1 - case when r.disc_in > 1 then r.disc_in / 100 else coalesce(r.disc_in, 0) end)), 1) offer_price
      from req r left join m p on p.product_id = r.product_id
      left join m g on g.product_id = r.gift_id
  ),
  k as (
    select j.*,
           greatest(0, coalesce(j.units_in, j.on_hand, 0))::numeric units,
           round((1 - j.offer_price / nullif(j.price, 0)) * 100, 1) discount_pct,
           round(j.price - j.cost, 2) profit_per_unit_now,
           round(j.offer_price - j.cost - coalesce(j.gift_cost, 0), 2) profit_per_unit_offer
      from j
  ),
  f as (
    select k.*,
           round(k.profit_per_unit_offer / nullif(k.offer_price, 0), 3) margin_offer,
           round((k.price - k.cost) / nullif(k.price, 0), 3) margin_now,
           array_remove(array[
             case when k.name is null then 'product_not_found' end,
             case when k.name is not null and coalesce(k.cost, 0) <= 0 then 'cost_unknown' end,
             case when k.gift_id is not null and k.gift_name is null then 'gift_not_found' end,
             case when k.gift_id is not null and coalesce(k.gift_cost, 0) <= 0 and k.gift_name is not null then 'gift_cost_unknown' end,
             case when k.profit_per_unit_offer < 0 then 'below_cost' end,
             case when k.cost > 0 and k.profit_per_unit_offer >= 0 and k.profit_per_unit_offer / nullif(k.offer_price, 0) < fl then 'below_margin_floor' end,
             case when k.ownership = 'consignment' then 'consignment_needs_supplier_agreement' end,
             case when k.gift_ownership = 'consignment' then 'gift_is_consignment' end,
             case when k.class in ('fast', 'healthy') and k.offer_price < k.price then 'discounting_a_good_seller' end,
             case when k.units > coalesce(k.on_hand, 0) then 'more_units_than_stock' end,
             case when k.gift_id is not null and k.units > coalesce(k.gift_on_hand, 0) then 'not_enough_gifts' end
           ], null) flags
      from k
  )
  select jsonb_build_object(
    'header', stock_analyst_header(d) || jsonb_build_object('margin_floor', fl),
    'items', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'product_id', product_id, 'name', name, 'brand', brand, 'ownership', ownership, 'class', class,
        'on_hand', on_hand, 'units_90d', u90, 'units_planned', units,
        'price', price, 'cost', cost, 'offer_price', offer_price, 'discount_pct', discount_pct,
        'gift', case when gift_id is not null then jsonb_build_object('product_id', gift_id, 'name', gift_name,
                 'cost', gift_cost, 'retail_value', gift_value, 'on_hand', gift_on_hand) end,
        'profit_per_unit_now', profit_per_unit_now, 'profit_per_unit_offer', profit_per_unit_offer,
        'margin_now', margin_now, 'margin_offer', margin_offer,
        'revenue_planned', round(units * offer_price), 'profit_planned', round(units * profit_per_unit_offer),
        'profit_given_up', round(units * (profit_per_unit_now - profit_per_unit_offer)),
        'flags', to_jsonb(flags))) order by ord) from f),
    'totals', (select jsonb_build_object(
        'units', sum(units), 'revenue', round(sum(units * offer_price)),
        'profit', round(sum(units * profit_per_unit_offer)),
        'margin', round(sum(units * profit_per_unit_offer) / nullif(sum(units * offer_price), 0), 3),
        'profit_given_up', round(sum(units * (profit_per_unit_now - profit_per_unit_offer))),
        'stock_cost_cleared', round(sum(units * cost)),
        'gift_units', coalesce(sum(units) filter (where gift_id is not null), 0),
        'gift_cost', round(coalesce(sum(units * gift_cost), 0)),
        'items_flagged', count(*) filter (where cardinality(flags) > 0))
      from f where name is not null and cost > 0),
    'notes', jsonb_build_array(
        'units_planned is the number of pieces the plan assumes will sell: the stock on hand unless set. It is an assumption, not a forecast.',
        'profit_given_up compares with selling the same units at full price.')
  ) into res;
  return res;
end $function$;

revoke all on function public.promo_candidates(text, text, numeric, integer, date) from public, anon, authenticated;
revoke all on function public.offer_plan(jsonb, numeric, date) from public, anon, authenticated;
grant execute on function public.promo_candidates(text, text, numeric, integer, date) to service_role;
grant execute on function public.offer_plan(jsonb, numeric, date) to service_role;
