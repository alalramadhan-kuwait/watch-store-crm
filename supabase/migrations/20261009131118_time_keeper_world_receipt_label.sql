-- Time Keeper World: label a receiving event "source" whenever Lightspeed gives its own time.
-- Replaces three World functions only. No table, row, policy or grant changes; the receiving
-- history already logged is left exactly as it is, and is labelled correctly when read.
--
-- Applied 2026-10-09 with the owners' approval. Verified on production: label tests 4/4
-- (supabase/tests/time_keeper_world/receipt_label.sql), receipt log 7/7, security 194/194,
-- reconciliation 70/70; the two events logged before the fix are byte-identical afterwards.

create or replace function world.log_po_receipt() returns trigger
language plpgsql security definer set search_path = public, world as $$
declare
  only_source_time boolean := tg_op = 'UPDATE'
    and old.status is not distinct from new.status
    and old.received_qty is not distinct from new.received_qty;
begin
  begin
    insert into world.receipt_events (po_id, event, old_status, new_status,
      old_received, new_received, ordered_qty, source_received_at, timestamp_basis, actor, actor_user)
    values (new.id,
      case when tg_op = 'INSERT' then 'po_first_seen_received'
           when only_source_time then 'po_source_time_recorded'
           else 'po_changed' end,
      case tg_op when 'INSERT' then null else old.status end, new.status,
      case tg_op when 'INSERT' then null else old.received_qty end, new.received_qty, new.ordered_qty,
      new.ls_received_at,
      -- Lightspeed's own receiving time whenever it gives one, whatever the status.
      case when new.ls_received_at is not null then 'source' else 'first_detected' end,
      case when auth.uid() is null then 'lightspeed sync' else 'user' end, auth.uid());
  exception when others then
    raise warning 'world receipt log skipped for PO %: %', new.id, sqlerrm;
  end;
  return null;
end $$;

create or replace function public.world_snapshot(p_outlet text default null)
returns jsonb
language plpgsql stable security definer set search_path = public, world as $$
-- STABLE: every statement below reads the same database snapshot (the one taken when the
-- call started), so the floor, payments, dock and missions always agree with each other.
-- The work is split into small statements on purpose: one combined statement planned
-- badly on production-sized data, while each section runs in well under a second.
declare
  v_d date := (now() at time zone 'Asia/Kuwait')::date - 1;          -- sales through yesterday
  v_today date := (now() at time zone 'Asia/Kuwait')::date;
  v_outlet text := nullif(lower(trim(coalesce(p_outlet, ''))), '');
  v_stock_at timestamptz;
  v_cache_at timestamptz;
  v_po_at timestamptz;
  v_meta jsonb; v_floor jsonb; v_payments jsonb; v_commitments jsonb; v_receipts jsonb;
  v_issues jsonb; v_missions jsonb; v_people jsonb;
