-- Instagram: everything needed to learn what the algorithm rewards on our accounts.
-- instagram_media gains Reel watch time, reposts, carousel size, whether a Reel is also in the grid; captions
-- are kept whole (up to Instagram's 2,200 characters). instagram_media_snapshots keeps every read of a post,
-- so its growth curve (first hours, 48 h, 7 days) survives the next read. instagram_audience keeps the daily
-- account splits: follower vs non-follower, by format, when followers are online, and who they are.
-- Read-only copies of Instagram's own figures; written only by instagram-sync (service role).

alter table public.instagram_media
  add column if not exists avg_watch_time_ms numeric,
  add column if not exists total_watch_time_ms numeric,
  add column if not exists reposts integer,
  add column if not exists children_count integer,
  add column if not exists is_shared_to_feed boolean;
comment on column public.instagram_media.avg_watch_time_ms is 'Reels: ig_reels_avg_watch_time, milliseconds, as Instagram reports it.';
comment on column public.instagram_media.total_watch_time_ms is 'Reels: ig_reels_video_view_total_time, milliseconds.';

create table if not exists public.instagram_media_snapshots (
  id bigserial primary key,
  media_id text not null references public.instagram_media(media_id) on delete cascade,
  username text not null,
  captured_at timestamptz not null default now(),
  mode text not null default 'daily',            -- daily | fresh
  age_hours numeric,                             -- hours since the post went up, at this read
  views integer, reach integer, likes integer, comments integer, saved integer, shares integer,
  total_interactions integer, profile_visits integer, follows integer, reposts integer,
  avg_watch_time_ms numeric, total_watch_time_ms numeric,
  metrics jsonb not null default '{}'
);
create index if not exists instagram_media_snapshots_media_idx on public.instagram_media_snapshots (media_id, captured_at);
alter table public.instagram_media_snapshots enable row level security;
create policy read_authed_igs on public.instagram_media_snapshots for select to authenticated using (true);
comment on table public.instagram_media_snapshots is 'Every read of a post''s Instagram figures (instagram-sync daily and fresh runs), for growth curves and the 48-hour / 7-day reads.';

create table if not exists public.instagram_audience (
  username text not null,
  snapshot_date date not null,
  kind text not null,                            -- follow_type | media_product_type | online_followers | followers_age | ...
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (username, snapshot_date, kind)
);
alter table public.instagram_audience enable row level security;
create policy read_authed_iga on public.instagram_audience for select to authenticated using (true);
comment on table public.instagram_audience is 'Daily account splits from Instagram as it sent them: reach and views by follower type and by format, online followers by hour, follower age/gender/city/country.';

revoke insert, update, delete on public.instagram_media_snapshots, public.instagram_audience from anon, authenticated;
revoke all on public.instagram_media_snapshots, public.instagram_audience from anon;
