-- Every sale kept, and who the customer is.
--
-- The daily Lightspeed sync reads every sale and keeps only the totals, which
-- was the right shape for a revenue figure and the wrong one for anything about
-- a customer. This adds, without touching anything that exists:
--   * a leased token refresh, so two jobs can no longer invalidate each other
--   * lightspeed_sales / lightspeed_sale_items / lightspeed_customers, filled
--     every ten minutes from Lightspeed's version cursor
--   * lightspeed_users: Lightspeed till user → employee, channel, or unassigned
--   * normalize_phone(): one rule for what a phone number is
--   * customers.phone_e164, cases.customer_id, cases.contact_declined,
--     cases.interaction_at, and the backfills that give them their first values
--   * lightspeed_sales_reconciliation, comparing the new rows to the old totals
-- The aggregate tables and the daily sync are unchanged.

-- ── 1. Token refresh is leased ───────────────────────────────────────────
alter table public.lightspeed_auth add column if not exists refresh_lock_until timestamptz;

create or replace function public.lightspeed_token_lease(ttl_seconds int default 60)
returns table (locked boolean, needs_refresh boolean, access_token text, refresh_token text,
               expires_at timestamptz, domain_prefix text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.lightspeed_auth%rowtype;
begin
  select * into a from public.lightspeed_auth where id = 1 for update;
  if a.id is null then return; end if;
  -- fresh enough: hand it straight back
  if a.expires_at is not null and a.expires_at > now() + interval '5 minutes' then
    return query select false, false, a.access_token, a.refresh_token, a.expires_at, a.domain_prefix; return;
  end if;
  -- somebody else is refreshing right now: say so, and hand back what there is
  if a.refresh_lock_until is not null and a.refresh_lock_until > now() then
    return query select true, true, a.access_token, a.refresh_token, a.expires_at, a.domain_prefix; return;
  end if;
  update public.lightspeed_auth set refresh_lock_until = now() + make_interval(secs => ttl_seconds) where id = 1;
  return query select false, true, a.access_token, a.refresh_token, a.expires_at, a.domain_prefix;
end $$;

create or replace function public.lightspeed_token_store(p_access_token text, p_refresh_token text, p_expires_at timestamptz)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.lightspeed_auth
     set access_token = p_access_token, refresh_token = p_refresh_token, expires_at = p_expires_at,
         refresh_lock_until = null, updated_at = now()
   where id = 1;
$$;

create or replace function public.lightspeed_token_release()
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.lightspeed_auth set refresh_lock_until = null where id = 1;
$$;

revoke all on function public.lightspeed_token_lease(int) from public, anon, authenticated;
revoke all on function public.lightspeed_token_store(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.lightspeed_token_release() from public, anon, authenticated;
grant execute on function public.lightspeed_token_lease(int) to service_role;
grant execute on function public.lightspeed_token_store(text, text, timestamptz) to service_role;
grant execute on function public.lightspeed_token_release() to service_role;

-- ── 2. What a phone number is ────────────────────────────────────────────
-- Kuwait is the default: an 8-digit local number, with or without 965 in
-- front, in any punctuation. A number written as international (+ or 00) is
-- kept with its own country code. Bare digits beginning with a country code we
-- recognise are treated as international. Anything else is not a phone number
-- we can match on, and comes back null — the raw text is always kept alongside.
create or replace function public.normalize_phone(raw text)
returns text language plpgsql immutable strict as $$
declare
  s text := btrim(raw);
  d text;
  intl boolean;
  cc text;
begin
  if s = '' then return null; end if;
  intl := s ~ '^(\+|00)';
  d := regexp_replace(s, '[^0-9]', '', 'g');
  if intl and left(d, 2) = '00' then d := substr(d, 3); end if;
  if d = '' then return null; end if;
  if length(d) = 8 and d ~ '^[24569]' then return '+965' || d; end if;
  if length(d) = 11 and left(d, 3) = '965' and substr(d, 4) ~ '^[24569]' then return '+965' || substr(d, 4); end if;
  if intl and length(d) between 8 and 15 then return '+' || d; end if;
  foreach cc in array array['966','971','974','973','968','964','962','961','963','20','91','92','44'] loop
    if left(d, length(cc)) = cc and (length(d) - length(cc)) between 7 and 12 then return '+' || d; end if;
  end loop;
  return null;
end $$;
comment on function public.normalize_phone(text) is
  'E.164 for matching and WhatsApp. Kuwait default; international kept; unrecognisable → null. Mirrored in src/shared/phoneRules.ts.';

-- ── 3. Sync bookkeeping ──────────────────────────────────────────────────
alter table public.lightspeed_sync_log add column if not exists kind text not null default 'stock';
comment on column public.lightspeed_sync_log.kind is 'stock (daily products/stock/aggregates), sales (10-minute transactions), reconcile';

create table if not exists public.lightspeed_sync_state (
  kind            text primary key,          -- 'sales' | 'customers'
  cursor          bigint not null default 0, -- Lightspeed version last fully stored
  last_run_at     timestamptz,
  last_success_at timestamptz,
  last_error      text,
  rows_last_run   integer,
  caught_up       boolean not null default false
);
alter table public.lightspeed_sync_state enable row level security;
create policy "read_authed_sync_state" on public.lightspeed_sync_state for select to authenticated using (true);
grant select on public.lightspeed_sync_state to authenticated;

-- ── 4. Transactions ──────────────────────────────────────────────────────
create table if not exists public.lightspeed_sales (
  id               text primary key,        -- Lightspeed sale id: the idempotency key
  outlet_id        text,
  outlet           text,                    -- name, as lightspeed_sales_daily keys it
  register_id      text,
  register         text,
  user_id          text,                    -- Lightspeed till user (see lightspeed_users)
  customer_id      text,                    -- Lightspeed customer (see lightspeed_customers)
  invoice_number   text,
  receipt_number   text,
  status           text not null,           -- CLOSED, VOIDED, SAVED, ONACCOUNT, ONACCOUNT_CLOSED …
  state            text,
  source           text,
  return_for       text,                    -- the sale this one returns
  note             text,
  total_price      numeric,
  total_tax        numeric,
  total_price_incl numeric,
  total_loyalty    numeric,
  sale_date        timestamptz not null,    -- when it was rung up, as Lightspeed records it
  sale_day         date not null,           -- the Kuwait day it belongs to
  ls_created_at    timestamptz,
  ls_updated_at    timestamptz,
  ls_deleted_at    timestamptz,
  version          bigint not null,
  line_count       integer,
  payments         jsonb not null default '[]'::jsonb,
  synced_at        timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists lightspeed_sales_day_outlet_idx on public.lightspeed_sales (sale_day, outlet);
create index if not exists lightspeed_sales_customer_idx  on public.lightspeed_sales (customer_id);
create index if not exists lightspeed_sales_user_idx      on public.lightspeed_sales (user_id);
create index if not exists lightspeed_sales_date_idx      on public.lightspeed_sales (sale_date);

create table if not exists public.lightspeed_sale_items (
  id             text primary key,          -- Lightspeed line id
  sale_id        text not null references public.lightspeed_sales (id) on delete cascade,
  product_id     text,
  sku            text,                      -- written at sync time, so a retired product still reads
  name           text,
  brand          text,
  quantity       numeric not null,
  price          numeric,
  price_total    numeric,                   -- what the daily aggregate sums
  discount_total numeric,
  tax_total      numeric,
  is_return      boolean not null default false,
  status         text,
  salesperson_id text,                      -- Lightspeed's per-line salesperson, when one is set
  sequence       integer,
  synced_at      timestamptz not null default now()
);
create index if not exists lightspeed_sale_items_sale_idx    on public.lightspeed_sale_items (sale_id);
create index if not exists lightspeed_sale_items_product_idx on public.lightspeed_sale_items (product_id);

create table if not exists public.lightspeed_customers (
  id                     text primary key,
  customer_code          text,
  name                   text,
  first_name             text,
  last_name              text,
  mobile                 text,
  phone                  text,
  phone_e164             text generated always as (public.normalize_phone(coalesce(mobile, phone))) stored,
  email                  text,
  date_of_birth          date,
  do_not_email           boolean not null default false,
  enable_promotional_sms boolean not null default false,
  privacy_consent        boolean not null default false,
  customer_group_id      text,
  year_to_date           numeric,
  ls_created_at          timestamptz,
  ls_updated_at          timestamptz,
  ls_deleted_at          timestamptz,
  version                bigint not null,
  synced_at              timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists lightspeed_customers_phone_idx on public.lightspeed_customers (phone_e164);

alter table public.lightspeed_sales      enable row level security;
alter table public.lightspeed_sale_items enable row level security;
alter table public.lightspeed_customers  enable row level security;
-- Sales read like the other Lightspeed tables. Customers carry names and
-- numbers, so until Stage B defines who may see whom, only management reads them.
create policy "read_authed_sales"      on public.lightspeed_sales      for select to authenticated using (true);
create policy "read_authed_sale_items" on public.lightspeed_sale_items for select to authenticated using (true);
create policy "read_managers_customers" on public.lightspeed_customers for select to authenticated
  using (public.get_my_role() = any (array['admin','manager']));
grant select on public.lightspeed_sales, public.lightspeed_sale_items, public.lightspeed_customers to authenticated;

-- ── 5. Who a Lightspeed user is ──────────────────────────────────────────
-- Not by name. Three of the seven salespeople are spelt differently in
-- Lightspeed than in employees, and the online-orders account is not a person.
create table if not exists public.lightspeed_users (
  lightspeed_user_id text primary key,
  display_name       text not null,
  account_type       text,
  kind               text not null default 'unassigned' check (kind in ('employee','channel','unassigned')),
  employee_id        uuid references public.employees (id),
  channel_code       text references public.outlets (code),
  note               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint lightspeed_users_kind_target check (
    (kind = 'employee'   and employee_id is not null and channel_code is null) or
    (kind = 'channel'    and channel_code is not null and employee_id is null) or
    (kind = 'unassigned' and employee_id is null and channel_code is null))
);
alter table public.lightspeed_users enable row level security;
create policy "read_authed_ls_users"  on public.lightspeed_users for select to authenticated using (true);
create policy "admin_writes_ls_users" on public.lightspeed_users for all to authenticated
  using (public.get_my_role() = 'admin') with check (public.get_my_role() = 'admin');
grant select, insert, update, delete on public.lightspeed_users to authenticated;

insert into public.lightspeed_users (lightspeed_user_id, display_name, account_type, kind, employee_id, channel_code, note) values
  ('e9dd140a-8cb3-4bba-9308-43502a8483d7', 'Ahmed Khalaf',       'cashier', 'employee', (select id from public.employees where full_name = 'Ahmed Khalaf'),   null, null),
  ('b835ce35-d780-49f7-b1c3-c1152eb93fe3', 'Husain Deeb',        'manager', 'employee', (select id from public.employees where full_name = 'Hussein Deeb'),   null, 'Lightspeed spells it Husain'),
  ('bc8d11a1-5408-48ad-987d-082795e77559', 'Ahmed Yasari',       'cashier', 'employee', (select id from public.employees where full_name = 'Ahmed Yasari'),   null, null),
  ('92da5dcb-3d49-4626-8b74-58300c4bc23b', 'Ranin Alsamad',      'cashier', 'employee', (select id from public.employees where full_name = 'Ranin Al Samad'), null, 'Lightspeed spells it Alsamad'),
  ('6214222b-328f-4d93-afce-d37c82da3324', 'Eman Salman',        'admin',   'employee', (select id from public.employees where full_name = 'Eman Salman'),    null, null),
  ('048a1729-49dd-4a54-b358-4520ef99b740', 'Fadi Husain',        'cashier', 'employee', (select id from public.employees where full_name = 'Fadi Hussain'),   null, 'Lightspeed spells it Husain'),
  ('d7211188-83a4-488c-995a-cc472520897c', 'Ali Akbar Modi',     'manager', 'employee', (select id from public.employees where full_name = 'Ali Akbar Modi'), null, null),
  ('ed8fb3b4-2310-4144-84c0-49aed7bc99f5', 'TK - Online Orders', 'cashier', 'channel',  null, 'online', 'The web shop''s own till account, not a person'),
  ('06819b3a-2e91-11ec-fa85-4546c4fd7a1b', 'Time Keeper',        'admin',   'unassigned', null, null, 'The store''s Lightspeed admin account; 1 sale in 90 days'),
  ('614fb558-971a-4a89-98e6-ae273d2f6a23', 'Ali AlYousifi',      'admin',   'unassigned', null, null, 'Owner account, no sales'),
  ('f7665040-1725-4fc2-b72c-6bcb61457dc5', 'Mohamed Alyousifi',  'admin',   'unassigned', null, null, 'Owner account, no sales'),
  ('b8855db8-50bd-44c3-9f95-1b8f02528c6c', 'Ali AlRamadhan',     'admin',   'unassigned', null, null, 'Owner account, no sales'),
  ('a0e03090-578e-4961-946e-14922b6f82bc', 'Rayan Saeed',        'cashier', 'unassigned', null, null, 'No sales in 90 days; not in employees'),
  ('0add29e6-a21b-4b4a-862d-3707ac3668de', 'Pravin',             'manager', 'unassigned', null, null, 'No sales in 90 days; not in employees'),
  ('2b0866b5-36e7-45b2-a723-97a6855f53b2', 'M  Al Fadly',        'manager', 'unassigned', null, null, 'No sales in 90 days; not in employees')
on conflict (lightspeed_user_id) do nothing;

-- ── 6. Customer identity in the DSR ──────────────────────────────────────
alter table public.customers add column if not exists phone_e164 text
  generated always as (public.normalize_phone(contact)) stored;
alter table public.customers add column if not exists lightspeed_customer_id text unique;
create unique index if not exists customers_phone_e164_key on public.customers (phone_e164) where phone_e164 is not null;

alter table public.cases add column if not exists customer_id      uuid references public.customers (id);
alter table public.cases add column if not exists contact_declined boolean not null default false;
alter table public.cases add column if not exists interaction_at   timestamptz;
create index if not exists cases_customer_idx on public.cases (customer_id);
create index if not exists cases_interaction_at_idx on public.cases (interaction_at);
comment on column public.cases.interaction_at is 'When the customer was actually here. created_at is when the entry was saved.';
comment on column public.cases.contact_declined is 'The customer declined to give a name or number; saving without them is honest, not incomplete.';

-- A customer record for every distinct phone found in the cases so far. The
-- display form of the contact stays the 8-digit local number for Kuwait,
-- because that is what every existing record and every existing screen uses.
insert into public.customers (contact, display_name)
select distinct on (n.e164)
       case when n.e164 like '+965%' then substr(n.e164, 5) else n.e164 end,
       n.name
  from (select public.normalize_phone(c.contact) as e164,
               nullif(btrim(c.customer_name), '') as name, c.created_at
          from public.cases c
         where c.deleted = false and c.contact is not null) n
 where n.e164 is not null
   and not exists (select 1 from public.customers x where x.phone_e164 = n.e164)
 order by n.e164, (n.name is null), n.created_at desc
on conflict (contact) do nothing;

update public.cases c
   set customer_id = x.id
  from public.customers x
 where c.customer_id is null
   and c.contact is not null
   and public.normalize_phone(c.contact) = x.phone_e164;

-- From now on a new entry whose number is already known links itself. Nothing
-- is created here — whether an unknown number becomes a customer record is a
-- decision for the screen that asks for it.
create or replace function public.cases_link_customer()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare e text;
begin
  if new.customer_id is null and new.contact is not null then
    e := public.normalize_phone(new.contact);
    if e is not null then
      select id into new.customer_id from public.customers where phone_e164 = e limit 1;
    end if;
  end if;
  if new.interaction_at is null then new.interaction_at := coalesce(new.created_at, now()); end if;
  return new;
end $$;
drop trigger if exists cases_link_customer on public.cases;
create trigger cases_link_customer before insert or update of contact, customer_id on public.cases
  for each row execute function public.cases_link_customer();

-- The visit time for everything already logged: the time the device wrote,
-- read as Kuwait local, which is how it was entered.
update public.cases
   set interaction_at = case
         when time_logged ~ '^\d{1,2}:\d{2}'
           then ((date_logged::text || ' ' || time_logged)::timestamp at time zone 'Asia/Kuwait')
         else created_at end
 where interaction_at is null;
alter table public.cases alter column interaction_at set default now();
alter table public.cases alter column interaction_at set not null;

-- ── 7. Do the new rows agree with the old totals? ────────────────────────
-- The same rule the daily sync applies: voids and unpaid baskets are not
-- revenue; layby and on-account are. Revenue is the sum of line price_total.
create or replace view public.lightspeed_sales_reconciliation with (security_invoker = true) as
with txn as (
  select s.outlet, s.sale_day,
         round(coalesce(sum(i.price_total), 0), 3) as revenue,
         coalesce(sum(i.quantity), 0)             as units,
         count(distinct s.id)                     as sale_count
    from public.lightspeed_sales s
    left join public.lightspeed_sale_items i on i.sale_id = s.id
   where s.outlet is not null
     and coalesce(s.status, '') !~ 'VOID|SAVED|PARKED|AWAITING'
   group by s.outlet, s.sale_day)
select coalesce(a.outlet, t.outlet)         as outlet,
       coalesce(a.sale_date, t.sale_day)    as sale_date,
       a.revenue                            as agg_revenue,
       t.revenue                            as txn_revenue,
       round(coalesce(t.revenue, 0) - coalesce(a.revenue, 0), 3) as delta_revenue,
       a.sale_count                         as agg_sales,
       t.sale_count                         as txn_sales,
       a.units                              as agg_units,
       t.units                              as txn_units,
       a.synced_at                          as agg_synced_at
  from public.lightspeed_sales_daily a
  full join txn t on t.outlet = a.outlet and t.sale_day = a.sale_date;
grant select on public.lightspeed_sales_reconciliation to authenticated;

-- Days before the last daily run only: after it, transactions are simply
-- ahead of the totals until 08:00 comes round again, which is not a mismatch.
create or replace function public.lightspeed_reconcile(p_days int default 60)
returns jsonb language sql stable as $$
  with cutoff as (
    select coalesce((max(started_at) at time zone 'Asia/Kuwait')::date, current_date) as day
      from public.lightspeed_sync_log where kind = 'stock' and status = 'ok'),
  r as (
    select * from public.lightspeed_sales_reconciliation, cutoff
     where sale_date >= current_date - p_days and sale_date < cutoff.day)
  select jsonb_build_object(
    'window_days', p_days,
    'compared_until', (select day from cutoff),
    'days_compared', count(*),
    'days_matching', count(*) filter (where abs(delta_revenue) < 0.005 and coalesce(agg_sales,0) = coalesce(txn_sales,0)),
    'days_off',      count(*) filter (where abs(delta_revenue) >= 0.005 or coalesce(agg_sales,0) <> coalesce(txn_sales,0)),
    'total_agg_revenue', round(coalesce(sum(agg_revenue), 0), 3),
    'total_txn_revenue', round(coalesce(sum(txn_revenue), 0), 3),
    'max_abs_delta', coalesce(max(abs(delta_revenue)), 0),
    'off_days', coalesce((select jsonb_agg(jsonb_build_object('outlet', outlet, 'date', sale_date,
                          'agg', agg_revenue, 'txn', txn_revenue, 'delta', delta_revenue,
                          'agg_sales', agg_sales, 'txn_sales', txn_sales) order by abs(delta_revenue) desc)
                  from (select * from r where abs(delta_revenue) >= 0.005 or coalesce(agg_sales,0) <> coalesce(txn_sales,0) limit 30) o), '[]'::jsonb))
  from r;
$$;

create or replace function public.lightspeed_reconcile_log()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  r := public.lightspeed_reconcile(60);
  insert into public.lightspeed_sync_log (kind, status, started_at, finished_at, error)
  values ('reconcile',
          case when (r->>'days_off')::int = 0 then 'ok' else 'mismatch' end,
          now(), now(),
          case when (r->>'days_off')::int = 0 then null
               else left(format('%s of %s days differ; largest %s', r->>'days_off', r->>'days_compared', r->>'max_abs_delta'), 500) end);
  return r;
end $$;

-- ── 8. Schedules ─────────────────────────────────────────────────────────
select cron.schedule('lightspeed-sales-sync', '*/10 * * * *', $cron$
  select net.http_post(
    url := 'https://ttshgrujnycapugrmyxs.supabase.co/functions/v1/lightspeed-sales-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-sync-key', (select sync_key from public.lightspeed_auth where id = 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000)
$cron$);
-- twenty minutes after the daily totals are rebuilt at 08:00 Kuwait
select cron.schedule('lightspeed-reconcile', '20 5 * * *', $cron$ select public.lightspeed_reconcile_log() $cron$);
