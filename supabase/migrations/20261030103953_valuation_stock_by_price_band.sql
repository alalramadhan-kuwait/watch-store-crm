-- Valuation: slow stock is judged per price band. The snapshot now also returns owned stock grouped by
-- price band (by shelf price) and months idle (since the last sale, or since the model was added if it
-- never sold), so the page can apply a separate "slow after" limit per band and a graded write-down.
-- Each stock row lands in exactly one band and one idle month, so nothing can be written down twice.
create or replace function public.val_operational_snapshot() returns json
language plpgsql stable security definer set search_path = public as $$
declare r json;
begin
  if not public.is_owner() then raise exception 'owners only'; end if;
  with done as (
    select * from lightspeed_sales
    where status in ('CLOSED','ONACCOUNT','ONACCOUNT_CLOSED','LAYBY_CLOSED') and ls_deleted_at is null),
  last_sold as (
    select i.product_id, max(s.sale_day) d from lightspeed_sale_items i join done s on s.id = i.sale_id
    where not i.is_return group by 1),
  st as (
    select s.product_id, s.brand, s.stock_on_hand q, coalesce(c.cost,0) cost, s.price, l.d, coalesce(p.ownership,'unknown') own,
           coalesce(p.ls_created_at, p.first_seen_at)::date created
    from lightspeed_stock s left join lightspeed_stock_cost c using (product_id, outlet)
    left join last_sold l using (product_id) left join lightspeed_products p using (product_id)
    where s.stock_on_hand > 0),
  b as (
    select *, case
      when d is null and created > current_date-180 then 'New, not sold yet'
      when d is null then 'Never sold'
      when d > current_date-90 then 'Sold in last 3 months'
      when d > current_date-180 then '3–6 months'
      when d > current_date-365 then '6–12 months'
      else 'Over 12 months' end bucket,
      case when price >= 1000 then 'high' when price >= 500 then 'mid' else 'low' end band,
      greatest(0, floor((current_date - coalesce(d, created)) / 30.44))::int months_idle
    from st where own <> 'consignment'),
  s12 as (select * from done where sale_day > current_date - 365),
  i12 as (select i.brand, i.price_total from lightspeed_sale_items i join s12 on s12.id = i.sale_id)
  select json_build_object(
    'as_of', current_date,
    'aging', (select json_agg(x order by x.ord) from (
       select bucket, min(array_position(array['Sold in last 3 months','New, not sold yet','3–6 months','6–12 months','Over 12 months','Never sold'], bucket)) ord,
              round(sum(q*cost)) cost, round(sum(q*price)) retail, sum(q) units
       from b group by 1) x),
    'idle', (select json_agg(x) from (
       select band, months_idle, d is not null sold_before, round(sum(q*cost)) cost, sum(q) units, count(distinct product_id) models
       from b group by 1,2,3) x),
    'zero_cost_units', (select coalesce(sum(q),0) from b where cost = 0),
    'ownership', (select json_agg(x) from (select own, round(sum(q*cost)) cost, round(sum(q*price)) retail from st group by 1 order by 2 desc) x),
    'stock_brands', (select json_agg(x) from (select brand, round(sum(q*cost)) cost from b group by 1 order by 2 desc limit 10) x),
    'sales_12m', (select round(sum(total_price)) from s12),
    'sales_brands', (select json_agg(x) from (select brand, round(sum(price_total)) rev from i12 group by 1 order by 2 desc limit 10) x),
    'sales_outlets', (select json_agg(x) from (select outlet, round(sum(total_price)) rev from s12 group by 1 order by 2 desc) x),
    'customers', (select json_build_object('buyers', count(*), 'repeat', count(*) filter (where n > 1)) from (select customer_id, count(*) n from s12 where customer_id is not null group by 1) c),
    'monthly_sales', (select json_agg(x order by m) from (select to_char(sale_day,'YYYY-MM') m, round(sum(total_price)) rev from done where sale_day >= date_trunc('month', current_date) - interval '24 months' group by 1) x)
  ) into r;
  return r;
end $$;
-- The new stock assumptions (slow_months_low/mid/high, recovery_slow, recovery_very_slow), the
-- stock_provision question and its entry in the shared form were written directly to val_inputs and
-- val_form, which hold the owners' figures and question wording and are kept out of this public repo.
-- recovery_old and recovery_never were removed there.
