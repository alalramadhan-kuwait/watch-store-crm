-- Purchase orders: one summary a day instead of one notification per change.
--
-- Every PO change (new, status, shipment, payment) used to notify owners and
-- managers on its own — 76 in the last 30 days, most of them from the morning
-- Lightspeed sync. Changes are now collected in po_notify_queue and sent as
-- one "Purchase orders" notification at 09:00 Kuwait, covering everything
-- since the last one. Each kind can still be switched off in Notification
-- settings; the summary itself is the new setting "Daily purchase-order
-- summary".

create table if not exists public.po_notify_queue (
  id bigserial primary key,
  at timestamptz not null default now(),
  po_id uuid not null,
  kind text not null check (kind in ('po_new', 'po_status', 'po_ship', 'po_pay')),
  po_number text,
  brand text,
  supplier text,
  new_value text,
  paid_delta numeric,
  sent_at timestamptz
);
create index if not exists po_notify_queue_unsent on public.po_notify_queue (at) where sent_at is null;
alter table public.po_notify_queue enable row level security;

create or replace function public.trg_po_notify()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  on_kinds text[];
begin
  select coalesce(array_agg(event_type), '{}') into on_kinds
    from notification_settings where event_type like 'po\_%' and enabled;
  -- A kind with no settings row counts as on, as notify_event treats it.
  if TG_OP = 'INSERT' then
    if 'po_new' = any(on_kinds) or not exists (select 1 from notification_settings where event_type = 'po_new') then
      insert into po_notify_queue (po_id, kind, po_number, brand, supplier)
      values (NEW.id, 'po_new', NEW.po_number, NEW.brand, NEW.supplier);
    end if;
  elsif TG_OP = 'UPDATE' then
    if NEW.status is distinct from OLD.status
       and ('po_status' = any(on_kinds) or not exists (select 1 from notification_settings where event_type = 'po_status')) then
      insert into po_notify_queue (po_id, kind, po_number, brand, supplier, new_value)
      values (NEW.id, 'po_status', NEW.po_number, NEW.brand, NEW.supplier, NEW.status);
    end if;
    if NEW.shipment_status is distinct from OLD.shipment_status and NEW.shipment_status is not null
       and ('po_ship' = any(on_kinds) or not exists (select 1 from notification_settings where event_type = 'po_ship')) then
      insert into po_notify_queue (po_id, kind, po_number, brand, supplier, new_value)
      values (NEW.id, 'po_ship', NEW.po_number, NEW.brand, NEW.supplier, NEW.shipment_status);
    end if;
    if ((NEW.amount_paid is distinct from OLD.amount_paid) or (NEW.payment_status is distinct from OLD.payment_status))
       and ('po_pay' = any(on_kinds) or not exists (select 1 from notification_settings where event_type = 'po_pay')) then
      insert into po_notify_queue (po_id, kind, po_number, brand, supplier, new_value, paid_delta)
      values (NEW.id, 'po_pay', NEW.po_number, NEW.brand, NEW.supplier, NEW.payment_status,
              coalesce(NEW.amount_paid, 0) - coalesce(OLD.amount_paid, 0));
    end if;
  end if;
  return null;
end $function$;

-- "2 new · 1 fully received · 2 payments, 8,526 KD · Dennison, Unimatic, Delugs +1"
create or replace function public.send_po_daily()
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  cutoff timestamptz := now();
  parts text[] := '{}';
  n_new int; n_ship int; n_pay int; paid numeric; statuses text; brands text[]; body text;
begin
  if not exists (select 1 from po_notify_queue where sent_at is null and at <= cutoff) then return; end if;

  select count(distinct po_id) filter (where kind = 'po_new'),
         count(distinct po_id) filter (where kind = 'po_ship'),
         count(distinct po_id) filter (where kind = 'po_pay'),
         coalesce(sum(paid_delta) filter (where kind = 'po_pay' and paid_delta > 0), 0)
    into n_new, n_ship, n_pay, paid
    from po_notify_queue where sent_at is null and at <= cutoff;

  -- Each PO counted once, under the status it ended on.
  select string_agg(n || ' ' || lower(s), ' · ' order by n desc, s)
    into statuses
    from (select s, count(*) n from (
            select distinct on (po_id) po_id, new_value s from po_notify_queue
             where sent_at is null and at <= cutoff and kind = 'po_status' and new_value is not null
             order by po_id, at desc, id desc) last group by s) g;

  select array_agg(b order by b) into brands
    from (select distinct coalesce(nullif(trim(brand), ''), supplier) b from po_notify_queue
           where sent_at is null and at <= cutoff and coalesce(nullif(trim(brand), ''), supplier) is not null) x;

  if n_new > 0 then parts := parts || (n_new || ' new'); end if;
  if statuses is not null then parts := parts || statuses; end if;
  if n_ship > 0 then parts := parts || (n_ship || ' shipment update' || case when n_ship > 1 then 's' else '' end); end if;
  if n_pay > 0 then
    parts := parts || (n_pay || ' payment' || case when n_pay > 1 then 's' else '' end
                       || case when paid > 0 then ', ' || to_char(round(paid), 'FM999,999,999') || ' KD' else '' end);
  end if;
  body := array_to_string(parts, ' · ');
  if coalesce(array_length(brands, 1), 0) > 0 then
    body := body || ' · ' || array_to_string(brands[1:4], ', ')
         || case when array_length(brands, 1) > 4 then ' +' || (array_length(brands, 1) - 4) else '' end;
  end if;

  perform notify_event('po_daily', 'Purchase orders — daily summary', body, '#/purchase-orders',
    array['admin', 'manager'], null, null, 'po_daily:' || (now() at time zone 'Asia/Kuwait')::date);

  update po_notify_queue set sent_at = now() where sent_at is null and at <= cutoff;
end $function$;

insert into public.notification_settings (event_type, label, category, enabled, person_target, audience_roles, sort, shop_floor, outlet_scoped)
values ('po_daily', 'Daily purchase-order summary (9:00)', 'Purchasing', true, false, array['admin', 'manager'], 9, false, false)
on conflict (event_type) do nothing;

select cron.schedule('po-daily-summary', '0 6 * * *', 'select public.send_po_daily()');
