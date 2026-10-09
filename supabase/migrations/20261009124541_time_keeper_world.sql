-- Applied to production on 2026-10-09 as version 20261009124541 (apply_migration, owner-approved).
-- This is the reviewed Step 1 SQL with one owner-approved revision: the Supabase SQL tools stall
-- on any statement containing DROP, and the project guard flags TRUNCATE, so
--   * the eight `drop trigger if exists` lines were removed (no-ops on a fresh install), and
--   * the two truncate-blocking triggers on the World's logs were replaced by revoking every
--     privilege from service_role as well: only the database owner can touch the logs at all;
--     update and delete stay blocked by trigger even for the owner.
-- Verified after applying: every function, view and trigger definition matches the locally
-- tested copy by checksum; security 194/194, receipt log 7/7, reconciliation (see
-- supabase/tests/time_keeper_world/).

-- Time Keeper World (عالم تايم كيبر): owner-only data layer.
--
-- What this adds
--   * schema `world` (not exposed through the API, no grants to API roles) holding:
--       world.receipt_events  append-only log of receiving changes, from today on
--       world.mission_events  append-only log of reviewed / snoozed / reopened / notes
--       world.meta            when the receipt log started
--       world.po_ledger       view: every PO classified (active / cancelled / merged),
--                             recorded unpaid balance, receipt state, payable split
--       world.data_issues     view: rule-based data issues, each with its exclusion
--   * six owner-only functions in `public`:
--       world_snapshot, world_po_search, world_po_detail,
--       world_mission_act, world_mission_history  (+ world_guard, internal)
--   * purchase_orders.ls_received_at: Lightspeed's own "received at", nullable,
--     filled by lightspeed-po-sync only when Lightspeed provides it
--   * four AFTER triggers on purchase_orders / purchase_order_items that append to
--     world.receipt_events. They never modify the row and never block the sync.
--
-- What this does not do
--   * It changes no existing row, permission, policy or function.
--   * It writes nothing to source records except the new nullable column, which
--     only the sync fills.
--
-- Stock health comes from stock_analyst_metrics / stock_recommendations: the
-- same calculations Ask Mohammed uses.

create schema if not exists world;
revoke all on schema world from public, anon, authenticated;

-- 1. Lightspeed's own receiving time ------------------------------------------

alter table public.purchase_orders add column if not exists ls_received_at timestamptz;
comment on column public.purchase_orders.ls_received_at is
  'Lightspeed consignment received_at, as provided by Lightspeed. Null when Lightspeed gives none. Never estimated.';

-- 2. Append-only logs -----------------------------------------------------------

create table if not exists world.meta (
  key text primary key,
  value jsonb not null,
  set_at timestamptz not null default now()
);
insert into world.meta (key, value)
values ('receipt_log_started_at', jsonb_build_object('at', now()))
on conflict (key) do nothing;

create table if not exists world.receipt_events (
  id bigint generated always as identity primary key,
  po_id uuid not null,                 -- no foreign key: the history outlives a deleted PO
  po_item_id uuid,
  ls_product_id text,
  event text not null check (event in (
    'line_received_changed',           -- a line's received count changed
    'line_first_seen_received',        -- a line appeared already (partly) received
    'po_changed',                      -- PO status or received total changed
    'po_first_seen_received',          -- a PO appeared already (partly) received
    'po_source_time_recorded')),       -- Lightspeed's own received_at arrived
  old_status text,
  new_status text,
  old_received numeric,
  new_received numeric,
  ordered_qty numeric,
  source_received_at timestamptz,      -- Lightspeed's time, only when it provides one
  detected_at timestamptz not null default now(),
  timestamp_basis text not null check (timestamp_basis in ('source', 'first_detected')),
  actor text not null check (actor in ('lightspeed sync', 'user')),
  actor_user uuid
);
create index if not exists receipt_events_po_idx on world.receipt_events (po_id, detected_at desc);

