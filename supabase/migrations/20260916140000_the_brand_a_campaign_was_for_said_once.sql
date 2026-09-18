-- The brand a campaign was for, said once instead of guessed every time.
--
-- Meta does not know our brands. Until now the only link was whatever was
-- typed into a campaign name, and reading those names identifies a brand for
-- about a quarter of the spend on this account — not because the matching is
-- weak, but because most campaigns are boosted Instagram posts whose Meta name
-- is the post's own caption, truncated by Meta mid-word and often before the
-- brand appears. No rule recovers a brand from "…هذا إصدار خاص للكويت من دبليو ام…".
--
-- So the brand becomes a thing somebody states, once, and it is kept. The
-- name-reader stays as the fallback for anything nobody has got to yet, which
-- means the page keeps working from the first day and grows more accurate
-- every time a campaign is opened.
--
-- Three answers are storable, not two. A campaign can be for one or more
-- brands; it can be for the SHOP and no brand at all (retargeting, the
-- catalogue, the app, straps, a seasonal sale — $88k of the $150k here); or it
-- can be genuinely unreadable. Folding the last two together would blame the
-- naming for money that was never meant to belong to a brand, so they are kept
-- apart.

create table if not exists public.meta_campaign_brands (
  campaign_id text not null references public.meta_ad_campaigns(id) on delete cascade,
  -- Null on a 'whole_shop' or 'unknown' row: those say there is no brand,
  -- which is a different statement from nobody having looked yet.
  brand_id    uuid references public.brands(id) on delete cascade,
  kind        text not null default 'brand'
                check (kind in ('brand', 'whole_shop', 'unknown')),
  set_by      uuid references public.profiles(id) on delete set null,
  set_at      timestamptz not null default now(),
  constraint meta_campaign_brands_kind_matches_brand check (
    (kind = 'brand' and brand_id is not null)
    or (kind <> 'brand' and brand_id is null)
  )
);

comment on table public.meta_campaign_brands is
  'Which brand(s) a Meta campaign was for, stated by a person. Overrides the name-reading fallback in src/lib/metaBrands.ts. Several rows per campaign = a campaign that genuinely covered several brands. One row with a null brand_id = no brand: whole shop, or unreadable.';

-- A campaign may carry several brands, but each of them only once …
create unique index if not exists meta_campaign_brands_one_per_brand
  on public.meta_campaign_brands (campaign_id, brand_id) where brand_id is not null;
-- … and at most one "no brand" answer.
create unique index if not exists meta_campaign_brands_one_marker
  on public.meta_campaign_brands (campaign_id) where brand_id is null;

create index if not exists meta_campaign_brands_by_brand
  on public.meta_campaign_brands (brand_id);

/**
 * "No brand" and "these brands" cannot both be true of the same campaign.
 *
 * The two unique indexes above stop a brand or a marker being written twice,
 * but neither can see the other, and a campaign holding both West End AND
 * "whole shop" would make the spend split add up to more than the spend. The
 * picker writes a whole set at a time and would not produce it; the table is
 * money reporting, so it refuses it rather than trusting the screen.
 */
create or replace function public.meta_campaign_brands_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  if new.brand_id is null then
    if exists (select 1 from meta_campaign_brands
                where campaign_id = new.campaign_id and brand_id is not null) then
      raise exception 'This campaign already has brands; clear them before marking it as having none';
    end if;
  else
    if exists (select 1 from meta_campaign_brands
                where campaign_id = new.campaign_id and brand_id is null) then
      raise exception 'This campaign is marked as having no brand; clear that before adding brands';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists meta_campaign_brands_guard on public.meta_campaign_brands;
create trigger meta_campaign_brands_guard
  before insert or update on public.meta_campaign_brands
  for each row execute function public.meta_campaign_brands_guard();

-- ── access ──────────────────────────────────────────────────────────────
-- The same people who can see the Meta figures may state the brand. Unlike the
-- figures themselves — which nobody edits, because they are Meta's — this is
-- ours to decide, so it is writable rather than read-only.
alter table public.meta_campaign_brands enable row level security;

drop policy if exists meta_campaign_brands_read on public.meta_campaign_brands;
create policy meta_campaign_brands_read on public.meta_campaign_brands
  for select to public
  using (get_my_role() = any (array['admin', 'manager', 'marketing']));

drop policy if exists meta_campaign_brands_write on public.meta_campaign_brands;
create policy meta_campaign_brands_write on public.meta_campaign_brands
  for all to public
  using (get_my_role() = any (array['admin', 'manager', 'marketing']))
  with check (get_my_role() = any (array['admin', 'manager', 'marketing']));
