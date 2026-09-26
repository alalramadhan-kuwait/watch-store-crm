-- Meta figures at every level, one set of totals per thing, and the money.
--
-- Three problems with how Meta's figures were kept:
--
-- 1. Totals piled up. A campaign's all-time totals were stored under
--    (campaign, date_start, date_stop), and Meta's "maximum" window moves both
--    ends every day, so each daily sync added a new copy of every campaign:
--    2,444 rows for 261 campaigns by 26 Sep, and readers picked one at random.
--    meta_insight_totals keeps exactly one row per campaign, ad set and ad.
--
-- 2. No money came back. Only spend and action counts were requested, so the
--    value of purchases, return on ad spend and cost per purchase were never
--    stored. The new columns hold Meta's own action_values, purchase_roas and
--    cost_per_action_type, as Meta sends them.
--
-- 3. Nothing below the campaign. The skill that plans campaigns judges
--    creatives, which live on ads. meta_ad_sets and meta_ads hold the
--    structure; meta_insight_daily holds per-day figures at every level.
--
-- The rule from meta-ads-sync still holds: figures are Meta's strings, never
-- recomputed here.

alter table public.meta_ad_insights
  add column if not exists frequency text,
  add column if not exists action_values jsonb,
  add column if not exists purchase_roas jsonb,
  add column if not exists cost_per_action_type jsonb;

create table if not exists public.meta_ad_sets (
  id text primary key,
  campaign_id text references public.meta_ad_campaigns(id) on delete cascade,
  name text,
  status text,
  effective_status text,
  optimization_goal text,
  destination_type text,
  promoted_object jsonb,
  attribution_spec jsonb,
  daily_budget text,
  lifetime_budget text,
  targeting jsonb,
  created_time timestamptz,
  start_time timestamptz,
  end_time timestamptz,
  raw jsonb,
  synced_at timestamptz not null default now()
);
create index if not exists meta_ad_sets_campaign on public.meta_ad_sets (campaign_id);

create table if not exists public.meta_ads (
  id text primary key,
  adset_id text,
  campaign_id text references public.meta_ad_campaigns(id) on delete cascade,
  name text,
  status text,
  effective_status text,
  creative_id text,
  creative jsonb,
  tracking_pixels text[],
  created_time timestamptz,
  raw jsonb,
  synced_at timestamptz not null default now()
);
create index if not exists meta_ads_campaign on public.meta_ads (campaign_id);
create index if not exists meta_ads_adset on public.meta_ads (adset_id);

create table if not exists public.meta_insight_totals (
  level text not null check (level in ('campaign', 'adset', 'ad')),
  object_id text not null,
  campaign_id text,
  date_start date,
  date_stop date,
  spend text, impressions text, reach text, frequency text, clicks text,
  ctr text, cpc text, cpm text,
  actions jsonb, action_values jsonb, purchase_roas jsonb, cost_per_action_type jsonb,
  account_currency text,
  raw jsonb,
  synced_at timestamptz not null default now(),
  primary key (level, object_id)
);
create index if not exists meta_insight_totals_campaign on public.meta_insight_totals (campaign_id);

create table if not exists public.meta_insight_daily (
  level text not null check (level in ('campaign', 'adset', 'ad')),
  object_id text not null,
  campaign_id text,
  day date not null,
  spend text, impressions text, reach text, frequency text, clicks text,
  ctr text, cpc text, cpm text,
  actions jsonb, action_values jsonb, purchase_roas jsonb, cost_per_action_type jsonb,
  account_currency text,
  raw jsonb,
  synced_at timestamptz not null default now(),
  primary key (level, object_id, day)
);
create index if not exists meta_insight_daily_day on public.meta_insight_daily (day, level);

-- Read like the other Meta tables: owners, managers and marketing. Only the
-- sync (service role) writes.
alter table public.meta_ad_sets enable row level security;
alter table public.meta_ads enable row level security;
alter table public.meta_insight_totals enable row level security;
alter table public.meta_insight_daily enable row level security;

create policy meta_ad_sets_read on public.meta_ad_sets for select to authenticated
  using ((select get_my_role()) = any (array['admin','manager','marketing']));
create policy meta_ads_read on public.meta_ads for select to authenticated
  using ((select get_my_role()) = any (array['admin','manager','marketing']));
create policy meta_insight_totals_read on public.meta_insight_totals for select to authenticated
  using ((select get_my_role()) = any (array['admin','manager','marketing']));
create policy meta_insight_daily_read on public.meta_insight_daily for select to authenticated
  using ((select get_my_role()) = any (array['admin','manager','marketing']));

revoke all on public.meta_ad_sets, public.meta_ads, public.meta_insight_totals, public.meta_insight_daily from anon;

-- The KD rate is fetched daily unless an owner has pinned one by hand, and the
-- page says where it came from. The tracking check is the pixel's own answer
-- to "are purchases arriving, and can they be tied to an ad?", refreshed daily.
alter table public.meta_ads_config
  add column if not exists rate_source text,
  add column if not exists rate_auto boolean not null default true,
  add column if not exists tracking jsonb,
  add column if not exists tracking_checked_at timestamptz;