create table if not exists world.mission_events (
  id bigint generated always as identity primary key,
  mission_key text not null check (length(mission_key) between 3 and 240),
  action text not null check (action in ('reviewed', 'snoozed', 'reopened', 'note')),
  snooze_until date,
  note text check (note is null or length(note) <= 500),
  fingerprint text,
  actor uuid not null,
  actor_name text not null,
  at timestamptz not null default now(),
  check (action <> 'snoozed' or snooze_until is not null),
  check (action <> 'note' or note is not null)
);
create index if not exists mission_events_key_idx on world.mission_events (mission_key, at desc, id desc);

alter table world.meta enable row level security;
alter table world.receipt_events enable row level security;
alter table world.mission_events enable row level security;
revoke all on all tables in schema world from public, anon, authenticated, service_role;
-- No role except the database owner holds any privilege here, so nobody else can empty a log.

create or replace function world.forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;

create trigger receipt_events_append_only before update or delete on world.receipt_events
  for each row execute function world.forbid_change();
create trigger mission_events_append_only before update or delete on world.mission_events
  for each row execute function world.forbid_change();

-- 3. Receipt logging triggers (append only, never block the sync) -----------------

create or replace function world.log_line_receipt() returns trigger
language plpgsql security definer set search_path = public, world as $$
begin
  begin
    insert into world.receipt_events (po_id, po_item_id, ls_product_id, event,
      old_received, new_received, ordered_qty, timestamp_basis, actor, actor_user)
    values (new.po_id, new.id, new.ls_product_id,
      case tg_op when 'INSERT' then 'line_first_seen_received' else 'line_received_changed' end,
      case tg_op when 'INSERT' then null else old.received_qty end,
      new.received_qty, new.ordered_qty,
      'first_detected',               -- Lightspeed gives no per-line receiving time
      case when auth.uid() is null then 'lightspeed sync' else 'user' end, auth.uid());
  exception when others then
    raise warning 'world receipt log skipped for line %: %', new.id, sqlerrm;
  end;
  return null;
end $$;

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
      case when new.ls_received_at is not null and new.status = 'Fully Received' then 'source' else 'first_detected' end,
      case when auth.uid() is null then 'lightspeed sync' else 'user' end, auth.uid());
  exception when others then
    raise warning 'world receipt log skipped for PO %: %', new.id, sqlerrm;
  end;
  return null;
end $$;

revoke all on function world.log_line_receipt(), world.log_po_receipt(), world.forbid_change()
  from public, anon, authenticated;

create trigger world_line_received after update of received_qty on public.purchase_order_items
  for each row when (old.received_qty is distinct from new.received_qty)
  execute function world.log_line_receipt();
create trigger world_line_first_seen after insert on public.purchase_order_items
  for each row when (coalesce(new.received_qty, 0) <> 0)
  execute function world.log_line_receipt();
create trigger world_po_received after update of status, received_qty, ls_received_at on public.purchase_orders
  for each row when (old.status is distinct from new.status
                  or old.received_qty is distinct from new.received_qty
                  or old.ls_received_at is distinct from new.ls_received_at)
  execute function world.log_po_receipt();
create trigger world_po_first_seen after insert on public.purchase_orders
  for each row when (new.status in ('Partially Received', 'Fully Received'))
  execute function world.log_po_receipt();

-- 4. The PO ledger: every record, classified ---------------------------------------
-- Explicit columns, so the DSR can still change unrelated purchase_orders columns.

