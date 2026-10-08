-- Stock analyst, phase 2: the calculations the owners' Ask chat will call.
--
-- Fixed, tested functions only; the chat never writes SQL. Every result says
-- which period it covers, when the stock and sales behind it were last brought
-- in from Lightspeed, and what is estimated rather than counted.
--
--   stock_analyst_facts / _metrics   one row per product: stock, cost, sales
--                                    over 30/90/180/365 days, pace, cover,
--                                    sell-through, margin, class and why
--   stock_summary                    capital and health by ownership, type,
--                                    outlet and class, with data issues
--   sales_ranking                    best and worst sellers
--   brand_performance                brand months against the months before
--                                    or a year earlier
--   explain_change                   why sales moved: each signal present,
--                                    absent or cannot tell, with its numbers
--   stock_recommendations            one action per product with every rule
--     reorder_advice / budget_plan   it passed or failed; owned stock may be
--                                    bought, consignment never is
--   find_products / explain_product  look-up and one-product drill-down
--   stock_analyst_backtest           the rules re-run on a past day using only
--                                    what was known then, scored on what sold
--
-- Ownership comes from the Lightspeed product type (stock_ownership, phase 1).
-- Lines that do not track inventory in Lightspeed (delivery, protection plans,
-- discounts) are left out. Parked (SAVED) sales are not counted, as everywhere
-- else in the app.
--
-- All functions are security definer and run stock_analyst_guard(): only the
-- service role (the chat backend) or an owner in stock_ai_access may call them.
-- Execute is granted to service_role only.
--
-- Additive: new functions only. No table, column or existing function changes.
--
-- How it was applied: the functions were created and tested on live data first,
-- then this migration was recorded. The body of every function in the database
-- was checked against this file by checksum (comments and spacing aside) before
-- recording, and the grants at the end were the last change applied. Running
-- this file on its own rebuilds the same state.

-- Lightspeed's stock locations and the sales channels each one serves, by the
-- outlet codes the rest of the system uses. The HQ stock ("Time Keeper") is
-- what online and WhatsApp orders ship from.
create or replace function public.stock_outlet_name(p_outlet text) returns text
language sql immutable as $$
  select case lower(trim(coalesce(p_outlet, '')))
    when '' then null
    when 'avenues' then 'Time Keeper - Avenues'
    when 'time_gallery' then 'Time Gallery'
    when 'timegallery' then 'Time Gallery'
    when 'hq' then 'Time Keeper'
    when 'online' then 'Time Keeper'
    when 'whatsapp' then 'Time Keeper'
    else p_outlet end
$$;

create or replace function public.stock_outlet_scopes(p_outlet text) returns text[]
language sql immutable as $$
  select case stock_outlet_name(p_outlet)
    when 'Time Keeper - Avenues' then array['avenues']
    when 'Time Gallery' then array['time_gallery']
    when 'Time Keeper' then array['online', 'whatsapp']
  end
$$;

-- One row per product: everything the stock analyst knows about it on p_as_of,
-- using only what was known by the end of that day.
--
--   * Sales are net of returns (a return is its own sale with negative
--     quantities), counted sales only, services and discount lines left out.
--   * Stock is Lightspeed's actual figure when p_as_of is the day before the
--     morning stock sync (the default). For an earlier day it is rebuilt from
--     today's stock: plus what sold since, minus what purchase orders received
--     since. Transfers and adjustments are not in our data, so a rebuilt figure
--     is labelled 'reconstructed' and never presented as actual stock.
--   * Cost and price are today's: past costs are not stored.
--   * With p_outlet, stock is that location's and sales are that outlet's: the
--     shops by their own till, the HQ stock by online and WhatsApp sales, which
--     ship from it. Purchase orders count where they were received (mostly HQ).
--   * Stock age is from the order date of the last purchase order that
--     received the product (the receipt date is not stored), or, for stock that
--     never came on a purchase order (pre-owned pieces), the day the product was
--     created in Lightspeed: an estimate either way.
-- Every stock-analyst calculation starts here: the backend (service role), a
-- listed owner, or a direct database session (cron, migrations). Anyone else
-- is refused before any figure is read.
create or replace function public.stock_analyst_guard() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') = 'service_role' or stock_ai_allowed() or session_user = 'postgres' then
    return;
  end if;
  raise exception 'The stock analyst is limited to the owners.' using errcode = '42501';
end $$;

