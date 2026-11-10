-- Finishes Step 1: removes the test table, finds boosted posts by caption, stores Reel length, shows ad activity, batches the history backfill.
drop table public._v21_check;

alter table public.instagram_media add column if not exists duration_s numeric, add column if not exists boosted boolean not null default false;
create index if not exists instagram_media_permalink_idx on public.instagram_media (permalink);

-- Meta gives an ad its own link, so a boosted post is found by the ad's text matching the post's caption.
create or replace function public.ig_mark_boosted()
returns integer language plpgsql security definer set search_path to 'public' as $f$
declare n int;
begin
  with ads as (select distinct left(ig_norm(creative->>'body'), 40) k from meta_ads where length(ig_norm(creative->>'body')) >= 20),
  hit as (select m.media_id from instagram_media m join ads a on left(ig_norm(m.caption), 40) = a.k)
  update instagram_media m set boosted = exists (select 1 from hit h where h.media_id = m.media_id)
   where m.boosted is distinct from exists (select 1 from hit h where h.media_id = m.media_id);
  select count(*) into n from instagram_media where boosted;
  return n;
end $f$;

create or replace function public.ig_is_boosted(p_permalink text)
returns boolean language sql stable security definer set search_path to 'public' as $f$
  select coalesce((select m.boosted from instagram_media m where m.permalink = p_permalink limit 1), false)
$f$;

do $do$
declare d text;
begin
  -- a Reel keeps its measured length
  select pg_get_functiondef('public.ig_keep_metrics()'::regprocedure) into d;
  if position('new.thumbnail_url := coalesce(new.thumbnail_url, old.thumbnail_url);' in d) = 0 then raise exception 'keep'; end if;
  execute replace(d, 'new.thumbnail_url := coalesce(new.thumbnail_url, old.thumbnail_url);',
    'new.thumbnail_url := coalesce(new.thumbnail_url, old.thumbnail_url);
  new.duration_s := coalesce(new.duration_s, old.duration_s);');

  -- percentage watched uses the studio length, else the length read from the video (0 = could not be read)
  select pg_get_functiondef('public.ig_reads(text)'::regprocedure) into d;
  if position('x.skip_rate, sp.seconds,' in d) = 0 or position('nullif(sp.seconds, 0)' in d) = 0 then raise exception 'reads'; end if;
  d := replace(d, 'x.skip_rate, sp.seconds,', 'x.skip_rate, coalesce(sp.seconds, nullif(m.duration_s, 0)),');
  d := replace(d, 'nullif(sp.seconds, 0)', 'nullif(coalesce(sp.seconds, nullif(m.duration_s, 0)), 0)');
  execute d;

  select pg_get_functiondef('public.studio_refresh()'::regprocedure) into d;
  if position('perform studio_link_posts();' in d) = 0 then raise exception 'refresh'; end if;
  execute replace(d, 'perform studio_link_posts();', 'perform studio_link_posts();
  perform ig_mark_boosted();');

  -- ad activity beside reach: account reach includes ads
  select pg_get_functiondef('public.ig_dash2(text,jsonb)'::regprocedure) into d;
  if position('declare prio int;' in d) = 0 or position($s$  return jsonb_build_object('priority', prio, 'hero', hero, 'series', series, 'kinds', kinds, 'models', models,$s$ in d) = 0 then raise exception 'dash'; end if;
  d := replace(d, 'declare prio int;', 'declare ad7 numeric; ad14 numeric; adlast date; adchg numeric; prio int;');
  d := replace(d, $s$  return jsonb_build_object('priority', prio, 'hero', hero, 'series', series, 'kinds', kinds, 'models', models,$s$,
$s$  if prio = 1 then
    select sum(spend::numeric) filter (where day > d0 - 7), sum(spend::numeric) filter (where day <= d0 - 7), max(day)
      into ad7, ad14, adlast from meta_insight_daily where level = 'campaign' and day > d0 - 14;
    if adlast >= d0 and ad14 > 0 then
      adchg := round(100 * (ad7 / ad14 - 1));
      if abs(adchg) >= 25 then note := note || format(' صرف الإعلانات بنفس الفترة %s %s%%.', case when adchg < 0 then 'نازل' else 'طالع' end, abs(adchg)); end if;
    end if;
  end if;
  return jsonb_build_object('priority', prio, 'hero', hero, 'series', series, 'kinds', kinds, 'models', models, 'ads', jsonb_build_object('spend_7d', round(ad7), 'spend_prev_7d', round(ad14), 'chg', adchg, 'through', adlast),$s$);
  execute d;
end $do$;

-- The history backfill, in small batches so a run ends before the worker limit; each account stops itself when done.
create or replace function public.instagram_backfill_step(p_username text)
returns bigint language plpgsql security definer set search_path to 'public' as $f$
declare left_to_do text; id bigint;
begin
  if exists (select 1 from instagram_sync_log where finished_at is null and started_at > now() - interval '5 minutes') then return null; end if;
  select a->>'remaining' into left_to_do from instagram_sync_log l, jsonb_array_elements(coalesce(l.report->'accounts', '[]')) a
   where l.report->>'mode' = 'backfill' and a->>'username' = p_username and a ? 'remaining' order by l.started_at desc limit 1;
  if left_to_do = '0' then perform cron.unschedule('instagram-backfill-' || p_username); return null; end if;
  select net.http_post(url := 'https://ttshgrujnycapugrmyxs.supabase.co/functions/v1/instagram-sync',
    headers := jsonb_build_object('x-sync-key', (select sync_key from instagram_auth where id = 1), 'Content-Type', 'application/json'),
    body := jsonb_build_object('mode', 'backfill', 'kinds', jsonb_build_array('REELS', 'FEED'), 'username', p_username, 'only_missing', true, 'limit', 120),
    timeout_milliseconds := 300000) into id;
  return id;
end $f$;
revoke execute on function public.instagram_backfill_step(text) from public, anon, authenticated;
revoke execute on function public.ig_mark_boosted() from public, anon, authenticated;

select cron.schedule('instagram-backfill-timekeeperkw', '*/6 * * * *', $c$select public.instagram_backfill_step('timekeeperkw')$c$);
select cron.schedule('instagram-backfill-timegallerykw', '2-59/6 * * * *', $c$select public.instagram_backfill_step('timegallerykw')$c$);
select cron.schedule('instagram-backfill-timekeeperkwshop', '4-59/6 * * * *', $c$select public.instagram_backfill_step('timekeeperkwshop')$c$);

update public.instagram_sync_log set status = 'partial', error = 'history backfill stopped by the server time limit', finished_at = now()
 where finished_at is null and started_at < now() - interval '3 minutes';
select public.ig_mark_boosted();