create or replace view world.po_ledger as
-- [po_ledger:begin]
with lines as (
  select i.po_id,
         count(*) lines,
         count(*) filter (where coalesce(i.received_qty, 0) < coalesce(i.ordered_qty, 0)) lines_short,
         sum(coalesce(i.ordered_qty, 0) * coalesce(i.cost, 0)) ordered_value,
         sum(least(coalesce(i.received_qty, 0), coalesce(i.ordered_qty, 0)) * coalesce(i.cost, 0)) received_value,
         sum(greatest(coalesce(i.ordered_qty, 0) - coalesce(i.received_qty, 0), 0)) outstanding_units,
         sum(greatest(coalesce(i.ordered_qty, 0) - coalesce(i.received_qty, 0), 0) * coalesce(i.cost, 0)) outstanding_value
  from public.purchase_order_items i
  group by i.po_id
), base as (
  select p.id, p.po_number, p.source, p.po_type, p.status, p.payment_status,
         p.supplier, p.brand, p.outlet, p.created_date, p.total_cost, p.amount_paid,
         p.payment_date, p.invoice_received, p.supplier_invoice_no,
         p.ordered_qty, p.received_qty, p.closed_override, p.merged_into,
         p.expected_arrival, p.shipment_status, p.ls_received_at, p.ls_synced_at, p.updated_at,
         coalesce(l.lines, 0) lines, coalesce(l.lines_short, 0) lines_short,
         l.ordered_value, l.received_value,
         coalesce(l.outstanding_units, 0) outstanding_units, coalesce(l.outstanding_value, 0) outstanding_value,
         case when p.merged_into is not null then 'merged'
              when p.status = 'Cancelled' then 'cancelled'
              else 'active' end record_class,
         coalesce(p.total_cost, 0) - coalesce(p.amount_paid, 0) balance,
         nullif(lower(regexp_replace(coalesce(p.supplier, ''), '[^[:alnum:]]', '', 'g')), '') supplier_key,
         (now() at time zone 'Asia/Kuwait')::date - p.created_date age_days
  from public.purchase_orders p
  left join lines l on l.po_id = p.id
), classed as (
  select b.*,
         case when b.record_class = 'active' and b.balance > 0.0005 then b.balance else 0 end recorded_unpaid,
         (coalesce(b.amount_paid, 0) > 0
           and (coalesce(b.total_cost, 0) <= 0 or b.amount_paid > b.total_cost * 1.5 + 1)) paid_unreliable,
         case when b.record_class = 'merged' then 'merged'
              when b.status = 'Cancelled' then 'cancelled'
              when b.status = 'Fully Received' and coalesce(b.received_qty, 0) < coalesce(b.ordered_qty, 0)
                then case when b.closed_override then 'closed_short' else 'marked_full_but_short' end
              when b.status = 'Fully Received' then 'received'
              when b.status = 'Partially Received' then 'partial'
              else 'not_received' end receipt_state,
         b.record_class = 'active' and b.status in ('Pending Approval', 'Ordered', 'Partially Received') open_commitment
  from base b
)
select c.*,
       -- Which part of a recorded unpaid balance is for goods already received.
       -- 'confirmed' only when the quantities settle it; otherwise pro rata, labelled 'estimate'.
       case when c.recorded_unpaid = 0 then null
            when c.receipt_state = 'received' and c.ordered_qty is not null then 'confirmed'
            when c.receipt_state = 'not_received' and coalesce(c.received_qty, 0) = 0 then 'confirmed'
            else 'estimate' end split_basis,
       case when c.recorded_unpaid = 0 then 0
            when c.receipt_state = 'received' then c.recorded_unpaid
            when c.receipt_state = 'not_received' and coalesce(c.received_qty, 0) = 0 then 0
            when c.ordered_value > 0 then round(c.recorded_unpaid * c.received_value / c.ordered_value, 3)
            when c.ordered_qty > 0 then round(c.recorded_unpaid * least(coalesce(c.received_qty, 0), c.ordered_qty) / c.ordered_qty, 3)
            else 0 end received_part
from classed c
-- [po_ledger:end]
;

-- 5. Data issues: rule-based, so they clear themselves once a record is fixed -------