begin
  perform world_guard();
  if v_outlet is not null and v_outlet not in ('avenues', 'time_gallery', 'hq') then
    raise exception 'Unknown outlet "%". Use avenues, time_gallery or hq.', p_outlet using errcode = '22023';
  end if;

  select max(synced_at) into v_stock_at from lightspeed_stock;
  select c.computed_at into v_cache_at from stock_analyst_metrics_cache c
   where c.as_of = v_d and c.outlet_key = coalesce(stock_outlet_name(v_outlet), 'all') and c.stock_synced_at = v_stock_at;
  select max(ls_synced_at) into v_po_at from purchase_orders;

  -- [section:meta:begin]
  select jsonb_build_object(
      'generated_at', now(),
      'sales_through', v_d,
      'outlet', coalesce(v_outlet, 'all'),
      'snapshot_key', md5(concat_ws('|', v_stock_at, v_cache_at, v_po_at,
                          (select count(*) from purchase_orders), (select max(updated_at) from purchase_orders),
                          (select max(id) from world.mission_events), (select max(id) from world.receipt_events))),
      'stock', jsonb_build_object('stock_synced_at', v_stock_at,
                 'source', case when v_cache_at is not null then 'hourly cache' else 'live calculation' end,
                 'cache_computed_at', v_cache_at),
      'po', (select jsonb_build_object('last_sync', v_po_at, 'records', count(*),
                      'active', count(*) filter (where record_class = 'active'),
                      'cancelled', count(*) filter (where record_class = 'cancelled'),
                      'merged', count(*) filter (where record_class = 'merged'))
             from world.po_ledger),
      'receipt_log_started_at', (select (value ->> 'at')::timestamptz from world.meta where key = 'receipt_log_started_at'),
      'rules', jsonb_build_object('unpaid_above_kd', 0.0005, 'review_unpaid_after_days', 45,
                 'featured_brands', 12, 'chase_partial_after_days', 30, 'approval_waiting_after_days', 30,
                 'dead_mission_from_kd', 250, 'reorder_target_months', 3),
      'definitions', jsonb_build_object(
        'recorded_unpaid', 'Cost minus amount paid, as entered in Supplier Payments. Not a verified accounting debt.',
        'review_unpaid', 'Recorded unpaid for more than 45 days since the PO date: for review, not confirmed overdue.',
        'split_basis', 'confirmed when the received quantities settle it; estimate (pro rata by line value) when a PO is part received or closed short.',
        'tied_up_cost', 'Stock cost classed dead or slow: capital tied up, not a realised loss. The World never reports a loss.',
        'shelf_days_est', 'Estimated from the latest purchase-order date, or the product''s creation date. Not a verified receiving date.',
        'age_days', 'Days since the PO date. Not a delivery delay: Lightspeed keeps no expected or receiving dates we can trust.',
        'receipt_event_time', 'source = Lightspeed''s own received time; first_detected = when the daily sync first saw the change.'))
  into v_meta;
  -- [section:meta:end]

  -- [section:floor:begin]
  with stocked as materialized (
    select m.*, coalesce(nullif(trim(m.brand), ''), '(no brand)') shelf_brand
    from stock_analyst_metrics(v_d, v_outlet) m where m.on_hand > 0),
  own as (
    select ownership, count(*) products, sum(on_hand) units,
           round(sum(stock_cost_value), 3) cost_value, round(sum(stock_retail_value), 3) retail_value
    from stocked group by 1),
  own_class as materialized (
    select ownership, class, count(*) products, sum(on_hand) units, round(sum(stock_cost_value), 3) cost_value
    from stocked group by 1, 2),
  shelf as materialized (
    select shelf_brand brand, ownership, count(*) products, sum(on_hand) units,
           round(sum(stock_cost_value), 3) cost_value, round(sum(stock_retail_value), 3) retail_value,
           sum(greatest(coalesce(on_order, 0), 0)) on_order_units,
           coalesce(round(sum(stock_cost_value) filter (where class in ('dead', 'slow')), 3), 0) tied_up_cost,
           percentile_disc(0.5) within group (order by shelf_days) median_shelf_days_est
    from stocked group by 1, 2),
  shelf_class as materialized (
    select shelf_brand brand, ownership, class, count(*) products, sum(on_hand) units,
           round(sum(stock_cost_value), 3) cost_value
    from stocked group by 1, 2, 3),
  brand_rank as materialized (
    select brand, rank() over (order by sum(cost_value) desc, brand) rk from shelf group by brand)
  select jsonb_build_object(
    'totals', (select coalesce(jsonb_object_agg(o.ownership, jsonb_build_object(
                 'products', o.products, 'units', o.units, 'cost_value', o.cost_value, 'retail_value', o.retail_value,
                 'classes', (select jsonb_object_agg(oc.class, jsonb_build_object('products', oc.products,
                               'units', oc.units, 'cost_value', oc.cost_value))
                             from own_class oc where oc.ownership = o.ownership))), '{}'::jsonb) from own o),
    'shelves', (select coalesce(jsonb_agg(jsonb_build_object(
                 'brand', s.brand, 'ownership', s.ownership, 'brand_rank', br.rk, 'featured', br.rk <= 12,
                 'products', s.products, 'units', s.units, 'cost_value', s.cost_value, 'retail_value', s.retail_value,
                 'on_order_units', s.on_order_units, 'tied_up_cost', s.tied_up_cost,
                 'median_shelf_days_est', s.median_shelf_days_est,
                 'classes', (select jsonb_object_agg(sc.class, jsonb_build_object('products', sc.products,
                               'units', sc.units, 'cost_value', sc.cost_value))
                             from shelf_class sc where sc.brand = s.brand and sc.ownership = s.ownership))
                 order by br.rk, s.ownership), '[]'::jsonb)
                from shelf s join brand_rank br on br.brand = s.brand))
  into v_floor;
  -- [section:floor:end]

  -- [section:payments:begin]
  with unpaid as materialized (
    select u.*, u.recorded_unpaid - u.received_part not_received_part
    from world.po_ledger u where u.recorded_unpaid > 0),
  sup as materialized (
    select supplier_key, mode() within group (order by trim(supplier)) display
    from world.po_ledger where supplier_key is not null group by 1)
  select jsonb_build_object(
    'total', (select coalesce(round(sum(recorded_unpaid), 3), 0) from unpaid),
    'pos', (select count(*) from unpaid),
    'goods_received', (select coalesce(round(sum(received_part), 3), 0) from unpaid),
    'goods_not_received', (select coalesce(round(sum(not_received_part), 3), 0) from unpaid),
    'estimated_portion', (select coalesce(round(sum(recorded_unpaid) filter (where split_basis = 'estimate'), 3), 0) from unpaid),
    'review_count', (select count(*) from unpaid where age_days > 45),
    'by_supplier', (select coalesce(jsonb_agg(jsonb_build_object(
                      'supplier_key', x.k, 'supplier', x.display, 'pos', x.n, 'recorded_unpaid', x.total,
                      'goods_received', x.rec, 'goods_not_received', x.notrec, 'estimated_portion', x.est,
                      'oldest_days', x.oldest, 'review_count', x.review) order by x.total desc, x.display), '[]'::jsonb)
                    from (select coalesce(u.supplier_key, 'unknown') k,
                                 coalesce(sp.display, 'Supplier not recorded') display, count(*) n,
                                 round(sum(u.recorded_unpaid), 3) total, round(sum(u.received_part), 3) rec,
                                 round(sum(u.not_received_part), 3) notrec,
                                 coalesce(round(sum(u.recorded_unpaid) filter (where u.split_basis = 'estimate'), 3), 0) est,
                                 max(u.age_days) oldest, count(*) filter (where u.age_days > 45) review
                          from unpaid u left join sup sp on sp.supplier_key = u.supplier_key
                          group by 1, 2) x),
    'list', (select coalesce(jsonb_agg(jsonb_build_object(
               'po_id', u.id, 'po_number', u.po_number, 'supplier', coalesce(sp.display, u.supplier),
               'status', u.status, 'payment_status', u.payment_status, 'created_date', u.created_date,
               'age_days', u.age_days, 'recorded_unpaid', round(u.recorded_unpaid, 3),
               'goods_received', u.received_part, 'goods_not_received', round(u.not_received_part, 3),
               'split_basis', u.split_basis, 'review', u.age_days > 45, 'invoice_received', u.invoice_received)
               order by u.created_date, u.po_number), '[]'::jsonb)
             from unpaid u left join sup sp on sp.supplier_key = u.supplier_key))
  into v_payments;
  -- [section:payments:end]

  -- [section:commitments:begin]
  with open_po as materialized (select * from world.po_ledger where open_commitment),
  sup as materialized (
    select supplier_key, mode() within group (order by trim(supplier)) display
    from world.po_ledger where supplier_key is not null group by 1)
  select jsonb_build_object(
    'open_pos', (select count(*) from open_po),
    'open_po_value', (select coalesce(round(sum(coalesce(total_cost, 0)), 3), 0) from open_po),
    'outstanding_units', (select coalesce(sum(outstanding_units), 0) from open_po),
    'outstanding_value', (select coalesce(round(sum(outstanding_value), 3), 0) from open_po),
    'by_status', (select coalesce(jsonb_object_agg(z.status, jsonb_build_object('pos', z.n, 'value', z.v)), '{}'::jsonb)
                  from (select status, count(*) n, round(sum(coalesce(total_cost, 0)), 3) v from open_po group by 1) z),
    'list', (select coalesce(jsonb_agg(jsonb_build_object(
               'po_id', o.id, 'po_number', o.po_number, 'supplier', coalesce(sp.display, o.supplier), 'brand', o.brand,
               'status', o.status, 'created_date', o.created_date, 'age_days', o.age_days,
               'total_cost', o.total_cost, 'outstanding_units', o.outstanding_units,
               'outstanding_value', round(o.outstanding_value, 3))
               order by o.created_date, o.po_number), '[]'::jsonb)
             from open_po o left join sup sp on sp.supplier_key = o.supplier_key))
  into v_commitments;
  -- [section:commitments:end]

  -- [section:receipts:begin]
  with led as materialized (select * from world.po_ledger where record_class = 'active')
  select jsonb_build_object(
    'partial', (select coalesce(jsonb_agg(jsonb_build_object(
                  'po_id', id, 'po_number', po_number, 'supplier', supplier, 'brand', brand,
                  'ordered_qty', ordered_qty, 'received_qty', received_qty, 'lines', lines,
                  'lines_short', lines_short, 'age_days', age_days) order by created_date), '[]'::jsonb)
                from led where receipt_state = 'partial'),
    'closed_short', (select count(*) from led where receipt_state = 'closed_short'),
    'marked_full_but_short', (select count(*) from led where receipt_state = 'marked_full_but_short'),
    'awaiting', (select count(*) from led where open_commitment and receipt_state = 'not_received'),
    'log', jsonb_build_object(
      'events', (select count(*) from world.receipt_events),
      'recent', (select coalesce(jsonb_agg(jsonb_build_object(
                   'po_id', e.po_id, 'po_number', p.po_number, 'event', e.event, 'old_status', e.old_status,
                   'new_status', e.new_status, 'old_received', e.old_received, 'new_received', e.new_received,
                   'at', coalesce(e.source_received_at, e.detected_at),
                   -- The label follows the time shown: Lightspeed's when the event carries one.
                   -- Decided on read, so events logged before this fix read correctly without being edited.
                   'timestamp_basis', case when e.source_received_at is not null then 'source' else 'first_detected' end,
                   'detected_at', e.detected_at,
                   'actor', e.actor) order by e.detected_at desc, e.id desc), '[]'::jsonb)
                 from (select * from world.receipt_events order by detected_at desc, id desc limit 25) e
                 left join purchase_orders p on p.id = e.po_id)))
  into v_receipts;
  -- [section:receipts:end]

  -- [section:issues:begin]
  with issues as materialized (
    select code, severity, ref_type, ref_id, ref_label, detail, excluded_value, rule, exclusion
    from world.data_issues
    union all
    select 'ownership_not_set', 'info', 'product', a.product_id, a.name,
           jsonb_build_object('brand', a.brand, 'units', a.on_hand, 'cost_value', round(a.stock_cost_value, 3)), null,
           'Product in stock with no ownership set in Lightspeed.',
           'Kept out of owned and consignment totals and shown separately.'
    from stock_analyst_metrics(v_d, null) a where a.on_hand > 0 and a.ownership = 'unknown')
  select coalesce(jsonb_agg(jsonb_build_object(
           'code', g.code, 'severity', g.severity, 'rule', g.rule, 'exclusion', g.exclusion,
           'records', g.n, 'items', g.items)
           order by case g.severity when 'unreliable' then 0 when 'check' then 1 else 2 end, g.code), '[]'::jsonb)
  from (select code, severity, rule, exclusion, count(*) n,
               jsonb_agg(jsonb_build_object('ref_type', ref_type, 'ref_id', ref_id, 'ref_label', ref_label,
                 'detail', detail, 'excluded_value', excluded_value) order by ref_label) items
        from issues group by 1, 2, 3, 4) g
  into v_issues;
  -- [section:issues:end]

  -- [section:missions:begin]
  with m_all as materialized (select * from stock_analyst_metrics(v_d, null)),
  recs as materialized (
    select r.product_id, r.name, r.ownership, r.action, r.qty, r.score, r.cost, r.on_hand,
           coalesce(nullif(trim(r.brand), ''), '(no brand)') shelf_brand, a.supplier
    from stock_recommendations(v_d, null, 3) r
    left join m_all a on a.product_id = r.product_id
    where r.action in ('buy', 'your_call', 'ask_supplier_for_more', 'ask_supplier_to_swap')),
  led as materialized (select * from world.po_ledger where record_class = 'active'),
  mission_raw (key, kind, params, fp, weight_kd) as materialized (
    select 'reorder:' || shelf_brand, 'reorder',
           jsonb_build_object('brand', shelf_brand, 'products', count(*), 'units', sum(coalesce(qty, 0)),
             'buy', count(*) filter (where action = 'buy'), 'your_call', count(*) filter (where action = 'your_call'),
             'top', jsonb_path_query_array(jsonb_agg(jsonb_build_object('product_id', product_id, 'name', name,
                      'action', action, 'qty', qty) order by score desc nulls last), '$[0 to 4]')),
           md5(string_agg(product_id || ':' || coalesce(qty, 0) || ':' || action, ',' order by product_id)),
           round(sum(coalesce(qty, 0) * coalesce(cost, 0)), 3)
    from recs where action in ('buy', 'your_call') and ownership = 'owned'
    group by shelf_brand
    union all
    select 'clear_dead:' || coalesce(nullif(trim(a.brand), ''), '(no brand)'), 'clear_dead',
           jsonb_build_object('brand', coalesce(nullif(trim(a.brand), ''), '(no brand)'), 'products', count(*),
             'units', sum(a.on_hand), 'cost_value', round(sum(a.stock_cost_value), 3),
             'shelf_days_basis', 'estimated',
             'top', jsonb_path_query_array(jsonb_agg(jsonb_build_object('product_id', a.product_id, 'name', a.name,
                      'units', a.on_hand, 'cost_value', round(a.stock_cost_value, 3), 'shelf_days_est', a.shelf_days)
                      order by a.stock_cost_value desc), '$[0 to 4]')),
           md5(count(*)::text),
           round(sum(a.stock_cost_value), 3)
    from m_all a where a.on_hand > 0 and a.class = 'dead' and a.ownership = 'owned'
    group by coalesce(nullif(trim(a.brand), ''), '(no brand)')
    having sum(a.stock_cost_value) >= 250
    union all
    select 'supplier_talk:' || coalesce(nullif(lower(regexp_replace(coalesce(supplier, ''), '[^[:alnum:]]', '', 'g')), ''), 'unknown'),
           'supplier_talk',
           jsonb_build_object('supplier', coalesce(max(supplier), 'Supplier not recorded'),
             'ask_for_more', count(*) filter (where action = 'ask_supplier_for_more'),
             'ask_to_swap', count(*) filter (where action = 'ask_supplier_to_swap'),
             'top', jsonb_path_query_array(jsonb_agg(jsonb_build_object('product_id', product_id, 'name', name,
                      'action', action) order by score desc nulls last), '$[0 to 4]')),
           md5(string_agg(product_id || ':' || action, ',' order by product_id)),
           round(sum(coalesce(on_hand, 0) * coalesce(cost, 0)), 3)
    from recs where action in ('ask_supplier_for_more', 'ask_supplier_to_swap')
    group by 1
    union all
    select 'chase_partial:' || id, 'chase_partial',
           jsonb_build_object('po_id', id, 'po_number', po_number, 'supplier', supplier,
             'ordered_qty', ordered_qty, 'received_qty', received_qty, 'age_days', age_days),
           md5(coalesce(received_qty, 0)::text), round(outstanding_value, 3)
    from led where receipt_state = 'partial' and age_days > 30
    union all
    select 'approval_waiting:' || id, 'approval_waiting',
           jsonb_build_object('po_id', id, 'po_number', po_number, 'supplier', supplier,
             'total_cost', total_cost, 'age_days', age_days),
           md5(status), round(coalesce(total_cost, 0), 3)
    from led where status = 'Pending Approval' and age_days > 30
    union all
    select 'review_unpaid:' || id, 'review_unpaid',
           jsonb_build_object('po_id', id, 'po_number', po_number, 'supplier', supplier,
             'recorded_unpaid', recorded_unpaid, 'age_days', age_days, 'receipt_state', receipt_state),
           md5(round(recorded_unpaid, 3)::text), round(recorded_unpaid, 3)
    from led where recorded_unpaid > 0 and age_days > 45
    union all
    select 'data_issue:' || code || ':' || ref_id, 'data_issue',
           jsonb_build_object('code', code, 'severity', severity, 'ref_type', ref_type, 'ref_id', ref_id,
             'ref_label', ref_label, 'detail', detail),
           md5(detail::text), 0::numeric
    from world.data_issues where severity in ('unreliable', 'check')
  ),
  last_state as materialized (
    select distinct on (e.mission_key) e.mission_key, e.action, e.snooze_until, e.fingerprint, e.actor_name, e.at
    from world.mission_events e where e.action in ('reviewed', 'snoozed', 'reopened')
    order by e.mission_key, e.at desc, e.id desc),
  ev_count as materialized (select e.mission_key, count(*) n from world.mission_events e group by 1)
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', r.key, 'kind', r.kind, 'params', r.params, 'weight_kd', r.weight_kd, 'fingerprint', r.fp,
           'state', st.state, 'state_by', s.actor_name, 'state_at', s.at, 'snooze_until', s.snooze_until,
           'history_events', coalesce(c.n, 0))
           order by (st.state in ('open', 'changed_since_review')) desc, r.weight_kd desc nulls last, r.key), '[]'::jsonb)
  from mission_raw r
  left join last_state s on s.mission_key = r.key
  left join ev_count c on c.mission_key = r.key
  cross join lateral (select case
      when s.action = 'snoozed' and s.snooze_until > v_today then 'snoozed'
      when s.action = 'reviewed' and s.fingerprint is not distinct from r.fp then 'reviewed'
      when s.action = 'reviewed' then 'changed_since_review'
      else 'open' end state) st
  into v_missions;
  -- [section:missions:end]

  -- [section:people:begin]
  select jsonb_build_object(
    'owners', (select coalesce(jsonb_agg(jsonb_build_object('name', trim(p.full_name)) order by p.full_name), '[]'::jsonb)
               from stock_ai_access a join profiles p on p.id = a.user_id),
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('name', trim(e.full_name), 'name_ar', e.name_ar,
                'role', trim(e.job_title), 'location', e.location) order by e.location, e.full_name), '[]'::jsonb)
              from employees e where e.status = 'Active'))
  into v_people;
  -- [section:people:end]

  return jsonb_build_object('meta', v_meta, 'floor', v_floor, 'payments', v_payments,
    'commitments', v_commitments, 'receipts', v_receipts, 'missions', v_missions,
    'data_issues', v_issues, 'people', v_people);
