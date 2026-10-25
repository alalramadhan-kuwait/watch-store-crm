-- Ask Mohammed's campaigns: three groups instead of a clearance list.
-- promo_candidates returns traffic drivers (recognised pieces selling now with
-- stock to meet demand), profitable offers (healthy margin, steady demand) and
-- inventory recovery (slow or dead, those with sales in the last year first),
-- each with its sales and gross-profit evidence, at most three per brand so a
-- campaign is not one brand. Best sellers with too little stock are listed to
-- keep at full price. offer_plan flags a line that gives up more than 500 KD a
-- piece, so a large discount is compared with alternatives before it is advised.
-- Both still read stock_analyst_metrics only and change nothing.

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
    select x.*, (select sku from lightspeed_products lp where lp.product_id = x.product_id) sku,
           sum(x.u90) over (partition by x.brand) brand_units_90d
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
           greatest(0, floor((1 - m.cost / (1 - fl) / m.price) * 100))::int max_discount_pct_at_floor,
           round(m.rev90 - m.u90 * m.cost) gross_profit_90d, round(m.rev365 - m.u365 * m.cost) gross_profit_365d,
           (m.class in ('fast', 'healthy') and m.on_hand >= 3 and m.u90 >= 3
            and m.product_type not in ('Straps', 'Accessories')) is_traffic
      from m where m.cost > 0 and m.price > 0 and m.ownership = 'owned'
  ),
  grouped as (
    select p.*,
           case when is_traffic then 'traffic'
                when class in ('healthy', 'slow') and margin >= 0.35 and u365 >= 2 and on_hand >= 2
                     and product_type not in ('Straps', 'Accessories') then 'profit'
                when class in ('slow', 'dead') and product_type not in ('Straps', 'Accessories') then 'recovery' end grp
      from priced p
  ),
  ranked as (
    select g.*, row_number() over (partition by grp, brand order by
             case grp when 'traffic' then gross_profit_90d when 'profit' then gross_profit_365d else 0 end desc,
             (u365 > 0) desc, brand_units_90d desc, stock_cost_value desc) brand_rank
      from grouped g where grp is not null
  )
  select jsonb_build_object(
    'header', stock_analyst_header(d) || jsonb_build_object(
        'filters', jsonb_strip_nulls(jsonb_build_object('brand', p_brand, 'product_type', p_product_type)),
        'margin_floor', fl),
    'traffic_drivers', (select jsonb_agg(x) from (
        select product_id, name, sku, brand, product_type, on_hand, round(cost, 2) cost, price, margin, profit_per_unit,
               u90 units_90d, u365 units_365d, cover_months, gross_profit_90d, gross_profit_365d, brand_units_90d, class,
               max_discount_pct_at_floor
          from ranked where grp = 'traffic' and brand_rank <= 3
         order by gross_profit_90d desc limit n) x),
    'profitable_offers', (select jsonb_agg(x) from (
        select product_id, name, sku, brand, product_type, on_hand, round(cost, 2) cost, price, margin, profit_per_unit,
               u90 units_90d, u365 units_365d, last_sale, gross_profit_365d, brand_units_90d, class, max_discount_pct_at_floor
          from ranked where grp = 'profit' and brand_rank <= 3
         order by gross_profit_365d desc limit n) x),
    'inventory_recovery', (select jsonb_agg(x) from (
        select product_id, name, sku, brand, product_type, on_hand, round(cost, 2) cost, price, margin, profit_per_unit,
               round(stock_cost_value) stock_cost_value, u90 units_90d, u365 units_365d, last_sale,
               (d - last_sale) days_since_last_sale, shelf_days, brand_units_90d, class,
               max_discount_pct_at_floor, lowest_price_at_floor
          from ranked where grp = 'recovery' and brand_rank <= 3
         order by (u365 > 0) desc, (brand_units_90d > 0) desc, stock_cost_value desc nulls last limit n) x),
    'best_sellers_low_stock_keep_full_price', (select jsonb_agg(x) from (
        select product_id, name, sku, brand, on_hand, price, u90 units_90d, cover_months, class
          from priced where class = 'fast' and not is_traffic and product_type not in ('Straps', 'Accessories')
         order by u90 desc nulls last limit 10) x),
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
        'owned_slow_dead_sold_in_last_year', count(*) filter (where ownership in ('owned', 'pre_owned') and class in ('dead', 'slow') and u365 > 0),
        'products_without_cost', count(*) filter (where coalesce(cost, 0) <= 0 and ownership = 'owned'))
      from m),
    'notes', jsonb_build_array(
        'Three campaign groups: traffic_drivers (recognised pieces selling now, 3+ in stock), profitable_offers (margin 35%+ with sales in the last year), inventory_recovery (slow or dead; those that sold in the last year come first). At most three per brand in each group.',
        'gross_profit_90d and gross_profit_365d are what the piece earned over those periods: demand evidence, not a forecast.',
        'max_discount_pct_at_floor is the deepest discount that keeps the margin at margin_floor or above. The floor is a safety limit, not a target.',
        'A gift is a real incentive only when its retail value fits the watch: a gift of the same brand, or one worth about 3% of the price or more.',
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
    select r.ord, r.product_id, p.name, p.brand, p.ownership, p.class, p.on_hand, p.u90, p.u365, p.last_sale, p.shelf_days, g.brand gift_brand,
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
           round(j.gift_value / nullif(j.price, 0) * 100, 1) gift_value_pct,
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
             case when k.discount_pct > 20 then 'deep_discount_for_the_brand' end,
             case when k.profit_per_unit_now - k.profit_per_unit_offer > 500 then 'large_amount_given_up' end,
             case when k.discount_pct > 0 and k.discount_pct < 7 and k.gift_id is null then 'discount_too_small_to_notice' end,
             case when k.gift_id is not null and k.gift_value_pct < 3 and k.gift_brand is distinct from k.brand then 'gift_too_small_for_the_watch' end,
             case when k.gift_id is not null and k.units > coalesce(k.gift_on_hand, 0) then 'not_enough_gifts' end
           ], null) flags
      from k
  )
  select jsonb_build_object(
    'header', stock_analyst_header(d) || jsonb_build_object('margin_floor', fl),
    'items', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'product_id', product_id, 'name', name, 'brand', brand, 'ownership', ownership, 'class', class,
        'on_hand', on_hand, 'units_90d', u90, 'units_365d', u365, 'last_sale', last_sale, 'days_since_last_sale', d - last_sale,
        'shelf_days', shelf_days, 'units_planned', units,
        'price', price, 'cost', cost, 'offer_price', offer_price, 'discount_pct', discount_pct,
        'gift', case when gift_id is not null then jsonb_build_object('product_id', gift_id, 'name', gift_name,
                 'brand', gift_brand, 'cost', gift_cost, 'retail_value', gift_value, 'on_hand', gift_on_hand,
                 'value_pct_of_price', gift_value_pct, 'same_brand', gift_brand is not distinct from brand) end,
        'profit_per_unit_now', profit_per_unit_now, 'profit_per_unit_offer', profit_per_unit_offer,
        'margin_now', margin_now, 'margin_offer', margin_offer,
        'revenue_planned', round(units * offer_price), 'profit_planned', round(units * profit_per_unit_offer),
        'profit_given_up', round(units * (profit_per_unit_now - profit_per_unit_offer)),
        'given_up_per_unit', round(profit_per_unit_now - profit_per_unit_offer),
        'flags', to_jsonb(flags))) order by ord) from f),
    'totals', (select jsonb_build_object(
        'basis', 'maximum possible: every planned unit sells. Not a forecast.',
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
        'units_planned is the number of pieces the plan assumes will sell: the stock on hand unless set. Totals are the maximum possible, not expected sales.',
        'profit_given_up compares with selling the same units at full price.',
        'A line giving up more than 500 KD a piece should be compared with smaller offers before it is advised.')
  ) into res;
  return res;
end $function$;

revoke all on function public.promo_candidates(text, text, numeric, integer, date) from public, anon, authenticated;
revoke all on function public.offer_plan(jsonb, numeric, date) from public, anon, authenticated;
grant execute on function public.promo_candidates(text, text, numeric, integer, date) to service_role;
grant execute on function public.offer_plan(jsonb, numeric, date) to service_role;
