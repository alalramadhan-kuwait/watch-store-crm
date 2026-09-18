-- Ad spend in the currency the shop actually thinks in.
--
-- Meta bills this account in USD and reports every figure in USD. Everything
-- else in the business — the Paid Ads Tracker's budgets, the sales targets,
-- the till — is in KD, so the one number an owner wants to compare against a
-- budget was the one number in a foreign currency.
--
-- The rate is stored rather than fetched. KWD is pegged to a basket and moves
-- by fractions of a per cent in a year, so a daily fetch would add a sync that
-- can fail in exchange for noise; and a rate fetched today would in any case be
-- applied to spend from 2023, which no daily rate makes more correct. One
-- number, set by an owner, shown wherever it is used.
--
-- Nothing Meta sent is touched. The USD strings stay exactly as they arrived in
-- meta_ad_insights and are still what the campaign sheet shows; the KD figure
-- is worked out at display time and always carries the rate beside it.

alter table public.meta_ads_config
  add column if not exists kwd_per_usd    numeric,
  add column if not exists rate_updated_at timestamptz;

-- A rate of zero or a negative one would silently wipe every figure on the
-- page; null is the honest way to say "not set", and the app then shows Meta's
-- own currency rather than inventing one.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'meta_ads_config_rate_positive') then
    alter table public.meta_ads_config
      add constraint meta_ads_config_rate_positive
      check (kwd_per_usd is null or kwd_per_usd > 0);
  end if;
end $$;

comment on column public.meta_ads_config.kwd_per_usd is
  'KD for one USD, set by an owner in Settings. Used only to display Meta''s USD figures in KD — the stored figures are never converted or overwritten. Null = show Meta''s own currency.';

-- The rate on the day this was written. An owner can change it in Settings; it
-- is seeded so the page reads in KD from the moment it ships rather than
-- waiting for somebody to notice a blank field.
update public.meta_ads_config
   set kwd_per_usd = 0.3065, rate_updated_at = now()
 where id = 1 and kwd_per_usd is null;