end $$;


create or replace function public.world_po_detail(p_po_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, world as $$
declare v_row world.po_ledger;
begin
  perform world_guard();
  select * into v_row from world.po_ledger where id = p_po_id;
  if not found then
    raise exception 'No purchase order %.', p_po_id using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'po', to_jsonb(v_row) || jsonb_build_object(
            'amount_paid_reliable', not v_row.paid_unreliable,
            'goods_not_received', round(v_row.recorded_unpaid - v_row.received_part, 3)),
    'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', i.id, 'product_id', i.ls_product_id, 'sku', i.sku, 'name', i.name, 'brand', i.brand,
                'ordered_qty', i.ordered_qty, 'received_qty', i.received_qty, 'cost', i.cost,
                'line_cost', round(coalesce(i.ordered_qty, 0) * coalesce(i.cost, 0), 3))
                order by i.name, i.id), '[]'::jsonb)
              from purchase_order_items i where i.po_id = p_po_id),
    'merged_into', (select jsonb_build_object('id', t.id, 'po_number', t.po_number, 'status', t.status)
                    from purchase_orders t where t.id = v_row.merged_into),
    'merged_records', (select coalesce(jsonb_agg(jsonb_build_object(
                         'id', c.id, 'po_number', c.po_number, 'source', c.source, 'status', c.status,
                         'payment_status', c.payment_status, 'total_cost', c.total_cost, 'amount_paid', c.amount_paid,
                         'created_date', c.created_date) order by c.created_date), '[]'::jsonb)
                       from purchase_orders c where c.merged_into = p_po_id),
    'receipt_events', (select coalesce(jsonb_agg(jsonb_build_object(
                         'event', e.event, 'line_id', e.po_item_id, 'product_id', e.ls_product_id,
                         'old_status', e.old_status, 'new_status', e.new_status,
                         'old_received', e.old_received, 'new_received', e.new_received,
                         'at', coalesce(e.source_received_at, e.detected_at),
                   -- The label follows the time shown: Lightspeed's when the event carries one.
                   -- Decided on read, so events logged before this fix read correctly without being edited.
                   'timestamp_basis', case when e.source_received_at is not null then 'source' else 'first_detected' end,
                   'detected_at', e.detected_at,
                         'actor', e.actor) order by e.detected_at, e.id), '[]'::jsonb)
                       from world.receipt_events e where e.po_id = p_po_id),
    'issues', (select coalesce(jsonb_agg(jsonb_build_object('code', di.code, 'severity', di.severity,
                 'rule', di.rule, 'exclusion', di.exclusion, 'excluded_value', di.excluded_value)), '[]'::jsonb)
               from world.data_issues di where di.ref_type = 'po' and di.ref_id = p_po_id::text),
    'generated_at', now());
end $$;