create or replace view world.data_issues as
-- [data_issues:begin]
with l as (select * from world.po_ledger where record_class <> 'merged'),
rules (code, severity, rule, exclusion) as (values
  ('paid_far_above_cost', 'unreliable',
   'Amount paid is more than 1.5 times the cost, or the cost is zero while something is paid.',
   'The amount paid is not used in any paid-so-far figure. The unpaid balance counts as 0, as recorded; the true balance is unknown until the record is corrected.'),
  ('paid_above_cost', 'check',
   'Amount paid is more than 5% above the cost.',
   'Kept as recorded and flagged. It may include shipping or exchange-rate charges.'),
  ('payment_label_mismatch', 'check',
   'The payment label disagrees with the amounts (for example Unpaid while the amount paid equals the cost).',
   'The label is not used. The World follows the amounts, as Supplier Payments does.'),
  ('marked_received_but_short', 'check',
   'Marked Fully Received with fewer units received than ordered, and not closed as a short receipt.',
   'Not counted as an open commitment, because Lightspeed says received. Receipt progress shows the recorded counts.'),
  ('supplier_missing', 'info',
   'The PO has no supplier name.',
   'Counted in every total under "Supplier not recorded". No supplier character is drawn for it.'),
  ('supplier_spelling', 'info',
   'One supplier is spelled more than one way.',
   'Spellings are grouped for display only. Source names are unchanged.'),
  ('balance_rounding_residue', 'info',
   'Unpaid balance above zero but below half a fils.',
   'Left out of the unpaid PO count. The KD total is unaffected.'),
  ('ownership_not_set', 'info',
   'Product in stock with no ownership set in Lightspeed.',
   'Kept out of owned and consignment totals and shown separately.')
),
found as (
  select 'paid_far_above_cost'::text code, 'po'::text ref_type, l.id::text ref_id, l.po_number ref_label,
         jsonb_build_object('supplier', l.supplier, 'total_cost', l.total_cost, 'amount_paid', l.amount_paid) detail,
         'amount_paid'::text excluded_value
  from l where l.paid_unreliable
  union all
  select 'paid_above_cost', 'po', l.id::text, l.po_number,
         jsonb_build_object('supplier', l.supplier, 'total_cost', l.total_cost, 'amount_paid', l.amount_paid), null
  from l where not l.paid_unreliable and coalesce(l.amount_paid, 0) > coalesce(l.total_cost, 0) * 1.05 + 1
  union all
  select 'payment_label_mismatch', 'po', l.id::text, l.po_number,
         jsonb_build_object('supplier', l.supplier, 'payment_status', l.payment_status, 'status', l.status,
                            'total_cost', l.total_cost, 'amount_paid', l.amount_paid), 'payment_status'
  from l
  where (l.payment_status = 'Unpaid' and coalesce(l.total_cost, 0) > 0 and coalesce(l.amount_paid, 0) >= l.total_cost - 0.0005)
     or (l.payment_status = 'Paid' and l.balance > 0.0005)
     or (l.payment_status = 'Partial' and (coalesce(l.amount_paid, 0) <= 0 or l.balance <= 0.0005))
  union all
  select 'marked_received_but_short', 'po', l.id::text, l.po_number,
         jsonb_build_object('supplier', l.supplier, 'ordered_qty', l.ordered_qty, 'received_qty', l.received_qty), null
  from l where l.receipt_state = 'marked_full_but_short'
  union all
  select 'supplier_missing', 'po', l.id::text, l.po_number,
         jsonb_build_object('brand', l.brand, 'created_date', l.created_date, 'status', l.status), null
  from l where l.supplier_key is null
  union all
  select 'supplier_spelling', 'supplier', g.supplier_key, g.spellings[1],
         jsonb_build_object('spellings', to_jsonb(g.spellings)), null
  from (select a.supplier_key, array_agg(distinct a.supplier order by a.supplier) spellings
        from world.po_ledger a where a.supplier_key is not null
        group by a.supplier_key having count(distinct a.supplier) > 1) g
  union all
  select 'balance_rounding_residue', 'po', l.id::text, l.po_number,
         jsonb_build_object('supplier', l.supplier, 'balance', l.balance), null
  from l where l.record_class = 'active' and l.balance > 0 and l.balance <= 0.0005
)
select f.code, r.severity, f.ref_type, f.ref_id, f.ref_label, f.detail, f.excluded_value, r.rule, r.exclusion
from found f join rules r using (code)
-- [data_issues:end]
;

revoke all on world.po_ledger, world.data_issues from public, anon, authenticated, service_role;

