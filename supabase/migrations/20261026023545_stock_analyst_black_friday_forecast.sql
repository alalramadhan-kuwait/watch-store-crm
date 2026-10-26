-- Ask Mohammed's Black Friday forecast, as a new function beside offer_plan.
-- offer_plan_forecast(p_items, p_campaign 'black_friday') returns everything
-- offer_plan returns for the same items, plus expected units for the campaign
-- week (Monday before Black Friday to the Monday after, 8 days) at three levels:
-- the product's recent pace (stock_analyst_metrics.pace, the lower of the 90- and
-- 180-day monthly rates) times the shop's watch-unit lift in that week over the
-- 28 days ending 10 days before, in the worst, middle and best past year; capped
-- at stock. Only finished years whose baseline lies inside the sales history are
-- used. Past discounts cannot be seen in Lightspeed (the line price is the price
-- paid), so the forecast does not model how an offer changes demand, and says so.
-- Read-only; service_role only.

create or replace function public.offer_plan_forecast(
  p_items jsonb, p_campaign text default 'black_friday', p_floor numeric default 0.25, p_as_of date default null)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare d date := coalesce(p_as_of, (now() at time zone 'Asia/Kuwait')::date - 1);
        plan jsonb;
        ev jsonb;
        lo numeric; mid numeric; hi numeric;
        first_day date;
        items jsonb;
begin
  perform stock_analyst_guard();
  if coalesce(p_campaign, '') <> 'black_friday' then
    raise exception 'campaign must be black_friday';
  end if;
  plan := offer_plan(p_items, p_floor, p_as_of);

  select min(sale_day) into first_day from lightspeed_sales;
  with yrs as (
    select y, make_date(y, 11, 1) + ((4 - extract(dow from make_date(y, 11, 1))::int + 7) % 7) + 22 bf
      from generate_series(2015, extract(year from d)::int) y
  ),
  usable as (select y, bf from yrs where bf - 38 >= first_day and bf + 3 < d),
  per as (
    select u.y, u.bf,
           sum(i.quantity) filter (where s.sale_day between u.bf - 4 and u.bf + 3) w_units,
           sum(i.quantity) filter (where s.sale_day between u.bf - 38 and u.bf - 11) b_units
      from usable u
      join lightspeed_sales s on s.sale_day between u.bf - 38 and u.bf + 3
      join lightspeed_sale_items i on i.sale_id = s.id
      join lightspeed_products p on p.product_id = i.product_id
     where s.status = any (lightspeed_sale_counts()) and coalesce(i.status, 'CONFIRMED') <> 'VOIDED'
       and p.product_type ilike '%watch%'
     group by 1, 2
  ),
  lifts as (select y, bf, w_units, b_units, round((w_units / 8.0) / nullif(b_units / 28.0, 0), 2) lift from per)
  select min(lift), round(percentile_cont(0.5) within group (order by lift)::numeric, 2), max(lift),
         jsonb_build_object(
           'campaign', 'black_friday', 'window_days', 8,
           'window', 'Monday before Black Friday to the Monday after',
           'years', jsonb_agg(jsonb_build_object('year', y, 'black_friday', bf, 'watch_units_in_window', w_units,
                                                 'watch_units_in_28_day_baseline', b_units, 'lift', lift) order by y),
           'lift_low', min(lift), 'lift_likely', round(percentile_cont(0.5) within group (order by lift)::numeric, 2),
           'lift_high', max(lift),
           'method', 'expected units = recent monthly pace / 30 x 8 days x lift, capped at stock; low, likely and high use the worst, middle and best past year',
           'limits', 'Past discounts are not visible in Lightspeed, so this does not model how this plan''s offers change demand. A product with no sales in the last 90 days has no basis for a forecast and shows 0.')
    into lo, mid, hi, ev
    from lifts where lift is not null;

  with it as (
    select e.ord, e.v,
           least((e.v->>'on_hand')::numeric, round(coalesce(m.pace, 0) / 30 * 8 * lo, 1)) x_lo,
           least((e.v->>'on_hand')::numeric, round(coalesce(m.pace, 0) / 30 * 8 * mid, 1)) x_mid,
           least((e.v->>'on_hand')::numeric, round(coalesce(m.pace, 0) / 30 * 8 * hi, 1)) x_hi,
           (e.v->>'offer_price')::numeric op, (e.v->>'profit_per_unit_offer')::numeric pp,
           e.v ? 'name' and (e.v->>'cost')::numeric > 0 priced
      from jsonb_array_elements(plan->'items') with ordinality e(v, ord)
      left join stock_analyst_metrics(d, null) m on m.product_id = e.v->>'product_id'
  )
  select jsonb_build_object(
    'items', jsonb_agg(case when priced then v || jsonb_build_object('expected', jsonb_build_object(
               'units_low', x_lo, 'units_likely', x_mid, 'units_high', x_hi,
               'revenue_likely', round(x_mid * op), 'profit_likely', round(x_mid * pp))) else v end order by ord),
    'expected', jsonb_build_object(
      'units_low', sum(x_lo) filter (where priced), 'units_likely', sum(x_mid) filter (where priced),
      'units_high', sum(x_hi) filter (where priced),
      'revenue_low', round(sum(x_lo * op) filter (where priced)), 'revenue_likely', round(sum(x_mid * op) filter (where priced)),
      'revenue_high', round(sum(x_hi * op) filter (where priced)),
      'profit_low', round(sum(x_lo * pp) filter (where priced)), 'profit_likely', round(sum(x_mid * pp) filter (where priced)),
      'profit_high', round(sum(x_hi * pp) filter (where priced))))
    into items from it;

  return plan || jsonb_build_object(
    'items', items->'items',
    'totals', (plan->'totals') || jsonb_build_object('expected', items->'expected'),
    'forecast_evidence', ev);
end $function$;

revoke all on function public.offer_plan_forecast(jsonb, text, numeric, date) from public, anon, authenticated;
grant execute on function public.offer_plan_forecast(jsonb, text, numeric, date) to service_role;
