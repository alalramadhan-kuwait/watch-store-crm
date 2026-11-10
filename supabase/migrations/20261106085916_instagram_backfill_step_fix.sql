-- The variable named id clashed with instagram_auth.id, so the backfill job never started.
create or replace function public.instagram_backfill_step(p_username text)
returns bigint language plpgsql security definer set search_path to 'public' as $f$
declare left_to_do text; req bigint;
begin
  if exists (select 1 from instagram_sync_log where finished_at is null and started_at > now() - interval '5 minutes') then return null; end if;
  select a->>'remaining' into left_to_do from instagram_sync_log l, jsonb_array_elements(coalesce(l.report->'accounts', '[]')) a
   where l.report->>'mode' = 'backfill' and a->>'username' = p_username and a ? 'remaining' order by l.started_at desc limit 1;
  if left_to_do = '0' then perform cron.unschedule('instagram-backfill-' || p_username); return null; end if;
  select net.http_post(url := 'https://ttshgrujnycapugrmyxs.supabase.co/functions/v1/instagram-sync',
    headers := jsonb_build_object('x-sync-key', (select a.sync_key from instagram_auth a where a.id = 1), 'Content-Type', 'application/json'),
    body := jsonb_build_object('mode', 'backfill', 'kinds', jsonb_build_array('REELS', 'FEED'), 'username', p_username, 'only_missing', true, 'limit', 120),
    timeout_milliseconds := 300000) into req;
  return req;
end $f$;
revoke execute on function public.instagram_backfill_step(text) from public, anon, authenticated;