-- 6. The owner gate ------------------------------------------------------------------
-- Owners are the rows in stock_ai_access (today: the three owners). A direct database
-- session with no API identity (migrations, reconciliation) also passes; nothing coming
-- through the API can, because the API always sets request.jwt.claims.

create or replace function public.world_guard() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if stock_ai_allowed() then
    return;
  end if;
  if session_user = 'postgres' and coalesce(current_setting('request.jwt.claims', true), '') = '' then
    return;
  end if;
  raise exception 'Time Keeper World is limited to the owners.' using errcode = '42501';
end $$;

-- 7. The snapshot: the whole World in one call, from one consistent database snapshot ---

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
                   'at', coalesce(e.source_received_at, e.detected_at), 'timestamp_basis', e.timestamp_basis,
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

-- 8. PO search and detail: every record, current or historical ----------------------

create or replace function public.world_po_search(
  p_query text default null,
  p_record_class text default null,      -- active | cancelled | merged
  p_status text default null,
  p_supplier_key text default null,
  p_from date default null,
  p_to date default null,
  p_limit int default 50,
  p_offset int default 0)
returns jsonb
language plpgsql stable security definer set search_path = public, world as $$
declare
  v_q text := nullif(trim(coalesce(p_query, '')), '');
  v_like text;
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  perform world_guard();
  if p_record_class is not null and p_record_class not in ('active', 'cancelled', 'merged') then
    raise exception 'Unknown record class "%".', p_record_class using errcode = '22023';
  end if;
  v_like := '%' || replace(replace(replace(coalesce(v_q, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return (
    with hits as (
      select l.* from world.po_ledger l
      where (v_q is null
             or l.po_number ilike v_like or l.supplier ilike v_like or l.brand ilike v_like
             or l.supplier_invoice_no ilike v_like
             or exists (select 1 from purchase_order_items i
                        where i.po_id = l.id and (i.sku ilike v_like or i.name ilike v_like)))
        and (p_record_class is null or l.record_class = p_record_class)
        and (p_status is null or l.status = p_status)
        and (p_supplier_key is null or l.supplier_key = p_supplier_key)
        and (p_from is null or l.created_date >= p_from)
        and (p_to is null or l.created_date <= p_to)),
    page as (select * from hits order by created_date desc, po_number, id limit v_limit offset v_offset)
    select jsonb_build_object(
      'total', (select count(*) from hits),
      'limit', v_limit, 'offset', v_offset,
      'generated_at', now(),
      'last_po_sync', (select max(ls_synced_at) from purchase_orders),
      'rows', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', h.id, 'po_number', h.po_number, 'source', h.source, 'record_class', h.record_class,
                 'status', h.status, 'receipt_state', h.receipt_state, 'supplier', h.supplier,
                 'supplier_key', h.supplier_key, 'brand', h.brand, 'outlet', h.outlet,
                 'created_date', h.created_date, 'age_days', h.age_days,
                 'total_cost', h.total_cost, 'amount_paid', h.amount_paid, 'amount_paid_reliable', not h.paid_unreliable,
                 'payment_status', h.payment_status, 'recorded_unpaid', round(h.recorded_unpaid, 3),
                 'ordered_qty', h.ordered_qty, 'received_qty', h.received_qty,
                 'lines', h.lines, 'lines_short', h.lines_short,
                 'merged_into', h.merged_into,
                 'merged_into_po_number', (select t.po_number from purchase_orders t where t.id = h.merged_into),
                 'issues', (select coalesce(jsonb_agg(di.code), '[]'::jsonb) from world.data_issues di
                            where di.ref_type = 'po' and di.ref_id = h.id::text))
                 order by h.created_date desc, h.po_number, h.id), '[]'::jsonb)
               from page h))
  );
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
                         'at', coalesce(e.source_received_at, e.detected_at), 'timestamp_basis', e.timestamp_basis,
                         'actor', e.actor) order by e.detected_at, e.id), '[]'::jsonb)
                       from world.receipt_events e where e.po_id = p_po_id),
    'issues', (select coalesce(jsonb_agg(jsonb_build_object('code', di.code, 'severity', di.severity,
                 'rule', di.rule, 'exclusion', di.exclusion, 'excluded_value', di.excluded_value)), '[]'::jsonb)
               from world.data_issues di where di.ref_type = 'po' and di.ref_id = p_po_id::text),
    'generated_at', now());
