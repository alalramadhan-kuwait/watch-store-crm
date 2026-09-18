-- Paid ads figures from Meta, kept exactly as Meta reports them.
--
-- The Paid Ads Tracker has always been typed in by hand: an ad name, a budget,
-- a status. What the campaign actually did — spend, impressions, reach, clicks,
-- CTR, CPC, CPM, results — lived only in Ads Manager.
--
-- Meta is the source of truth for those figures, so every one of them is stored
-- as TEXT, exactly the string Meta sent. Numeric columns would invite the
-- database to round them, and a number parsed to a float and printed again is
-- no longer "what Meta said". Nothing here is computed: ctr, cpc and cpm are
-- Meta's own fields, not spend/impressions arithmetic, and no currency is
-- converted. The whole response row is kept in `raw` so a question about any
-- figure can be answered from what actually arrived.

-- Which account we read. Not a secret — the token is — so it lives here rather
-- than in Edge Function secrets, leaving exactly one secret to set by hand.
create table if not exists public.meta_ads_config (
  id             int primary key default 1 check (id = 1),
  account_id     text not null,
  account_name   text,
  currency       text,
  timezone_name  text,
  last_synced_at timestamptz,
  last_error     text,
  updated_at     timestamptz not null default now()
);

comment on table public.meta_ads_config is
  'The Meta ad account the Paid Ads Tracker reads. currency and timezone_name are the account''s own, read back from Meta — figures are displayed in that currency, never converted.';

insert into public.meta_ads_config (id, account_id) values (1, '140760819')
  on conflict (id) do nothing;

create table if not exists public.meta_ad_campaigns (
  id               text primary key,          -- Meta's campaign id
  account_id       text not null,
  name             text,
  objective        text,
  status           text,
  effective_status text,
  start_time       timestamptz,
  stop_time        timestamptz,
  raw              jsonb not null,
  synced_at        timestamptz not null default now()
);

comment on table public.meta_ad_campaigns is
  'Campaigns on the Meta ad account, so a Paid Ads row can be pointed at one.';

create table if not exists public.meta_ad_insights (
  campaign_id      text not null references public.meta_ad_campaigns(id) on delete cascade,
  -- 'lifetime' is what the tracker shows; 'daily' keeps the history. Both are
  -- asked of Meta separately: a period total is never summed from daily rows.
  period           text not null check (period in ('lifetime', 'daily')),
  date_start       date not null,
  date_stop        date not null,
  spend            text,
  impressions      text,
  reach            text,
  clicks           text,
  ctr              text,
  cpc              text,
  cpm              text,
  -- Meta has no single "Results" field; Ads Manager picks the action matching
  -- the campaign's objective. The whole array is kept and the choice is made
  -- when displaying, so nothing is thrown away.
  actions          jsonb,
  account_currency text,
  raw              jsonb not null,
  synced_at        timestamptz not null default now(),
  primary key (campaign_id, period, date_start, date_stop)
);

comment on column public.meta_ad_insights.spend is
  'Exactly as Meta returned it. Text on purpose: these are displayed verbatim, never recomputed.';

create index if not exists meta_ad_insights_campaign_period
  on public.meta_ad_insights (campaign_id, period, date_start desc);

-- Which campaign a tracker row is reporting on. Null means a row nobody has
-- linked yet, or an external client's ad that Meta does not know about.
alter table public.paid_ads
  add column if not exists meta_campaign_id text;

comment on column public.paid_ads.meta_campaign_id is
  'The Meta campaign this row reports on, chosen from a list. Null for rows with no Meta campaign (external clients, or not yet linked).';

-- ── access ──────────────────────────────────────────────────────────────
-- Read by the people who already see the Paid Ads Tracker. Written only by the
-- sync running as the service role: nobody edits a figure Meta reported.
alter table public.meta_ads_config   enable row level security;
alter table public.meta_ad_campaigns enable row level security;
alter table public.meta_ad_insights  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['meta_ads_config', 'meta_ad_campaigns', 'meta_ad_insights'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format(
      'create policy %I on public.%I for select to public using (get_my_role() = any (array[''admin'', ''manager'', ''marketing'']))',
      t || '_read', t);
    -- The account id is the one thing an owner may change by hand.
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
  end loop;
  execute 'create policy meta_ads_config_write on public.meta_ads_config for all to public
             using (get_my_role() = ''admin'') with check (get_my_role() = ''admin'')';
end $$;
