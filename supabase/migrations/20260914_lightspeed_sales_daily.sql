-- Till revenue per outlet per day, written by the morning lightspeed-sync.
--
-- The dashboard's sales figures were built from CRM cases — deals staff log by
-- hand — which is a pipeline, not revenue. Measured over the same month the two
-- did not agree: 24,905 KD logged against 58,082 KD that actually rang through.
-- This is the till.
create table if not exists public.lightspeed_sales_daily (
  outlet      text        not null,
  sale_date   date        not null,
  revenue     numeric     not null default 0,
  units       numeric     not null default 0,
  sale_count  integer     not null default 0,
  synced_at   timestamptz not null default now(),
  primary key (outlet, sale_date)
);

comment on table public.lightspeed_sales_daily is
  'Lightspeed till revenue aggregated per outlet per Kuwait day (UTC+3). Written by the lightspeed-sync edge function; net of returns, voided sales excluded.';

create index if not exists lightspeed_sales_daily_date_idx
  on public.lightspeed_sales_daily (sale_date desc);

alter table public.lightspeed_sales_daily enable row level security;

-- same posture as the other lightspeed tables: any signed-in user may read,
-- only the service role (the sync) writes
drop policy if exists read_authed_sales_daily on public.lightspeed_sales_daily;
create policy read_authed_sales_daily
  on public.lightspeed_sales_daily for select
  using (auth.role() = 'authenticated');

-- Lightspeed has three outlets, not two: Time Keeper is the busiest of them and
-- had no card and no target of its own.
alter table public.settings
  add column if not exists sales_target_timekeeper numeric;