end $$;

-- 9. Missions: shared reviewed / snoozed state with full history ---------------------

create or replace function public.world_mission_act(
  p_mission_key text, p_action text, p_snooze_until date default null,
  p_note text default null, p_fingerprint text default null)
returns jsonb
language plpgsql volatile security definer set search_path = public, world as $$
declare
  v_user uuid := auth.uid();
  v_name text;
  v_today date := (now() at time zone 'Asia/Kuwait')::date;
  v_event world.mission_events;
begin
  perform world_guard();
  if v_user is null or not stock_ai_allowed() then
    raise exception 'Only an owner can update a mission.' using errcode = '42501';
  end if;
  if p_action not in ('reviewed', 'snoozed', 'reopened', 'note') then
    raise exception 'Unknown action "%".', p_action using errcode = '22023';
  end if;
  if p_mission_key is null or p_mission_key !~ '^[a-z_]+:.+' or length(p_mission_key) > 240 then
    raise exception 'Not a mission key.' using errcode = '22023';
  end if;
  if p_action = 'snoozed' and (p_snooze_until is null or p_snooze_until <= v_today or p_snooze_until > v_today + 90) then
    raise exception 'Snooze until a date between tomorrow and 90 days from now.' using errcode = '22023';
  end if;
  if p_action = 'note' and nullif(trim(coalesce(p_note, '')), '') is null then
    raise exception 'A note needs some text.' using errcode = '22023';
  end if;

  select coalesce(nullif(trim(full_name), ''), 'Owner') into v_name from profiles where id = v_user;
  insert into world.mission_events (mission_key, action, snooze_until, note, fingerprint, actor, actor_name)
  values (p_mission_key, p_action,
          case when p_action = 'snoozed' then p_snooze_until end,
          nullif(trim(coalesce(p_note, '')), ''), p_fingerprint, v_user, coalesce(v_name, 'Owner'))
  returning * into v_event;
  return to_jsonb(v_event);
end $$;

create or replace function public.world_mission_history(p_mission_key text)
returns jsonb
language plpgsql stable security definer set search_path = public, world as $$
begin
  perform world_guard();
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'action', e.action, 'snooze_until', e.snooze_until, 'note', e.note,
            'by', e.actor_name, 'at', e.at) order by e.at desc, e.id desc), '[]'::jsonb)
          from world.mission_events e where e.mission_key = p_mission_key);
end $$;

-- 10. Permissions: owners reach the World only through these functions ----------------

revoke all on function public.world_guard() from public, anon, authenticated;
revoke all on function public.world_snapshot(text) from public, anon;
revoke all on function public.world_po_search(text, text, text, text, date, date, int, int) from public, anon;
revoke all on function public.world_po_detail(uuid) from public, anon;
revoke all on function public.world_mission_act(text, text, date, text, text) from public, anon;
revoke all on function public.world_mission_history(text) from public, anon;
grant execute on function public.world_snapshot(text) to authenticated;
grant execute on function public.world_po_search(text, text, text, text, date, date, int, int) to authenticated;
grant execute on function public.world_po_detail(uuid) to authenticated;
grant execute on function public.world_mission_act(text, text, date, text, text) to authenticated;
grant execute on function public.world_mission_history(text) to authenticated;
-- service_role is deliberately not granted: nothing server-side needs the World.
revoke all on function public.world_snapshot(text) from service_role;
revoke all on function public.world_po_search(text, text, text, text, date, date, int, int) from service_role;
revoke all on function public.world_po_detail(uuid) from service_role;
revoke all on function public.world_mission_act(text, text, date, text, text) from service_role;
revoke all on function public.world_mission_history(text) from service_role;