create or replace function public.stock_analyst_facts(p_as_of date default null, p_outlet text default null)
returns table (
  product_id text, name text, brand text, supplier text, product_type text, ownership text,
  stock_basis text, on_hand numeric, negative_units numeric, by_outlet jsonb,
  cost numeric, price numeric, stock_cost_value numeric, stock_retail_value numeric,
  on_order numeric,
  u30 numeric, u90 numeric, u180 numeric, u365 numeric,
  rev90 numeric, rev180 numeric, rev365 numeric,
  list_value90 numeric,
  first_sale date, last_sale date, last_receipt_order date,
  best_month_share numeric, product_created date
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform stock_analyst_guard();
  return query
with
asof as (
  select coalesce(p_as_of, (now() at time zone 'Asia/Kuwait')::date - 1) d,
         (select max(synced_at) from lightspeed_stock) stock_synced,
         stock_outlet_name(p_outlet) stock_outlet,
         stock_outlet_scopes(p_outlet) scopes
),
live as (   -- is p_as_of the day this morning's stock describes?
  select (a.d >= ((a.stock_synced at time zone 'Asia/Kuwait')::date - 1)) is_live from asof a
),
lines as (
  select i.product_id, s.sale_day, s.scope_code, i.quantity q, i.price_total kd,
         coalesce(i.price, 0) * i.quantity list_kd
    from lightspeed_sale_items i
    join lightspeed_sales s on s.id = i.sale_id
    cross join asof a
   where s.status = any (lightspeed_sale_counts())
     and coalesce(i.status, 'CONFIRMED') <> 'VOIDED'
     and i.product_id is not null
     and s.sale_day <= a.d
     and (a.scopes is null or s.scope_code = any (a.scopes))
),
sold as (
  select l.product_id,
         sum(q) filter (where sale_day > a.d - 30)  u30,
         sum(q) filter (where sale_day > a.d - 90)  u90,
         sum(q) filter (where sale_day > a.d - 180) u180,
         sum(q) filter (where sale_day > a.d - 365) u365,
         sum(kd) filter (where sale_day > a.d - 90)  rev90,
         sum(kd) filter (where sale_day > a.d - 180) rev180,
         sum(kd) filter (where sale_day > a.d - 365) rev365,
         sum(list_kd) filter (where sale_day > a.d - 90 and q > 0) list_value90,
         min(sale_day) filter (where q > 0) first_sale,
         max(sale_day) filter (where q > 0) last_sale
    from lines l, asof a group by l.product_id
),
months as (
  select l.product_id, date_trunc('month', sale_day) m, sum(q) q
    from lines l, asof a where sale_day > a.d - 365 group by 1, 2
),
spike as (select product_id, max(q) best from months group by 1),
-- sold after p_as_of, to rebuild past stock
sold_after as (
  select i.product_id, sum(i.quantity) q
    from lightspeed_sale_items i join lightspeed_sales s on s.id = i.sale_id cross join asof a
   where s.status = any (lightspeed_sale_counts()) and coalesce(i.status, 'CONFIRMED') <> 'VOIDED'
     and s.sale_day > a.d and not (select is_live from live)
     and (a.scopes is null or s.scope_code = any (a.scopes))
   group by 1
),
recv_after as (
  select poi.ls_product_id product_id, sum(poi.received_qty) q
    from purchase_order_items poi join purchase_orders po on po.id = poi.po_id
   where po.created_date > (select d from asof) and not (select is_live from live)
     and ((select stock_outlet from asof) is null or coalesce(po.outlet, 'Time Keeper') = (select stock_outlet from asof))
   group by 1
),
receipts as (
  select poi.ls_product_id product_id, max(po.created_date) last_order
    from purchase_order_items poi join purchase_orders po on po.id = poi.po_id
   where poi.received_qty > 0 and po.created_date <= (select d from asof)
   group by 1
),
open_orders as (
  select poi.ls_product_id product_id, sum(greatest(poi.ordered_qty - coalesce(poi.received_qty, 0), 0)) q
    from purchase_order_items poi join purchase_orders po on po.id = poi.po_id
   where po.status in ('Ordered', 'Pending Approval', 'Partially Received')
     and po.created_date <= (select d from asof)
     and ((select stock_outlet from asof) is null or coalesce(po.outlet, 'Time Keeper') = (select stock_outlet from asof))
   group by 1
),
stock_now as (
  select s.product_id, s.outlet, s.stock_on_hand q, s.price, c.cost
    from lightspeed_stock s left join lightspeed_stock_cost c using (product_id, outlet)
   where (select stock_outlet from asof) is null or s.outlet = (select stock_outlet from asof)
),
stock as (
  select sn.product_id,
         sum(greatest(sn.q, 0)) on_hand_now,
         sum(least(sn.q, 0)) negative_units,
         jsonb_object_agg(sn.outlet, sn.q) filter (where sn.q <> 0) by_outlet,
         max(sn.price) price,
         case when sum(greatest(sn.q, 0)) > 0
              then sum(greatest(sn.q, 0) * sn.cost) / nullif(sum(greatest(sn.q, 0)) filter (where sn.cost is not null), 0)
              else avg(sn.cost) filter (where sn.cost > 0) end cost,
         sum(greatest(sn.q, 0) * sn.cost) cost_value,
         sum(greatest(sn.q, 0) * sn.price) retail_value
    from stock_now sn group by 1
),
ids as (
  select product_id from stock union select product_id from sold
)
select ids.product_id,
       coalesce(lp.name, st_name.name) name,
       coalesce(lp.brand, st_name.brand) brand,
       coalesce(lp.supplier, st_name.supplier) supplier,
       lp.product_type,
       coalesce(lp.ownership, 'unknown') ownership,
       case when (select is_live from live) then 'actual' else 'reconstructed' end stock_basis,
       case when (select is_live from live) then coalesce(st.on_hand_now, 0)
            else greatest(coalesce(st.on_hand_now, 0) + coalesce(sa.q, 0) - coalesce(ra.q, 0), 0) end on_hand,
       coalesce(st.negative_units, 0),
       case when (select is_live from live) then st.by_outlet end,
       st.cost, st.price,
       case when (select is_live from live) then coalesce(st.cost_value, 0) end,
       case when (select is_live from live) then coalesce(st.retail_value, 0) end,
       coalesce(oo.q, 0),
       coalesce(so.u30, 0), coalesce(so.u90, 0), coalesce(so.u180, 0), coalesce(so.u365, 0),
       coalesce(so.rev90, 0), coalesce(so.rev180, 0), coalesce(so.rev365, 0),
       coalesce(so.list_value90, 0),
       so.first_sale, so.last_sale, rc.last_order,
       case when coalesce(so.u365, 0) > 0 then round(least(sp.best / so.u365, 1), 3) end,
       (lp.ls_created_at at time zone 'Asia/Kuwait')::date
  from ids
  left join lightspeed_products lp on lp.product_id = ids.product_id
  left join lateral (select max(name) name, max(brand) brand, max(supplier) supplier
                       from lightspeed_stock x where x.product_id = ids.product_id) st_name on true
  left join stock st on st.product_id = ids.product_id
  left join sold so on so.product_id = ids.product_id
  left join spike sp on sp.product_id = ids.product_id
  left join sold_after sa on sa.product_id = ids.product_id
  left join recv_after ra on ra.product_id = ids.product_id
  left join receipts rc on rc.product_id = ids.product_id
  left join open_orders oo on oo.product_id = ids.product_id
 where coalesce(lp.ownership, 'unknown') <> 'service' and lp.has_inventory is not false;
end $$;
-- The facts, plus what the analyst reads from them, with the rule that put
-- each product in its class. Classes are judged against the product's own
-- kind; ownership is carried through so callers keep owned stock, consignment
-- and pre-owned apart.
--
--   pace           lower of (sold in 90 days / 3) and (sold in 180 days / 6), per month
--   cover          (stock + on order) / pace, in months
--   sell_through   sold in 180 days / (sold in 180 days + stock now)
--   margin         (price - cost) / price, on today's price and cost
--   discount       how far the till price fell below list price over 90 days
--   shelf_days     days since the order date of the last purchase order that
--                  received it, else since it was created in Lightspeed
--                  (estimated either way: receipt dates are not stored)
--
-- Classes, first rule met wins:
--   not_stocked   no stock
--   unclassified  no date it arrived and never sold
--   dead          no sale in 180 days and on the shelf 180+ days
--   new           first sold, or (never sold) arrived, in the last 90 days:
--                 too early to judge. A restock of an established model is
--                 judged on its record, not as new.
--   slow          no sale in 90 days, or more than 12 months of cover
--   fast          3 months of cover or less and at least 2 sold in 90 days
--   healthy       everything else
create or replace function public.stock_analyst_metrics(p_as_of date default null, p_outlet text default null)
returns table (
  product_id text, name text, brand text, supplier text, product_type text, ownership text,
  stock_basis text, on_hand numeric, negative_units numeric, by_outlet jsonb,
  cost numeric, price numeric, stock_cost_value numeric, stock_retail_value numeric, on_order numeric,
  u30 numeric, u90 numeric, u180 numeric, u365 numeric, rev90 numeric, rev180 numeric, rev365 numeric,
  first_sale date, last_sale date, last_receipt_order date, best_month_share numeric, product_created date,
  pace numeric, cover_months numeric, sell_through numeric, margin numeric, discount numeric,
  shelf_days integer, months_on_sale numeric, class text, class_basis text
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare d date := coalesce(p_as_of, (now() at time zone 'Asia/Kuwait')::date - 1);
begin
  perform stock_analyst_guard();
  return query
  with f as (select * from stock_analyst_facts(d, p_outlet)),
  m as (
    select f.*,
           round(least(f.u90 / 3.0, f.u180 / 6.0), 2) pace,
           case when f.on_hand + f.on_order <= 0 then 0
                when least(f.u90 / 3.0, f.u180 / 6.0) > 0
                  then round((f.on_hand + f.on_order) / least(f.u90 / 3.0, f.u180 / 6.0), 1) end cover_months,
           case when f.u180 + f.on_hand > 0 and f.u180 >= 0 then round(f.u180 / (f.u180 + f.on_hand), 3) end sell_through,
           case when f.price > 0 and f.cost is not null then round((f.price - f.cost) / f.price, 3) end margin,
           case when f.list_value90 > 0 and f.rev90 > 0 then round(1 - f.rev90 / f.list_value90, 3) end discount,
           (d - coalesce(f.last_receipt_order, f.product_created))::int shelf_days,
           case when f.first_sale is not null then round((d - f.first_sale) / 30.4, 1) end months_on_sale
      from f
  )
  select m.product_id, m.name, m.brand, m.supplier, m.product_type, m.ownership,
         m.stock_basis, m.on_hand, m.negative_units, m.by_outlet,
         m.cost, m.price, m.stock_cost_value, m.stock_retail_value, m.on_order,
         m.u30, m.u90, m.u180, m.u365, m.rev90, m.rev180, m.rev365,
         m.first_sale, m.last_sale, m.last_receipt_order, m.best_month_share, m.product_created,
         m.pace, m.cover_months, m.sell_through, m.margin, m.discount, m.shelf_days, m.months_on_sale,
         case
           when m.on_hand <= 0 then 'not_stocked'
           when m.shelf_days is null and m.last_sale is null then 'unclassified'
           when coalesce(m.u180, 0) <= 0 and coalesce(m.last_sale, '1900-01-01'::date) <= d - 180
                and coalesce(m.shelf_days, 9999) >= 180 then 'dead'
           when m.first_sale > d - 90 or (m.first_sale is null and m.shelf_days < 90) then 'new'
           when coalesce(m.u90, 0) <= 0 or m.cover_months > 12 then 'slow'
           when m.cover_months <= 3 and m.u90 >= 2 then 'fast'
           else 'healthy'
         end,
         case
           when m.on_hand <= 0 then 'no stock'
           when m.shelf_days is null and m.last_sale is null then 'no record of when it arrived, and never sold'
           when coalesce(m.u180, 0) <= 0 and coalesce(m.last_sale, '1900-01-01'::date) <= d - 180
                and coalesce(m.shelf_days, 9999) >= 180 then
             case when m.shelf_days is null
                  then 'no sale in 180 days; when it arrived is unknown (estimated)'
                  else 'no sale in 180 days, on the shelf about ' || m.shelf_days || ' days (estimated)' end
           when m.first_sale > d - 90 then 'first sold ' || (d - m.first_sale) || ' days ago: too early to judge'
           when m.first_sale is null and m.shelf_days < 90 then 'arrived about ' || m.shelf_days || ' days ago, not sold yet: too early to judge'
           when coalesce(m.u90, 0) <= 0 then 'no sale in 90 days'
           when m.cover_months > 12 then m.cover_months || ' months of cover at its current pace'
           when m.cover_months <= 3 and m.u90 >= 2 then m.cover_months || ' months of cover, ' || m.u90 || ' sold in 90 days'
           else 'selling ' || m.pace || ' a month, ' || coalesce(m.cover_months::text, '?') || ' months of cover'
         end
    from m;
end $$;
-- What every answer states first: when the stock and sales it rests on were
-- last brought in from Lightspeed, and the last full day of sales it counts.
create or replace function public.stock_analyst_header(p_as_of date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d date := coalesce(p_as_of, (now() at time zone 'Asia/Kuwait')::date - 1);
        stock_at timestamptz; sales_at timestamptz;
begin
  perform stock_analyst_guard();
  select max(synced_at) into stock_at from lightspeed_stock;
  select max(finished_at) into sales_at from lightspeed_sync_log where kind = 'sales' and status = 'ok';
  return jsonb_build_object(
    'sales_through', d,
    'stock_as_of', to_char(stock_at at time zone 'Asia/Kuwait', 'YYYY-MM-DD HH24:MI'),
    'sales_synced', to_char(sales_at at time zone 'Asia/Kuwait', 'YYYY-MM-DD HH24:MI'),
    'stock_basis', case when d >= (stock_at at time zone 'Asia/Kuwait')::date - 1 then 'actual' else 'reconstructed' end,
    'timezone', 'Kuwait');
end $$;

-- How much stock there is and what it is worth, owned stock kept apart from
-- consignment and pre-owned. Only owned stock is "money tied up".
create or replace function public.stock_summary(p_brand text default null, p_outlet text default null,
                                     p_product_type text default null, p_as_of date default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d date := coalesce(p_as_of, (now() at time zone 'Asia/Kuwait')::date - 1);
        o text := stock_outlet_name(p_outlet); res jsonb;
begin
  perform stock_analyst_guard();
  with m as (
    select * from stock_analyst_metrics(d, p_outlet) x
     where (p_brand is null or lower(x.brand) = lower(p_brand) or x.brand ilike p_brand || '%')
       and (p_product_type is null or lower(x.product_type) = lower(p_product_type))
  ),
  -- stock rows per location (actual stock only); with an outlet, only that one
  s as (
    select ls.outlet, ls.product_id, greatest(ls.stock_on_hand, 0) q, ls.stock_on_hand raw_q, c.cost, ls.price,
           m.ownership, m.product_type, m.class
      from lightspeed_stock ls
      join m on m.product_id = ls.product_id
      left join lightspeed_stock_cost c on c.product_id = ls.product_id and c.outlet = ls.outlet
     where o is null or ls.outlet = o
  ),
  own as (
    select ownership,
           count(distinct product_id) filter (where q > 0) products,
           sum(q) units,
           round(sum(q * cost)) cost_value,
           round(sum(q * price)) retail_value,
           count(distinct product_id) filter (where q > 0 and cost is null) no_cost
      from s group by ownership
  ),
  types as (
    select ownership, coalesce(product_type, 'Type not set') product_type,
           count(distinct product_id) filter (where q > 0) products, sum(q) units, round(sum(q * cost)) cost_value
      from s group by 1, 2
  ),
  outlets as (
    select outlet, ownership, sum(q) units, round(sum(q * cost)) cost_value from s group by 1, 2
  ),
  classes as (
    select ownership, class, count(distinct product_id) filter (where q > 0) products, sum(q) units,
           round(sum(q * cost)) cost_value
      from s where q > 0 group by 1, 2
  ),
  sales as (
    select ownership, sum(u90) u90, round(sum(rev90)) rev90, sum(u365) u365, round(sum(rev365)) rev365 from m group by 1
  ),
  issues as (
    select count(distinct product_id) filter (where raw_q < 0) negative_products,
           sum(raw_q) filter (where raw_q < 0) negative_units,
           count(distinct product_id) filter (where q > 0 and cost is null) no_cost_products,
           count(distinct product_id) filter (where q > 0 and cost > price) below_cost_products,
           count(distinct product_id) filter (where q > 0 and ownership = 'unknown') untyped_products
      from s
  )
  select jsonb_build_object(
    'header', stock_analyst_header(d) || jsonb_build_object('filters',
        jsonb_strip_nulls(jsonb_build_object('brand', p_brand, 'outlet', o, 'product_type', p_product_type))),
    'by_ownership', (select jsonb_object_agg(own.ownership, jsonb_build_object(
          'products', own.products, 'units', own.units, 'cost_value', own.cost_value, 'retail_value', own.retail_value,
          'products_without_cost', own.no_cost,
          'sold_90d', sa.u90, 'revenue_90d', sa.rev90, 'sold_365d', sa.u365, 'revenue_365d', sa.rev365,
          'confidence', 'accurate',
          'note', case own.ownership
                    when 'owned' then 'your money tied up in stock'
                    when 'consignment' then 'supplier''s stock held on consignment, not your capital'
                    when 'pre_owned' then 'one-off pre-owned pieces'
                    when 'unknown' then 'product type not set in Lightspeed'
                  end))
        from own left join sales sa on sa.ownership = own.ownership),
    'by_type', (select jsonb_agg(t order by t.cost_value desc nulls last) from types t where t.units > 0),
    'by_outlet', (select jsonb_agg(x order by x.outlet, x.ownership) from outlets x where x.units > 0),
    'by_class', (select jsonb_agg(c order by c.ownership, c.cost_value desc nulls last) from classes c),
    'class_confidence', 'estimated (time on the shelf comes from purchase-order dates)',
    'data_issues', (select to_jsonb(i) from issues i),
    'sales_scope', coalesce(array_to_string(stock_outlet_scopes(p_outlet), ', '), 'all outlets and channels'),
    'products_matched', (select count(*) from m where on_hand > 0)
  ) into res;
  return res;
end $$;
-- Best and worst sellers. Best: most revenue and most units in the period.
-- Worst: stock on the shelf long enough to judge (not new), ranked by the value
-- that has not moved, with its sell-through. Owned, consignment and pre-owned
-- are reported apart; services never appear.
create or replace function public.sales_ranking(p_days integer default 90, p_brand text default null,
    p_outlet text default null, p_product_type text default null, p_ownership text default null,
    p_limit integer default 10, p_as_of date default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d date := coalesce(p_as_of, (now() at time zone 'Asia/Kuwait')::date - 1);
        n int := least(greatest(coalesce(p_limit, 10), 1), 50);
        days int := least(greatest(coalesce(p_days, 90), 7), 730);
        res jsonb;
begin
  perform stock_analyst_guard();
  with m as (
    select * from stock_analyst_metrics(d, p_outlet) x
     where (p_brand is null or lower(x.brand) = lower(p_brand) or x.brand ilike p_brand || '%')
       and (p_product_type is null or lower(x.product_type) = lower(p_product_type))
       and (p_ownership is null or x.ownership = p_ownership)
  ),
  per as (   -- the requested period, net of returns
    select i.product_id, sum(i.quantity) units, sum(i.price_total) revenue
      from lightspeed_sale_items i join lightspeed_sales s on s.id = i.sale_id
     where s.status = any (lightspeed_sale_counts()) and coalesce(i.status, 'CONFIRMED') <> 'VOIDED'
       and s.sale_day > d - days and s.sale_day <= d
       and (stock_outlet_scopes(p_outlet) is null or s.scope_code = any (stock_outlet_scopes(p_outlet)))
     group by 1
  ),
  j as (select m.*, coalesce(per.units, 0) p_units, coalesce(per.revenue, 0) p_revenue from m left join per using (product_id))
  select jsonb_build_object(
    'header', stock_analyst_header(d) || jsonb_build_object('period_days', days,
        'period', (d - days + 1) || ' to ' || d,
        'filters', jsonb_strip_nulls(jsonb_build_object('brand', p_brand, 'outlet', stock_outlet_name(p_outlet),
                                                        'product_type', p_product_type, 'ownership', p_ownership))),
    'best_by_revenue', (select jsonb_agg(x) from (
        select name, (select sku from lightspeed_products lp where lp.product_id = j.product_id) sku, brand, product_type, ownership, p_units units, round(p_revenue) revenue, on_hand stock_now,
               round(p_revenue / nullif(p_units, 0)) avg_price
          from j where p_units > 0 order by p_revenue desc limit n) x),
    'best_by_units', (select jsonb_agg(x) from (
        select name, (select sku from lightspeed_products lp where lp.product_id = j.product_id) sku, brand, product_type, ownership, p_units units, round(p_revenue) revenue, on_hand stock_now
          from j where p_units > 0 order by p_units desc, p_revenue desc limit n) x),
    'worst', (select jsonb_agg(x) from (
        select name, (select sku from lightspeed_products lp where lp.product_id = j.product_id) sku, brand, product_type, ownership, on_hand stock_now, round(stock_cost_value) unsold_cost_value,
               p_units units_in_period, u180 units_180d, sell_through sell_through_180d, last_sale, shelf_days,
               class, class_basis
          from j where on_hand > 0 and class in ('dead', 'slow')
         order by stock_cost_value desc nulls last limit n) x),
    'confidence', jsonb_build_object('sales', 'accurate', 'stock', 'accurate',
        'shelf_days', 'estimated (from purchase-order dates)'),
    'notes', jsonb_build_array('Sales are net of returns.',
        'Worst sellers are only products on the shelf long enough to judge; new arrivals are left out.')
  ) into res;
  return res;
end $$;

-- Calendar-month performance for one brand (or every brand when none is given):
-- the last p_months complete months against the p_months before, or against the
-- same months a year earlier.
create or replace function public.brand_performance(p_brand text default null, p_months integer default 6,
    p_compare text default 'previous', p_outlet text default null, p_product_type text default null,
    p_as_of date default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d date := coalesce(p_as_of, (now() at time zone 'Asia/Kuwait')::date - 1);
        k int := least(greatest(coalesce(p_months, 6), 1), 24);
        cur_end date; cur_start date; prev_start date; prev_end date; res jsonb;
begin
  perform stock_analyst_guard();
  cur_end := (date_trunc('month', d + 1) - interval '1 day')::date;      -- last day of d's month
  if cur_end > d then cur_end := (date_trunc('month', d) - interval '1 day')::date; end if;  -- last complete month
  cur_start := (date_trunc('month', cur_end) - make_interval(months => k - 1))::date;
  if coalesce(p_compare, 'previous') = 'last_year' then
    prev_start := (cur_start - interval '1 year')::date; prev_end := (cur_end - interval '1 year')::date;
  else
    prev_end := cur_start - 1; prev_start := (date_trunc('month', prev_end) - make_interval(months => k - 1))::date;
  end if;
  with lines as (
    select i.product_id, coalesce(lp.brand, i.brand) brand, lp.product_type, coalesce(lp.ownership, 'unknown') ownership,
           s.sale_day, date_trunc('month', s.sale_day)::date mth, i.quantity q, i.price_total kd
      from lightspeed_sale_items i join lightspeed_sales s on s.id = i.sale_id
      left join lightspeed_products lp on lp.product_id = i.product_id
     where s.status = any (lightspeed_sale_counts()) and coalesce(i.status, 'CONFIRMED') <> 'VOIDED'
       and i.product_id is not null and coalesce(lp.ownership, 'unknown') <> 'service' and lp.has_inventory is not false
       and ((s.sale_day between cur_start and cur_end) or (s.sale_day between prev_start and prev_end))
       and (stock_outlet_scopes(p_outlet) is null or s.scope_code = any (stock_outlet_scopes(p_outlet)))
       and (p_product_type is null or lower(lp.product_type) = lower(p_product_type))
  ),
  b as (
    select brand,
           sum(q) filter (where sale_day >= cur_start) cur_units, sum(kd) filter (where sale_day >= cur_start) cur_rev,
           sum(q) filter (where sale_day <= prev_end) prev_units, sum(kd) filter (where sale_day <= prev_end) prev_rev
      from lines group by 1
  )
  select jsonb_build_object(
    'header', stock_analyst_header(d) || jsonb_build_object(
        'period', cur_start || ' to ' || cur_end, 'compared_with', prev_start || ' to ' || prev_end,
        'comparison', case when p_compare = 'last_year' then 'same months a year earlier' else 'the months just before' end,
        'filters', jsonb_strip_nulls(jsonb_build_object('brand', p_brand, 'outlet', stock_outlet_name(p_outlet), 'product_type', p_product_type))),
    'brand', case when p_brand is not null then (
        select jsonb_build_object(
          'brand', min(brand),
          'units', coalesce(sum(cur_units), 0), 'revenue', round(coalesce(sum(cur_rev), 0)),
          'compare_units', coalesce(sum(prev_units), 0), 'compare_revenue', round(coalesce(sum(prev_rev), 0)),
          'revenue_change_pct', case when sum(prev_rev) > 0 then round(100 * (sum(cur_rev) - sum(prev_rev)) / sum(prev_rev)) end,
          'monthly', (select jsonb_agg(x order by x.month) from (
              select mth as month, sum(q) units, round(sum(kd)) revenue,
                     case when mth >= cur_start then 'period' else 'comparison' end part
                from lines where lower(brand) = lower(p_brand) or brand ilike p_brand || '%' group by mth) x))
        from b where lower(brand) = lower(p_brand) or brand ilike p_brand || '%') end,
    'brands', case when p_brand is null then (
        select jsonb_agg(x) from (
          select brand, coalesce(cur_units, 0) units, round(coalesce(cur_rev, 0)) revenue,
                 coalesce(prev_units, 0) compare_units, round(coalesce(prev_rev, 0)) compare_revenue,
                 case when prev_rev > 0 then round(100 * (coalesce(cur_rev, 0) - prev_rev) / prev_rev) end revenue_change_pct
            from b where coalesce(cur_rev, 0) + coalesce(prev_rev, 0) > 0
           order by coalesce(cur_rev, 0) desc limit 40) x) end,
    'confidence', 'accurate',
    'notes', jsonb_build_array('Whole calendar months; the current month is not included until it ends.',
                               'Sales are net of returns. Revenue is what the till took, after discounts.')
  ) into res;
  return res;
end $$;

-- Why a brand's (or a product's) sales changed: every signal the data can test,
-- each marked present (with its numbers), absent, or cannot_tell. Reasons that
-- are not here, such as marketing or competitors, are outside what the data
-- can show and are listed as such.
create or replace function public.explain_change(p_brand text default null, p_product_id text default null,
    p_months integer default 6, p_outlet text default null, p_as_of date default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d date := coalesce(p_as_of, (now() at time zone 'Asia/Kuwait')::date - 1);
        k int := least(greatest(coalesce(p_months, 6), 1), 12);
        cur_start date; prev_start date; ly_start date; ly_prev_start date; res jsonb;
begin
  perform stock_analyst_guard();
  if p_brand is null and p_product_id is null then raise exception 'explain_change needs a brand or a product'; end if;
  cur_start := d - (k * 30.4)::int + 1; prev_start := cur_start - (k * 30.4)::int;
  ly_start := cur_start - 365; ly_prev_start := prev_start - 365;
  with scope_products as (
    select lp.product_id, lp.name, lp.brand, lp.ownership from lightspeed_products lp
     where (p_product_id is not null and lp.product_id = p_product_id)
        or (p_product_id is null and (lower(lp.brand) = lower(p_brand) or lp.brand ilike p_brand || '%'))
  ),
  lines as (
    select i.product_id, s.sale_day, s.scope_code, i.quantity q, i.price_total kd, coalesce(i.price, 0) * i.quantity list_kd
      from lightspeed_sale_items i join lightspeed_sales s on s.id = i.sale_id
     where s.status = any (lightspeed_sale_counts()) and coalesce(i.status, 'CONFIRMED') <> 'VOIDED'
       and i.product_id in (select product_id from scope_products)
       and s.sale_day > ly_prev_start and s.sale_day <= d
       and (stock_outlet_scopes(p_outlet) is null or s.scope_code = any (stock_outlet_scopes(p_outlet)))
  ),
  per_product as (
    select sp.product_id, sp.name,
           coalesce(sum(l.q) filter (where l.sale_day >= cur_start), 0) cur_u,
           coalesce(sum(l.q) filter (where l.sale_day >= prev_start and l.sale_day < cur_start), 0) prev_u,
           coalesce(sum(l.kd) filter (where l.sale_day >= cur_start), 0) cur_kd,
           coalesce(sum(l.kd) filter (where l.sale_day >= prev_start and l.sale_day < cur_start), 0) prev_kd,
           min(l.sale_day) filter (where l.q > 0) first_sale_window,
           (select min(s2.sale_day) from lightspeed_sale_items i2 join lightspeed_sales s2 on s2.id = i2.sale_id
             where i2.product_id = sp.product_id and i2.quantity > 0 and s2.status = any (lightspeed_sale_counts())) first_sale_ever,
           (select coalesce(sum(greatest(ls.stock_on_hand, 0)), 0) from lightspeed_stock ls
             where ls.product_id = sp.product_id
               and (stock_outlet_name(p_outlet) is null or ls.outlet = stock_outlet_name(p_outlet))) stock_now
      from scope_products sp left join lines l on l.product_id = sp.product_id
     group by sp.product_id, sp.name
  ),
  tot as (
    select sum(cur_u) cur_u, sum(prev_u) prev_u, sum(cur_kd) cur_kd, sum(prev_kd) prev_kd from per_product
  ),
  movers as (
    select name, prev_u, cur_u, cur_u - prev_u delta_u, round(cur_kd - prev_kd) delta_kd, stock_now
      from per_product where cur_u <> prev_u order by abs(cur_u - prev_u) desc limit 5
  ),
  stockouts as (
    select product_id, name, prev_u, cur_u, stock_now from per_product
     where prev_u >= 3 and cur_u <= 0.25 * prev_u and stock_now <= 1
  ),
  launches as (
    select name, first_sale_ever, cur_u, round(cur_kd) cur_kd from per_product
     where first_sale_ever >= cur_start and cur_u > 0
  ),
  disc as (
    select 1 - sum(kd) filter (where sale_day >= cur_start and q > 0) / nullif(sum(list_kd) filter (where sale_day >= cur_start and q > 0), 0) cur_disc,
           1 - sum(kd) filter (where sale_day >= prev_start and sale_day < cur_start and q > 0)
             / nullif(sum(list_kd) filter (where sale_day >= prev_start and sale_day < cur_start and q > 0), 0) prev_disc,
           sum(kd) filter (where sale_day >= cur_start) / nullif(sum(q) filter (where sale_day >= cur_start), 0) cur_avg_price,
           sum(kd) filter (where sale_day >= prev_start and sale_day < cur_start)
             / nullif(sum(q) filter (where sale_day >= prev_start and sale_day < cur_start), 0) prev_avg_price,
           sum(q) filter (where sale_day >= ly_start and sale_day < ly_start + (cur_start - prev_start)) ly_cur_u,
           sum(q) filter (where sale_day >= ly_prev_start and sale_day < ly_start) ly_prev_u
      from lines
  ),
  scopes as (
    select scope_code,
           sum(q) filter (where sale_day >= cur_start) cur_u,
           sum(q) filter (where sale_day >= prev_start and sale_day < cur_start) prev_u
      from lines group by 1
  ),
  rest as (   -- the brand without the models that sold out
    select sum(cur_u) cur_u, sum(prev_u) prev_u from per_product
     where product_id not in (select product_id from stockouts)
  )
  select jsonb_build_object(
    'header', stock_analyst_header(d) || jsonb_build_object(
        'subject', coalesce(p_brand, (select name from scope_products limit 1)),
        'period', cur_start || ' to ' || d, 'compared_with', prev_start || ' to ' || (cur_start - 1),
        'filters', jsonb_strip_nulls(jsonb_build_object('outlet', stock_outlet_name(p_outlet)))),
    'facts', (select jsonb_build_object('units', cur_u, 'compare_units', prev_u, 'revenue', round(cur_kd),
                     'compare_revenue', round(prev_kd),
                     'revenue_change_pct', case when prev_kd > 0 then round(100 * (cur_kd - prev_kd) / prev_kd) end,
                     'units_change_pct', case when prev_u > 0 then round(100 * (cur_u - prev_u) / prev_u) end,
                     'unit_change_is_meaningful', abs(cur_u - prev_u) >= greatest(3, 0.2 * abs(prev_u))) from tot),
    'signals', jsonb_build_array(
      jsonb_build_object('signal', 'concentration',
        'status', case when (select count(*) from movers) = 0 then 'absent'
                       when not (select abs(cur_u - prev_u) >= greatest(3, 0.2 * abs(prev_u)) from tot) then 'absent'
                       when (select abs(sum(delta_u)) from (select delta_u from movers order by abs(delta_u) desc limit 2) z)
                            >= 0.6 * nullif(abs((select cur_u - prev_u from tot)), 0) then 'present' else 'absent' end,
        'evidence', (select jsonb_agg(m) from movers m)),
      jsonb_build_object('signal', 'stock_out',
        'status', case when exists (select 1 from stockouts) then 'present' else 'absent' end,
        'evidence', (select jsonb_agg(s) from stockouts s),
        'brand_without_them', (select jsonb_build_object('units', cur_u, 'compare_units', prev_u) from rest),
        'confidence', 'estimated (stock now is known; when it ran out is not, until daily snapshots build up)'),
      jsonb_build_object('signal', 'new_launch',
        'status', case when exists (select 1 from launches) then 'present' else 'absent' end,
        'evidence', (select jsonb_agg(l) from launches l)),
      jsonb_build_object('signal', 'discounting',
        'status', case when (select cur_disc - prev_disc from disc) is null then 'cannot_tell'
                       when abs((select cur_disc - prev_disc from disc)) >= 0.10 then 'present' else 'absent' end,
        'evidence', (select jsonb_build_object('discount_now_pct', round(100 * cur_disc), 'discount_before_pct', round(100 * prev_disc)) from disc)),
      jsonb_build_object('signal', 'price_mix',
        'status', case when (select prev_avg_price from disc) is null or (select cur_avg_price from disc) is null then 'cannot_tell'
                       when abs((select cur_avg_price / prev_avg_price - 1 from disc)) >= 0.15 then 'present' else 'absent' end,
        'evidence', (select jsonb_build_object('avg_price_now', round(cur_avg_price), 'avg_price_before', round(prev_avg_price)) from disc)),
      jsonb_build_object('signal', 'outlet_shift',
        'status', case when (select count(*) from scopes) < 2 then 'cannot_tell'
                       when not (select abs(cur_u - prev_u) >= greatest(3, 0.2 * abs(prev_u)) from tot) then 'absent'
                       when (select max(abs(coalesce(cur_u, 0) - coalesce(prev_u, 0))) from scopes)
                            >= 0.6 * nullif(abs((select cur_u - prev_u from tot)), 0)
                        and (select count(*) from scopes where coalesce(cur_u, 0) <> coalesce(prev_u, 0)) > 1 then 'present' else 'absent' end,
        'evidence', (select jsonb_object_agg(scope_code, jsonb_build_object('units', coalesce(cur_u, 0), 'compare_units', coalesce(prev_u, 0))) from scopes)),
      jsonb_build_object('signal', 'seasonal',
        'status', case when (select ly_prev_u from disc) is null or (select ly_prev_u from disc) = 0 then 'cannot_tell'
                       when sign((select ly_cur_u - ly_prev_u from disc)) = sign((select cur_u - prev_u from tot))
                        and abs((select (ly_cur_u - ly_prev_u)::numeric / ly_prev_u from disc)) >= 0.25 then 'present' else 'absent' end,
        'evidence', (select jsonb_build_object('same_period_last_year_units', ly_cur_u, 'period_before_last_year_units', ly_prev_u) from disc))
    ),
    'not_visible_in_data', jsonb_build_array('marketing and social media', 'competitor prices', 'supplier allocation',
                                             'customers who asked but did not buy'),
    'rule', 'Only signals marked present may be given as reasons, with their numbers.'
  ) into res;
  return res;
end $$;
-- One recommendation per product, with every rule it passed or failed.
-- Total sales alone never decide anything: buying needs pace, stock cover,
-- margin, enough history and no one-off spike all at once; advising against
-- needs at least two separate warning signs.
--
--   buy                   owned, every buying rule passes; qty brings cover to the target
--   your_call             selling and short of stock, but new, spiky or thinly sold:
--                         a judgment, never an automatic buy
--   ask_supplier_for_more consignment selling and short of stock
--   ask_supplier_to_swap  consignment not moving: not your capital, but space
--   avoid                 owned, two or more of: no movement, overstock, age,
--                         decline (with stock on hand), thin margin
--   none                  nothing to act on
create or replace function public.stock_recommendations(p_as_of date default null, p_outlet text default null,
    p_target_months numeric default 3)
returns table (product_id text, name text, brand text, product_type text, ownership text, class text,
               on_hand numeric, on_order numeric, pace numeric, cover_months numeric, u90 numeric, u365 numeric,
               cost numeric, price numeric, margin numeric, sell_through numeric, shelf_days integer,
               action text, qty numeric, score numeric, reasons jsonb, rules jsonb)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare d date := coalesce(p_as_of, (now() at time zone 'Asia/Kuwait')::date - 1);
        t numeric := least(greatest(coalesce(p_target_months, 3), 1), 12);
begin
  perform stock_analyst_guard();
  return query
  with m as (select * from stock_analyst_metrics(d, p_outlet)),
  r as (
    select m.*,
      (m.cost > 0) has_cost,
      (coalesce(m.margin, -1) >= 0.25) margin_ok,
      (m.u365 >= 4) history_ok,
      (coalesce(m.months_on_sale, 0) >= 6) established,
      (not (coalesce(m.best_month_share, 0) > 0.6 and m.u365 >= 6)) no_spike,
      (m.pace > 0 and coalesce(m.cover_months, 0) < t) short,
      greatest(ceil(t * m.pace - m.on_hand - m.on_order), 0) need,
      -- warning signs for advising against
      (m.class = 'dead' or (coalesce(m.sell_through, 1) < 0.2 and coalesce(m.shelf_days, 0) >= 180
                         and not (m.u365 >= 4 and m.on_hand <= 0.1 * m.u365))) w_movement,
      (coalesce(m.cover_months, 0) > 12 or (m.pace = 0 and m.on_hand >= 3)) w_overstock,
      (coalesce(m.shelf_days, 0) >= 365) w_age,
      (m.on_hand > 0.1 * m.u365 and m.u365 >= 6 and (m.u365 - m.u90) > 0
        and (m.u90 / 3.0) < 0.5 * ((m.u365 - m.u90) / 9.0)) w_decline,
      (m.cost > 0 and coalesce(m.margin, -1) < 0.25) w_margin,
      (m.on_hand + m.on_order <= 0 and m.u365 >= 6 and coalesce(m.pace, 0) <= 0) sold_out
    from m
  ),
  a as (
    select r.*,
      (r.w_movement::int + r.w_overstock::int + r.w_age::int + r.w_decline::int + r.w_margin::int) warnings,
      case
        when r.ownership = 'owned' and r.product_type not in ('Books', 'Car Models', 'Damaged Products')
             and r.short and r.need > 0 and r.u90 >= 2 and r.has_cost and r.margin_ok and r.history_ok and r.established and r.no_spike
          then 'buy'
        when r.ownership = 'owned' and r.product_type not in ('Books', 'Car Models', 'Damaged Products')
             and r.short and r.need > 0 and r.u90 >= 2 and r.has_cost and r.margin_ok
          then 'your_call'
        when r.ownership = 'owned' and r.product_type not in ('Books', 'Car Models', 'Damaged Products')
             and r.sold_out and r.has_cost and r.margin_ok
          then 'your_call'
        when r.ownership = 'consignment' and r.short and r.u90 >= 2 then 'ask_supplier_for_more'
        when r.ownership = 'consignment' and r.on_hand > 0 and r.class in ('dead', 'slow') and (r.w_movement or r.w_overstock)
          then 'ask_supplier_to_swap'
        when r.ownership = 'owned' and r.on_hand > 0 and r.class not in ('new', 'not_stocked')
             and (r.w_movement::int + r.w_overstock::int + r.w_age::int + r.w_decline::int + r.w_margin::int) >= 2
          then 'avoid'
        else 'none'
      end act
    from r
  )
  select a.product_id, a.name, a.brand, a.product_type, a.ownership, a.class,
         a.on_hand, a.on_order, a.pace, a.cover_months, a.u90, a.u365, a.cost, a.price, a.margin, a.sell_through, a.shelf_days,
         a.act,
         case when a.act in ('buy', 'your_call', 'ask_supplier_for_more')
              then case when a.sold_out then ceil(t * a.u365 / 12.0) else a.need end end,
         case when a.act = 'buy' then round(a.pace * (a.price - a.cost) / a.cost
                * case when a.cover_months < 1 then 1 when a.cover_months < 2 then 0.75 else 0.5 end, 3) end,
         -- the reasons, in words the chat can quote
         (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
            select 'sells about ' || a.pace || ' a month (' || a.u90 || ' in 90 days, ' || a.u365 || ' in a year)' x where a.pace > 0
            union all select a.on_hand || ' in stock, ' || a.on_order || ' on order: ' || coalesce(a.cover_months::text, 'no') || ' months of cover' where a.short
            union all select 'margin ' || round(100 * a.margin) || '% (cost ' || round(a.cost, 1) || ', price ' || a.price || ')' where a.margin is not null and a.act in ('buy', 'your_call', 'avoid')
            union all select 'out of stock and last sold ' || a.last_sale || ': its real pace is probably higher' where a.on_hand <= 0 and a.last_sale < d - 14 and a.act in ('buy', 'your_call')
            union all select 'on sale only ' || coalesce(a.months_on_sale::text, '0') || ' months: not enough history to buy on a formula' where not a.established and a.act = 'your_call'
            union all select 'one month made ' || round(100 * a.best_month_share) || '% of its year''s sales: may be a one-off' where not a.no_spike and a.act = 'your_call'
            union all select 'only ' || a.u365 || ' sold in a year' where not a.history_ok and a.act = 'your_call'
            union all select 'none in stock or on order; ' || a.u365 || ' sold in the last year, the last on ' || a.last_sale
                             || '. Recent sales stopped because there was nothing to sell, so current demand is unknown' where a.sold_out and a.act = 'your_call'
            union all select 'not moving: ' || a.class_basis where a.w_movement and a.act in ('avoid', 'ask_supplier_to_swap')
            union all select 'overstocked: ' || coalesce(a.cover_months::text || ' months of cover', a.on_hand || ' in stock and no recent sales') where a.w_overstock and a.act in ('avoid', 'ask_supplier_to_swap')
            union all select 'on the shelf about ' || a.shelf_days || ' days (estimated)' where a.w_age and not a.w_movement and a.act = 'avoid'
            union all select 'selling at less than half its earlier pace while in stock' where a.w_decline and a.act = 'avoid'
            union all select 'thin margin: ' || round(100 * a.margin) || '%' where a.w_margin and a.act = 'avoid'
          ) z),
         jsonb_build_object('cost_known', a.has_cost, 'margin_25pct', a.margin_ok, 'four_sold_in_a_year', a.history_ok,
                            'six_months_on_sale', a.established, 'no_one_off_spike', a.no_spike,
                            'short_of_stock', a.short, 'sold_out_with_history', a.sold_out, 'warnings', a.warnings)
    from a;
end $$;

-- What to reorder and what to avoid, split by who owns the stock.
create or replace function public.reorder_advice(p_brand text default null, p_outlet text default null,
    p_product_type text default null, p_target_months numeric default 3, p_limit integer default 15,
    p_as_of date default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d date := coalesce(p_as_of, (now() at time zone 'Asia/Kuwait')::date - 1);
        n int := least(greatest(coalesce(p_limit, 15), 1), 50); res jsonb;
begin
  perform stock_analyst_guard();
  with r as (
    select * from stock_recommendations(d, p_outlet, p_target_months) x
     where (p_brand is null or lower(x.brand) = lower(p_brand) or x.brand ilike p_brand || '%')
       and (p_product_type is null or lower(x.product_type) = lower(p_product_type))
  ),
  brand_roll as (
    select brand, count(*) filter (where action = 'avoid') avoid_products,
           round(sum(on_hand * cost) filter (where action = 'avoid')) avoid_value,
           round(sum(on_hand * cost)) owned_value
      from r where ownership = 'owned' and on_hand > 0 group by brand
  )
  select jsonb_build_object(
    'header', stock_analyst_header(d) || jsonb_build_object('target_cover_months', coalesce(p_target_months, 3),
        'filters', jsonb_strip_nulls(jsonb_build_object('brand', p_brand, 'outlet', stock_outlet_name(p_outlet), 'product_type', p_product_type))),
    'buy', (select jsonb_agg(x) from (select name, (select lp.sku from lightspeed_products lp where lp.product_id = r.product_id) sku, brand, product_type, on_hand, on_order, pace, cover_months, qty,
              round(qty * cost) est_cost, reasons from r where action = 'buy' order by score desc limit n) x),
    'your_call', (select jsonb_agg(x) from (select name, (select lp.sku from lightspeed_products lp where lp.product_id = r.product_id) sku, brand, on_hand, pace, cover_months, qty, reasons
              from r where action = 'your_call' order by pace desc limit n) x),
    'ask_supplier_for_more', (select jsonb_agg(x) from (select name, (select lp.sku from lightspeed_products lp where lp.product_id = r.product_id) sku, brand, on_hand, pace, cover_months, qty, reasons
              from r where action = 'ask_supplier_for_more' order by pace desc limit n) x),
    'ask_supplier_to_swap', (select jsonb_agg(x) from (select name, (select lp.sku from lightspeed_products lp where lp.product_id = r.product_id) sku, brand, on_hand, round(on_hand * cost) value, reasons
              from r where action = 'ask_supplier_to_swap' order by on_hand * cost desc nulls last limit n) x),
    'avoid', (select jsonb_agg(x) from (select name, (select lp.sku from lightspeed_products lp where lp.product_id = r.product_id) sku, brand, product_type, on_hand, round(on_hand * cost) value, reasons
              from r where action = 'avoid' order by on_hand * cost desc nulls last limit n) x),
    'avoid_brands', (select jsonb_agg(x) from (select brand, avoid_products, avoid_value, owned_value,
              round(100.0 * avoid_value / nullif(owned_value, 0)) avoid_share_pct
              from brand_roll where avoid_value >= 2000 and avoid_value >= 0.5 * owned_value
              order by avoid_value desc limit 10) x),
    'counts', (select jsonb_object_agg(action, cnt) from (select action, count(*) cnt from r where action <> 'none' group by 1) c),
    'rules', jsonb_build_object(
        'buy', 'owned; selling with under ' || coalesce(p_target_months, 3) || ' months of cover; margin at least 25%; at least 4 sold in a year and 2 in the last 90 days; on sale 6+ months; no one-off spike',
        'avoid', 'owned; at least two of: not moving, overstocked, a year+ on the shelf, pace halved while in stock, margin under 25%',
        'consignment', 'never bought: ask the supplier for more, or to swap or take back'),
    'confidence', jsonb_build_object('stock', 'accurate', 'sales', 'accurate', 'pace', 'estimated when the product was out of stock',
        'shelf_days', 'estimated (purchase-order dates)')
  ) into res;
  return res;
end $$;

-- A buying plan for a budget: owned stock only, highest score first, no model
-- over 20% of the budget and no brand over 40% (unless one brand was asked
-- for). The budget is a ceiling: what nothing justifies is left unspent.
create or replace function public.budget_plan(p_budget numeric, p_brand text default null,
    p_product_type text default null, p_target_months numeric default 3, p_as_of date default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d date := coalesce(p_as_of, (now() at time zone 'Asia/Kuwait')::date - 1);
        left_kd numeric := coalesce(p_budget, 0); cap_model numeric := 0.2 * coalesce(p_budget, 0);
        cap_brand numeric := case when p_brand is null then 0.4 * coalesce(p_budget, 0) else coalesce(p_budget, 0) end;
        rec record; q numeric; plan jsonb := '[]'; brand_spend jsonb := '{}'; spent numeric := 0; res jsonb;
begin
  perform stock_analyst_guard();
  if coalesce(p_budget, 0) <= 0 then raise exception 'A budget above zero is needed'; end if;
  for rec in
    select * from stock_recommendations(d, null, p_target_months) x
     where x.action = 'buy'
       and (p_brand is null or lower(x.brand) = lower(p_brand) or x.brand ilike p_brand || '%')
       and (p_product_type is null or lower(x.product_type) = lower(p_product_type))
     order by x.score desc
  loop
    q := least(rec.qty,
               floor(cap_model / rec.cost),
               floor((cap_brand - coalesce((brand_spend ->> coalesce(rec.brand, '?'))::numeric, 0)) / rec.cost),
               floor(left_kd / rec.cost));
    continue when q is null or q <= 0;
    plan := plan || jsonb_build_object('name', rec.name, 'sku', (select lp.sku from lightspeed_products lp where lp.product_id = rec.product_id), 'brand', rec.brand, 'qty', q, 'wanted', rec.qty,
              'unit_cost', round(rec.cost, 1), 'cost', round(q * rec.cost), 'score', rec.score,
              'capped', q < rec.qty, 'reasons', rec.reasons);
    left_kd := left_kd - q * rec.cost; spent := spent + q * rec.cost;
    brand_spend := brand_spend || jsonb_build_object(coalesce(rec.brand, '?'),
                     coalesce((brand_spend ->> coalesce(rec.brand, '?'))::numeric, 0) + q * rec.cost);
  end loop;
  select jsonb_build_object(
    'header', stock_analyst_header(d) || jsonb_build_object('budget', p_budget, 'target_cover_months', coalesce(p_target_months, 3),
        'filters', jsonb_strip_nulls(jsonb_build_object('brand', p_brand, 'product_type', p_product_type))),
    'lines', plan, 'spent', round(spent), 'unspent', round(p_budget - spent),
    'by_brand', (select jsonb_object_agg(k, round(v::numeric)) from jsonb_each_text(brand_spend) e(k, v)),
    'your_call', (select jsonb_agg(x) from (select name, (select lp.sku from lightspeed_products lp where lp.product_id = y.product_id) sku, brand, on_hand, pace, qty, reasons
        from stock_recommendations(d, null, p_target_months) y
       where y.action = 'your_call'
         and (p_brand is null or lower(y.brand) = lower(p_brand) or y.brand ilike p_brand || '%')
         and (p_product_type is null or lower(y.product_type) = lower(p_product_type))
       order by y.pace desc limit 8) x),
    'rules', 'Owned stock only; consignment is never bought. Highest score first (pace x return on cost x urgency). '
          || 'Up to ' || coalesce(p_target_months, 3) || ' months of cover; no model over 20% of the budget'
          || case when p_brand is null then ', no brand over 40%' else '' end || '. The budget is a ceiling, not a target.',
    'confidence', 'figures accurate; pace estimated where a product ran out of stock'
  ) into res;
  return res;
end $$;

-- Products matching what was typed: every word must appear in the name, SKU or
-- brand. Says when the match is ambiguous instead of guessing.
create or replace function public.find_products(p_text text, p_limit integer default 10)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare words text[]; res jsonb;
begin
  perform stock_analyst_guard();
  words := array(select w from regexp_split_to_table(lower(trim(coalesce(p_text, ''))), '\s+') w where length(w) > 0);
  if array_length(words, 1) is null then return jsonb_build_object('matches', '[]'::jsonb, 'ambiguous', false); end if;
  with c as (
    select lp.product_id, lp.name, lp.brand, lp.product_type, lp.ownership, lp.sku,
           coalesce((select sum(greatest(stock_on_hand, 0)) from lightspeed_stock s where s.product_id = lp.product_id), 0) stock
      from lightspeed_products lp
     where coalesce(lp.ownership, 'unknown') <> 'service' and lp.has_inventory is not false
       and (select bool_and(lower(coalesce(lp.name, '') || ' ' || coalesce(lp.sku, '') || ' ' || coalesce(lp.brand, '')) like '%' || w || '%')
              from unnest(words) w)
  )
  select jsonb_build_object(
    'query', p_text,
    'matches', (select jsonb_agg(x) from (select product_id, name, brand, product_type, ownership, stock from c
                 order by (stock > 0) desc, name limit least(greatest(coalesce(p_limit, 10), 1), 30)) x),
    'total', (select count(*) from c),
    'types_matched', (select jsonb_agg(distinct coalesce(product_type, 'Type not set')) from c),
    'ambiguous', (select count(*) > 1 from c)
  ) into res;
  return res;
end $$;

-- Everything about one product: stock and sales by outlet, the last twelve
-- months, its class, and the recommendation with its reasons.
create or replace function public.explain_product(p_product_id text, p_as_of date default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d date := coalesce(p_as_of, (now() at time zone 'Asia/Kuwait')::date - 1); res jsonb;
begin
  perform stock_analyst_guard();
  select jsonb_build_object(
    'header', stock_analyst_header(d),
    'product', (select to_jsonb(m) - 'by_outlet' from stock_analyst_metrics(d) m where m.product_id = p_product_id),
    'recommendation', (select jsonb_build_object('action', r.action, 'qty', r.qty, 'score', r.score, 'reasons', r.reasons, 'rules', r.rules)
                         from stock_recommendations(d) r where r.product_id = p_product_id),
    'by_outlet', (select jsonb_agg(jsonb_build_object('outlet', o.code, 'stock', f.on_hand, 'sold_90d', f.u90, 'sold_365d', f.u365, 'last_sale', f.last_sale))
                    from (values ('avenues'), ('time_gallery'), ('hq')) o(code)
                    cross join lateral (select * from stock_analyst_facts(d, o.code) x where x.product_id = p_product_id) f),
    'monthly', (select jsonb_agg(x order by x.month) from (
        select date_trunc('month', s.sale_day)::date as month, sum(i.quantity) units, round(sum(i.price_total)) revenue
          from lightspeed_sale_items i join lightspeed_sales s on s.id = i.sale_id
         where i.product_id = p_product_id and s.status = any (lightspeed_sale_counts())
           and coalesce(i.status, 'CONFIRMED') <> 'VOIDED' and s.sale_day > d - 365 and s.sale_day <= d
         group by 1) x),
    'open_orders', (select jsonb_agg(jsonb_build_object('po', po.po_number, 'status', po.status, 'ordered', poi.ordered_qty,
                                                        'received', poi.received_qty, 'created', po.created_date))
                      from purchase_order_items poi join purchase_orders po on po.id = poi.po_id
                     where poi.ls_product_id = p_product_id and po.status in ('Ordered', 'Pending Approval', 'Partially Received'))
  ) into res;
  return res;
end $$;
-- How good would the recommendations have been? Runs the same rules as of a
-- past day, using only what was known by then (sales up to that day, purchase
-- orders created by then, stock rebuilt to that day), then scores them on what
-- actually happened over the next p_horizon days.
--
-- Stock on order on the decision day is counted before any recommended unit
-- would have sold. A product that had no stock on the decision day and was not restocked during
-- the period could not have sold, so its zero says nothing about demand. Those
-- are counted as "could not be judged" and left out of every percentage.
--
--   buy        share of the recommended units that would have sold, the profit
--              on them, the money tied up, and how many ran short
--   avoid      how many of the advised-against products sold nothing afterwards
--   missed     products with a sales history that were not recommended and
--              sold more than the stock they had
--   naive      the same scores for "rebuy last quarter's 30 best sellers by
--              revenue", which the rules must beat
--
-- Rebuilt stock and today's costs make this an estimate, and it says so.
create or replace function public.stock_analyst_backtest(p_as_of date, p_horizon integer default 90,
    p_target_months numeric default 3)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare h int := least(greatest(coalesce(p_horizon, 90), 30), 180); res jsonb;
begin
  perform stock_analyst_guard();
  if p_as_of is null or p_as_of > (now() at time zone 'Asia/Kuwait')::date - 1 - h then
    raise exception 'The decision day must be at least % days in the past', h;
  end if;
  with r as (select * from stock_recommendations(p_as_of, null, p_target_months)),
  after as (
    select i.product_id, sum(i.quantity) sold, sum(i.price_total) revenue
      from lightspeed_sale_items i join lightspeed_sales s on s.id = i.sale_id
     where s.status = any (lightspeed_sale_counts()) and coalesce(i.status, 'CONFIRMED') <> 'VOIDED'
       and s.sale_day > p_as_of and s.sale_day <= p_as_of + h
     group by 1
  ),
  restocked as (    -- received on purchase orders raised during the scored period
    select poi.ls_product_id product_id, sum(poi.received_qty) q
      from purchase_order_items poi join purchase_orders po on po.id = poi.po_id
     where po.created_date > p_as_of and po.created_date <= p_as_of + h and poi.received_qty > 0
     group by 1
  ),
  j as (
    select r.*, coalesce(a.sold, 0) sold_after, coalesce(a.revenue, 0) revenue_after,
           (r.on_hand > 0 or coalesce(rs.q, 0) > 0 or coalesce(a.sold, 0) > 0) judged
      from r left join after a using (product_id) left join restocked rs using (product_id)
  ),
  buy as (
    select j.*,
           least(qty, greatest(sold_after - on_hand - on_order, 0)) used,
           (sold_after > on_hand + on_order) ran_short
      from j where action = 'buy'
  ),
  naive as (
    select j.*, greatest(j.u90 - j.on_hand - j.on_order, 0) nq
      from j where ownership = 'owned' and product_type not in ('Books', 'Car Models', 'Damaged Products')
     order by (select sum(i.price_total) from lightspeed_sale_items i join lightspeed_sales s on s.id = i.sale_id
                where i.product_id = j.product_id and s.status = any (lightspeed_sale_counts())
                  and coalesce(i.status, 'CONFIRMED') <> 'VOIDED' and s.sale_day > p_as_of - 90 and s.sale_day <= p_as_of) desc nulls last
     limit 30
  ),
  naive_s as (
    select n.*, least(nq, greatest(sold_after - on_hand - on_order, 0)) used from naive n where nq > 0
  )
  select jsonb_build_object(
    'decision_day', p_as_of, 'scored_over', (p_as_of + 1) || ' to ' || (p_as_of + h),
    'confidence', 'estimated: stock on the decision day is rebuilt from receipts and sales (transfers and adjustments are not in the data), and costs are today''s',
    'buy', (select jsonb_build_object(
        'products', count(*), 'could_not_be_judged', count(*) filter (where not judged),
        'judged', count(*) filter (where judged),
        'units_recommended', sum(qty) filter (where judged), 'units_that_would_have_sold', sum(used) filter (where judged),
        'sell_through_of_recommended_pct', round(100.0 * sum(used) filter (where judged) / nullif(sum(qty) filter (where judged), 0)),
        'money_tied_up', round(sum(qty * cost) filter (where judged)),
        'gross_profit_on_sold_units', round(sum(used * (price - cost)) filter (where judged)),
        'ran_short_without_it', count(*) filter (where judged and ran_short),
        'judged_with_nothing_sold_after', count(*) filter (where judged and sold_after <= 0)) from buy),
    'your_call', (select jsonb_build_object('products', count(*), 'could_not_be_judged', count(*) filter (where not judged),
        'units_suggested', sum(qty) filter (where judged), 'units_that_would_have_sold', sum(used) filter (where judged),
        'sell_through_pct', round(100.0 * sum(used) filter (where judged) / nullif(sum(qty) filter (where judged), 0)),
        'money_tied_up', round(sum(qty * cost) filter (where judged)),
        'gross_profit_on_sold_units', round(sum(used * (price - cost)) filter (where judged)),
        'ran_short', count(*) filter (where judged and sold_after > on_hand + on_order))
        from (select j.*, least(qty, greatest(sold_after - on_hand - on_order, 0)) used from j where action = 'your_call') yc),
    'avoid', (select jsonb_build_object('products', count(*),
        'with_no_sale_after', count(*) filter (where sold_after <= 0),
        'correct_pct', round(100.0 * count(*) filter (where sold_after <= 0) / nullif(count(*), 0)),
        'units_sold_after', sum(sold_after), 'stock_value', round(sum(on_hand * cost))) from j where action = 'avoid'),
    'missed', (select jsonb_build_object('products', count(*), 'units_short', sum(sold_after - on_hand - on_order),
        'examples', (select jsonb_agg(x) from (select name, on_hand, on_order, sold_after, action from j j2
              where j2.ownership = 'owned' and j2.u365 > 0 and j2.action not in ('buy', 'your_call') and j2.sold_after >= 3
                and j2.sold_after > j2.on_hand + j2.on_order order by j2.sold_after - j2.on_hand - j2.on_order desc limit 8) x))
        from j where ownership = 'owned' and u365 > 0 and action not in ('buy', 'your_call') and sold_after >= 3
                 and sold_after > on_hand + on_order),
    'naive_rebuy_top30', (select jsonb_build_object('products', count(*), 'could_not_be_judged', count(*) filter (where not judged),
        'units_recommended', sum(nq) filter (where judged), 'units_that_would_have_sold', sum(used) filter (where judged),
        'sell_through_of_recommended_pct', round(100.0 * sum(used) filter (where judged) / nullif(sum(nq) filter (where judged), 0)),
        'money_tied_up', round(sum(nq * cost) filter (where judged)),
        'gross_profit_on_sold_units', round(sum(used * (price - cost)) filter (where judged)))
        from naive_s),
    'top_buys', (select jsonb_agg(x) from (select name, on_hand, qty, sold_after, used, judged from buy order by score desc limit 10) x),
    'top_avoids', (select jsonb_agg(x) from (select name, on_hand, sold_after from j where action = 'avoid'
                    order by on_hand * cost desc nulls last limit 10) x)
  ) into res;
  return res;
end $$;

-- Only the chat backend calls these.
do $grants$
declare f text;
begin
  foreach f in array array[
    'public.stock_outlet_name(text)', 'public.stock_outlet_scopes(text)', 'public.stock_analyst_guard()',
    'public.stock_analyst_facts(date, text)', 'public.stock_analyst_metrics(date, text)',
    'public.stock_analyst_header(date)', 'public.stock_summary(text, text, text, date)',
    'public.sales_ranking(integer, text, text, text, text, integer, date)',
    'public.brand_performance(text, integer, text, text, text, date)',
    'public.explain_change(text, text, integer, text, date)',
    'public.stock_recommendations(date, text, numeric)',
    'public.reorder_advice(text, text, text, numeric, integer, date)',
    'public.budget_plan(numeric, text, text, numeric, date)',
    'public.find_products(text, integer)', 'public.explain_product(text, date)',
    'public.stock_analyst_backtest(date, integer, numeric)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $grants$;
