-- Stock analyst, Phase 1: foundations. Additive only.
--
-- New tables, new functions and three new scheduled jobs. No existing table,
-- function, policy or job is altered, and nothing here touches the tables the
-- Lightspeed syncs write (it only reads lightspeed_stock / lightspeed_stock_cost).
-- The chat itself stays off (ai_settings.chat_enabled = false) until its
-- calculations pass validation.
--
-- Rollback: supabase/rollbacks/20261008120016_stock_analyst_foundations.down.sql

-- 1. What a product is, as Lightspeed says ----------------------------------

-- Lightspeed's 13 product types, grouped by who owns the stock. A rule over
-- Lightspeed's type names, never over individual products: a product's type is
-- corrected in Lightspeed. A type Lightspeed adds later lands in 'unknown' and
-- shows up in answers until it is placed here.
create function public.stock_ownership(p_type text) returns text
language sql immutable parallel safe as $$
  select case
    when p_type is null then 'unknown'
    when lower(p_type) in ('consignment watches', 'consignment accessories') then 'consignment'
    when lower(p_type) in ('pre-owned watches', 'pre-owned accessories') then 'pre_owned'
    when lower(p_type) in ('services', 'discount') then 'service'
    when lower(p_type) in ('watches', 'straps', 'accessories', 'books', 'car models', 'clock', 'damaged products') then 'owned'
    else 'unknown'
  end
$$;

create table public.lightspeed_products (
  product_id        text primary key,
  name              text,
  sku               text,
  brand             text,
  supplier          text,
  product_type_id   text,
  product_type      text,
  ownership         text generated always as (public.stock_ownership(product_type)) stored,
  variant_parent_id text,
  is_active         boolean,
  has_inventory     boolean,
  ls_created_at     timestamptz,
  ls_updated_at     timestamptz,
  first_seen_at     timestamptz not null default now(),
  synced_at         timestamptz not null default now()
);
create index lightspeed_products_type_idx on public.lightspeed_products (product_type);

