-- Stock analyst: the product drill-down reads the cached per-outlet metrics.
--
-- explain_product() rebuilt each outlet's figures from a year of sales three
-- times over (about 2 s). It now takes them from stock_analyst_metrics() for
-- each outlet, which the hourly cache answers in milliseconds (and which falls
-- back to the same live calculation when the cache is stale). Same figures,
-- same output; only where they are read from changes.
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
                    cross join lateral (select * from stock_analyst_metrics(d, o.code) x where x.product_id = p_product_id) f),
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
