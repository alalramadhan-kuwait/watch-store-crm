-- Instagram's own figures for every post and every day, for all three accounts.
--
-- The direct connection needed somebody to paste a personal token into
-- instagram-connect, which never happened: instagram_media had no rows and the
-- 05:15 sync failed every morning with "not connected". The ads sync's System
-- User token already holds instagram_basic and instagram_manage_insights for
-- timekeeperkw, timegallerykw and timekeeperkwshop, so instagram-sync now uses
-- that and needs nobody to connect anything.
--
-- The public scraper (instagram_posts) can see likes and comments only. These
-- columns hold what only Instagram knows: reach, saves, shares, views, profile
-- visits and follows per post, and reach, profile views, accounts engaged and
-- website taps per day.

alter table public.instagram_media
  add column if not exists username text,
  add column if not exists media_product_type text,
  add column if not exists shares integer,
  add column if not exists views integer,
  add column if not exists total_interactions integer,
  add column if not exists profile_visits integer,
  add column if not exists follows integer,
  add column if not exists insights jsonb;
create index if not exists instagram_media_user_posted on public.instagram_media (username, posted_at desc);

alter table public.instagram_daily
  add column if not exists accounts_engaged integer,
  add column if not exists total_interactions integer,
  add column if not exists website_clicks integer;