-- 2. Run log for the analyst's own jobs --------------------------------------
-- Kept apart from lightspeed_sync_log, whose newest row the back office shows
-- as "last synced".
create table public.stock_analyst_runs (
  id          bigint generated always as identity primary key,
  job         text not null check (job in ('products', 'snapshot')),
  status      text not null check (status in ('running', 'ok', 'skipped', 'already_taken', 'error')),
  detail      jsonb not null default '{}',
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index stock_analyst_runs_job_idx on public.stock_analyst_runs (job, started_at desc);

-- 3. Daily stock snapshots: what Lightspeed actually reported -----------------
-- One row per product and outlet with stock other than zero, copied from the
-- morning stock sync. No row for a product that day means it had none there.
-- Only ever written from a complete sync; nothing reconstructed goes in here.
create table public.lightspeed_stock_snapshots (
  snapshot_date   date not null,
  product_id      text not null,
  outlet          text not null,
  quantity        numeric not null,
  cost            numeric,
  price           numeric,
  product_type    text,
  ownership       text not null,
  stock_synced_at timestamptz not null,
  taken_at        timestamptz not null default now(),
  primary key (snapshot_date, product_id, outlet)
);
create index lightspeed_stock_snapshots_product_idx on public.lightspeed_stock_snapshots (product_id, snapshot_date);

-- Takes today's snapshot once, and only from a finished, consistent sync:
-- every stock and cost row stamped by the same run, that run from today
-- (Kuwait), and at least five minutes old. Otherwise it records why it
-- skipped; the 07:45 run tries again. A copy that turns out to straddle two
-- syncs is thrown away rather than kept.
create function public.take_stock_snapshot() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d      date := (now() at time zone 'Asia/Kuwait')::date;
  s_min  timestamptz; s_max timestamptz; c_min timestamptz; c_max timestamptz;
  src    record; got record; reason text; res jsonb;
begin
  if exists (select 1 from lightspeed_stock_snapshots where snapshot_date = d) then
    insert into stock_analyst_runs (job, status, detail, finished_at)
      values ('snapshot', 'already_taken', jsonb_build_object('date', d), now());
    return jsonb_build_object('status', 'already_taken', 'date', d);
  end if;

  select min(synced_at), max(synced_at) into s_min, s_max from lightspeed_stock;
  select min(synced_at), max(synced_at) into c_min, c_max from lightspeed_stock_cost;
  reason := case
    when s_max is null then 'no stock rows'
    when s_min <> s_max then 'stock table holds two syncs (sync running or failed part way)'
    when c_min is distinct from c_max or c_max is distinct from s_max then 'cost table does not match the stock sync'
    when (s_max at time zone 'Asia/Kuwait')::date <> d then 'no stock sync yet today'
    when s_max > now() - interval '5 minutes' then 'stock sync finished under five minutes ago'
  end;
  if reason is not null then
    insert into stock_analyst_runs (job, status, detail, finished_at)
      values ('snapshot', 'skipped', jsonb_build_object('date', d, 'reason', reason, 'stock_synced_at', s_max), now());
    return jsonb_build_object('status', 'skipped', 'date', d, 'reason', reason);
  end if;

  begin
    select count(*) n, coalesce(sum(s.stock_on_hand), 0) units,
           coalesce(sum(s.stock_on_hand * c.cost), 0) cost_value
      into src
      from lightspeed_stock s left join lightspeed_stock_cost c using (product_id, outlet)
     where s.stock_on_hand <> 0;

    insert into lightspeed_stock_snapshots
      (snapshot_date, product_id, outlet, quantity, cost, price, product_type, ownership, stock_synced_at)
    select d, s.product_id, s.outlet, s.stock_on_hand, c.cost, s.price, p.product_type,
           coalesce(p.ownership, 'unknown'), s.synced_at
      from lightspeed_stock s
      left join lightspeed_stock_cost c using (product_id, outlet)
      left join lightspeed_products p using (product_id)
     where s.stock_on_hand <> 0;

    select count(*) n, coalesce(sum(quantity), 0) units, coalesce(sum(quantity * cost), 0) cost_value,
           count(*) filter (where stock_synced_at <> s_max) foreign_rows,
           count(*) filter (where ownership = 'unknown') unknown_rows
      into got from lightspeed_stock_snapshots where snapshot_date = d;

    if got.foreign_rows > 0 or got.n <> src.n or got.units <> src.units then
      raise exception 'snapshot did not match its source (rows % vs %, units % vs %, rows from another sync %)',
        got.n, src.n, got.units, src.units, got.foreign_rows;
    end if;

    res := jsonb_build_object('status', 'ok', 'date', d, 'stock_synced_at', s_max,
      'rows', got.n, 'units', got.units, 'cost_value', round(got.cost_value, 3),
      'source_rows', src.n, 'source_units', src.units, 'source_cost_value', round(src.cost_value, 3),
      'unknown_ownership_rows', got.unknown_rows);
    insert into stock_analyst_runs (job, status, detail, finished_at) values ('snapshot', 'ok', res, now());
    return res;
  exception when others then
    -- the insert above is undone with this block; record why
    insert into stock_analyst_runs (job, status, detail, finished_at)
      values ('snapshot', 'error', jsonb_build_object('date', d, 'error', sqlerrm), now());
    return jsonb_build_object('status', 'error', 'date', d, 'error', sqlerrm);
  end;
end $$;

-- 4. Who may use the stock analyst --------------------------------------------
-- Owner only to start with. Being an admin does not grant it; a row here does.
create table public.stock_ai_access (
  user_id    uuid primary key,
  granted_at timestamptz not null default now(),
  granted_by text not null,
  note       text
);

create function public.stock_ai_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from stock_ai_access where user_id = auth.uid())
$$;

insert into public.stock_ai_access (user_id, granted_by, note)
select id, 'Phase 1 migration', 'Owner (Ali Alramadhan)' from auth.users where email = 'ajr015@time-keeper.com';

-- 5. Settings and one combined AI budget --------------------------------------
create table public.ai_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.ai_settings (key, value) values
  ('monthly_cap_usd', '15'),
  ('warn_fraction',   '0.8'),
  ('chat_enabled',    'false');

-- Every AI call, from either provider and for any purpose (testing, retries,
-- production), is reserved here before it is made and settled with its real
-- cost after. Reservations count against the month at their maximum until
-- settled, so the cap holds even if a call never reports back.
create table public.ai_usage_ledger (
  id                  bigint generated always as identity primary key,
  created_at          timestamptz not null default now(),
  month               date not null default (date_trunc('month', now() at time zone 'Asia/Kuwait'))::date,
  user_id             uuid,
  provider            text not null check (provider in ('anthropic', 'openai')),
  model               text not null,
  purpose             text not null check (purpose in ('production', 'retry', 'test')),
  status              text not null default 'reserved' check (status in ('reserved', 'settled', 'failed')),
  reserved_usd        numeric(12,6) not null check (reserved_usd >= 0),
  cost_usd            numeric(12,6) check (cost_usd >= 0),
  input_tokens        integer,
  cached_input_tokens integer,
  cache_write_tokens  integer,
  output_tokens       integer,
  message_id          uuid,
  settled_at          timestamptz
);
create index ai_usage_ledger_month_idx on public.ai_usage_ledger (month);

