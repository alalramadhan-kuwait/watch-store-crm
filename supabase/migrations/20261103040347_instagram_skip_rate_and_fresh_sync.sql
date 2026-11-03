-- Reels skip rate (reels_skip_rate: % of views that skipped in the first 3 seconds, the hook measure) and
-- the views a Reel got on Facebook as a crosspost. Instagram returns them on v21.0 (probe, 3 Nov 2026); they
-- are asked for through instagram_auth.extra_metrics, and read out of the stored insights as columns.
update public.instagram_auth
   set extra_metrics = '{"REELS": ["reels_skip_rate", "crossposted_views", "facebook_views"]}'::jsonb
 where id = 1;

alter table public.instagram_media
  add column if not exists skip_rate numeric generated always as ((insights->>'reels_skip_rate')::numeric) stored;
alter table public.instagram_media_snapshots
  add column if not exists skip_rate numeric generated always as ((metrics->>'reels_skip_rate')::numeric) stored;
comment on column public.instagram_media.skip_rate is 'Reels: % of views that skipped during the first three seconds (Instagram reels_skip_rate).';

-- New posts are read every 3 hours for their first 8 days, so the first hours and the 48-hour read exist.
select cron.unschedule(jobname) from cron.job where jobname = 'instagram-fresh-sync';
select cron.schedule('instagram-fresh-sync', '40 */3 * * *', $job$
  select net.http_post(
    url := 'https://ttshgrujnycapugrmyxs.supabase.co/functions/v1/instagram-sync',
    headers := jsonb_build_object('x-sync-key', (select sync_key from public.instagram_auth where id = 1), 'Content-Type', 'application/json'),
    body := '{"mode":"fresh"}'::jsonb,
    timeout_milliseconds := 120000)
$job$);
