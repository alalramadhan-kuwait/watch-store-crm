-- Gifts are accessories and straps up to 400 KD retail: dearer pieces (desk clocks,
-- safes, multi-watch winders) are products to sell, not gifts.

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
  -- gifts come from the whole shop whatever brand is asked about, in value tiers
  gifts as (
    select x.product_id, x.name, x.brand, x.product_type, x.on_hand, round(x.cost, 2) cost, x.price retail_value, x.class,
           case when x.price < 25 then 'token (under 25 KD)' when x.price < 75 then 'small (25-75 KD)'
                when x.price < 200 then 'good (75-200 KD)' else 'premium (200 KD and up)' end tier,
           row_number() over (partition by case when x.price < 25 then 1 when x.price < 75 then 2 when x.price < 200 then 3 else 4 end
                              order by (x.class in ('dead', 'slow')) desc, x.on_hand desc, x.price desc) rn
      from stock_analyst_metrics(d, null) x
     where x.ownership = 'owned' and x.product_type in ('Straps', 'Accessories')
       and x.cost > 0 and x.price between 5 and 400 and x.on_hand >= case when x.price >= 75 then 1 else 3 end
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
               last_sale, (d - last_sale) days_since_last_sale, shelf_days, class, max_discount_pct_at_floor, lowest_price_at_floor
          from priced where ownership in ('owned', 'pre_owned') and class in ('dead', 'slow')
         order by stock_cost_value desc nulls last limit n) x),
    'best_sellers_keep_full_price', (select jsonb_agg(x) from (
        select product_id, name, sku, brand, on_hand, round(cost, 2) cost, price, margin, profit_per_unit,
               u90 units_90d, cover_months, class
          from priced where ownership = 'owned' and class in ('fast', 'healthy')
         order by u90 desc nulls last limit least(n, 10)) x),
    'gift_options', (select jsonb_agg(x) from (
        select product_id, name, brand, product_type, tier, on_hand, cost, retail_value, class
          from gifts where rn <= 6 or (rn <= 12 and retail_value >= 75)
         order by retail_value desc) x),
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
        'max_discount_pct_at_floor is the deepest discount that keeps the margin at margin_floor or above. The floor is a safety limit, not a target.',
        'A gift is a real incentive only when its retail value fits the watch: a gift of the same brand, or one worth about 3% of the price or more.',
        'Consignment stock belongs to the supplier: any offer needs their agreement.',
        'Products with no cost in Lightspeed are left out of the offer lists.')
  ) into res;
  return res;
end $function$;