create function public.ai_budget_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m date := (date_trunc('month', now() at time zone 'Asia/Kuwait'))::date;
        cap numeric; warn numeric; spent numeric; held numeric;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not stock_ai_allowed() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select (value #>> '{}')::numeric into cap from ai_settings where key = 'monthly_cap_usd';
  select (value #>> '{}')::numeric into warn from ai_settings where key = 'warn_fraction';
  select coalesce(sum(cost_usd) filter (where status in ('settled', 'failed')), 0),
         coalesce(sum(reserved_usd) filter (where status = 'reserved'), 0)
    into spent, held from ai_usage_ledger where month = m;
  return jsonb_build_object('month', m, 'cap_usd', cap, 'spent_usd', round(spent, 4), 'reserved_usd', round(held, 4),
    'remaining_usd', round(greatest(cap - spent - held, 0), 4),
    'warn', spent + held >= cap * warn, 'blocked', spent + held >= cap);
end $$;

-- Reserve the most a call can cost. Returns the ledger id, or null when the
-- month's cap would be passed. One at a time, so two calls cannot both squeeze
-- under the cap.
create function public.ai_budget_reserve(p_provider text, p_model text, p_purpose text, p_max_usd numeric,
                                         p_user uuid default null, p_message uuid default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare m date := (date_trunc('month', now() at time zone 'Asia/Kuwait'))::date;
        cap numeric; used numeric; new_id bigint;
begin
  if p_max_usd is null or p_max_usd <= 0 then raise exception 'a reservation needs a positive maximum'; end if;
  perform pg_advisory_xact_lock(hashtext('ai_budget'));
  select (value #>> '{}')::numeric into cap from ai_settings where key = 'monthly_cap_usd';
  select coalesce(sum(case when status = 'reserved' then reserved_usd else coalesce(cost_usd, 0) end), 0)
    into used from ai_usage_ledger where month = m;
  if used + p_max_usd > cap then return null; end if;
  insert into ai_usage_ledger (user_id, provider, model, purpose, reserved_usd, message_id)
    values (p_user, p_provider, p_model, p_purpose, p_max_usd, p_message)
    returning id into new_id;
  return new_id;
end $$;

-- Settle a reservation with what the provider actually reported.
create function public.ai_budget_settle(p_id bigint, p_cost_usd numeric, p_input integer, p_cached integer,
                                        p_cache_write integer, p_output integer, p_ok boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  update ai_usage_ledger
     set status = case when p_ok then 'settled' else 'failed' end,
         cost_usd = greatest(coalesce(p_cost_usd, 0), 0),
         input_tokens = p_input, cached_input_tokens = p_cached, cache_write_tokens = p_cache_write,
         output_tokens = p_output, settled_at = now()
   where id = p_id and status = 'reserved';
end $$;

-- 6. Conversations, what was run, and feedback --------------------------------
create table public.ai_conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  language   text,
  context    jsonb not null default '{}',
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ai_conversations_user_idx on public.ai_conversations (user_id, updated_at desc);

-- Each turn keeps what it understood, the calculations it ran with their
-- results, and its grounding checks: enough to reproduce any answer exactly.
create table public.ai_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations (id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  understood      jsonb,
  calls           jsonb,
  results         jsonb,
  checks          jsonb,
  model           text,
  created_at      timestamptz not null default now()
);
create index ai_messages_conversation_idx on public.ai_messages (conversation_id, created_at);

create table public.ai_feedback (
  id          bigint generated always as identity primary key,
  message_id  uuid not null references public.ai_messages (id) on delete cascade,
  user_id     uuid not null default auth.uid(),
  verdict     text not null check (verdict in ('right', 'wrong')),
  reasons     text[] not null default '{}'
              check (reasons <@ array['wrong_number', 'wrong_reason', 'misunderstood', 'bad_advice']::text[]),
  note        text check (char_length(note) <= 1000),
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz,
  resolution  text,
  unique (message_id, user_id)
);

-- 7. Who can see what ----------------------------------------------------------
-- Nothing new is visible to anon. Signed-in users see rows only when they are
-- on stock_ai_access, and only their own conversations. Writes come from the
-- backend (service role), except a feedback vote on one's own answer.
alter table public.lightspeed_products        enable row level security;
alter table public.stock_analyst_runs         enable row level security;
alter table public.lightspeed_stock_snapshots enable row level security;
alter table public.stock_ai_access            enable row level security;
alter table public.ai_settings                enable row level security;
alter table public.ai_usage_ledger            enable row level security;
alter table public.ai_conversations           enable row level security;
alter table public.ai_messages                enable row level security;
alter table public.ai_feedback                enable row level security;

revoke all on public.lightspeed_products, public.stock_analyst_runs, public.lightspeed_stock_snapshots,
              public.stock_ai_access, public.ai_settings, public.ai_usage_ledger,
              public.ai_conversations, public.ai_messages, public.ai_feedback
  from anon, authenticated;
grant select on public.lightspeed_products, public.stock_analyst_runs, public.lightspeed_stock_snapshots,
                public.ai_usage_ledger, public.ai_conversations, public.ai_messages, public.ai_feedback
  to authenticated;
grant insert (message_id, verdict, reasons, note), update (verdict, reasons, note) on public.ai_feedback to authenticated;

create policy owner_reads on public.lightspeed_products        for select to authenticated using (public.stock_ai_allowed());
create policy owner_reads on public.stock_analyst_runs         for select to authenticated using (public.stock_ai_allowed());
create policy owner_reads on public.lightspeed_stock_snapshots for select to authenticated using (public.stock_ai_allowed());
create policy owner_reads on public.ai_usage_ledger            for select to authenticated using (public.stock_ai_allowed());
create policy own_conversations on public.ai_conversations for select to authenticated
  using (user_id = auth.uid() and public.stock_ai_allowed());
create policy own_messages on public.ai_messages for select to authenticated
  using (public.stock_ai_allowed() and exists (
    select 1 from public.ai_conversations c where c.id = conversation_id and c.user_id = auth.uid()));
create policy own_feedback_read on public.ai_feedback for select to authenticated
  using (user_id = auth.uid() and public.stock_ai_allowed());
create policy own_feedback_write on public.ai_feedback for insert to authenticated
  with check (user_id = auth.uid() and public.stock_ai_allowed() and exists (
    select 1 from public.ai_messages m join public.ai_conversations c on c.id = m.conversation_id
     where m.id = message_id and m.role = 'assistant' and c.user_id = auth.uid()));
create policy own_feedback_change on public.ai_feedback for update to authenticated
  using (user_id = auth.uid() and public.stock_ai_allowed())
  with check (user_id = auth.uid() and public.stock_ai_allowed());

revoke all on function public.take_stock_snapshot()                                            from public, anon, authenticated;
revoke all on function public.ai_budget_reserve(text, text, text, numeric, uuid, uuid)        from public, anon, authenticated;
revoke all on function public.ai_budget_settle(bigint, numeric, integer, integer, integer, integer, boolean) from public, anon, authenticated;
revoke all on function public.ai_budget_status()                                               from public, anon;
revoke all on function public.stock_ai_allowed()                                               from public, anon;
grant execute on function public.take_stock_snapshot()                                         to service_role;
grant execute on function public.ai_budget_reserve(text, text, text, numeric, uuid, uuid)     to service_role;
grant execute on function public.ai_budget_settle(bigint, numeric, integer, integer, integer, integer, boolean) to service_role;
grant execute on function public.ai_budget_status()                                            to authenticated, service_role;
grant execute on function public.stock_ai_allowed()                                            to authenticated, service_role;

-- 8. Schedule ---------------------------------------------------------------------
-- After the 05:00 stock sync (done by ~05:01), the 05:05 PO sync and the 05:20
-- reconcile; the snapshot follows the type sync so it carries today's types.
select cron.schedule('lightspeed-products-sync', '35 5 * * *', $job$
  select net.http_post(
    url := 'https://ttshgrujnycapugrmyxs.supabase.co/functions/v1/lightspeed-products-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-sync-key', (select sync_key from public.lightspeed_auth where id = 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000)
$job$);
select cron.schedule('stock-snapshot',       '45 5 * * *', $job$ select public.take_stock_snapshot() $job$);
select cron.schedule('stock-snapshot-retry', '45 7 * * *', $job$ select public.take_stock_snapshot() $job$);
