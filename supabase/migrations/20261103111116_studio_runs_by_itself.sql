-- The studio runs by itself (3 Nov 2026, approved plan «خطة الستوديو الذكي»).
-- Nothing here needs a Claude session: pg_cron syncs Instagram, a watchdog retries and alerts, studio_refresh() keeps
-- the reports, dashboards and learning ready, and the studio page reads everything in one call (studio_page) through
-- the owner's Supabase connector. A film is tied to its post by the owner's tap on the post (studio_confirm, by Instagram
-- media id); a caption match is only a suggestion. Every finding carries a strength: c (مؤكد), e (ملاحظة أولية), w (دليل ضعيف).

-- ── where things are kept ──────────────────────────────────────────────────────────────────────────────────────────
alter table public.instagram_auth add column if not exists alert_user uuid;     -- who is told when the sync keeps failing
update public.instagram_auth set alert_user = coalesce(alert_user, '90ae5d91-a134-4a01-b902-b93e39236921') where id = 1;

create table if not exists public.studio_state (
  key text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.studio_state enable row level security;
revoke all on public.studio_state from anon, authenticated;
comment on table public.studio_state is 'Precomputed studio data (film reports, per-account dashboards, learning, brief), kept by studio_refresh().';

create table if not exists public.instagram_sync_alerts (
  id bigserial primary key,
  at timestamptz not null default now(),
  kind text not null,                       -- missed | retry | retry_daily | stuck | notified
  detail text,
  sync_log_id uuid,
  resolved_at timestamptz
);
alter table public.instagram_sync_alerts enable row level security;
revoke all on public.instagram_sync_alerts from anon, authenticated;
comment on table public.instagram_sync_alerts is 'What instagram_watchdog() noticed and did (retries, missed runs, alerts sent), and when it recovered.';

insert into public.notification_settings (event_type, label, category, enabled, person_target, audience_roles, sort, shop_floor, outlet_scoped, home_app)
select 'instagram_sync_failed', 'Instagram numbers stopped updating → owner', 'Marketing', true, true, null, 88, false, false, 'timekeeper'
 where not exists (select 1 from public.notification_settings where event_type = 'instagram_sync_failed');

-- ── the report, with the strength of every finding and watch time said plainly ─────────────────────────────────────
-- c: a 7-day read, 15+ posts to compare with, and a big gap (×1.5 / ×0.67). w: under a day old, under 8 posts to compare
-- with, no ratio, or an estimate. e: the rest. The average watch is Instagram's per person (total watch ÷ accounts
-- reached, checked on Halter 1: 9.5 s against 9.6 s); the time of those who stayed past 3 seconds is an estimate.
create or replace function public.ig_post_report(p_media_id text, p_stage text default 'latest')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  r jsonb; e jsonb; ev jsonb := '[]'; worked jsonb := '[]'; didnt jsonb := '[]'; tryn jsonb := '[]';
  stage7 boolean; n int; age numeric; lv text; st text; ratio numeric;
  weak_lv text := 'w'; strong_lv text := 'w'; weak_r numeric := 99; strong_r numeric := 0;
  gi int := 0; bi int := 0; avg numeric; secs numeric; skip numeric; lo numeric; hi numeric; m text[]; ln text;
begin
  r := ig_post_report_core(p_media_id, p_stage);
  if not coalesce((r->>'available')::boolean, false) then return r; end if;
  if r->>'verdict' is not null and r->>'basis' = 'final' and (r->>'age_hours')::numeric < 144 and r->>'label' not like 'مبدئي%' then
    r := jsonb_set(r, '{label}', to_jsonb('مبدئي · ' || (r->>'label')));
  end if;
  age := (r->>'age_hours')::numeric; n := coalesce((r->>'baseline_posts')::int, 0);
  stage7 := r->>'read_stage' = '7d' or (r->>'read_stage' = 'latest' and age >= 168);

  for e in select * from jsonb_array_elements(coalesce(r->'evidence', '[]')) loop
    st := e->>'state'; ratio := (e->>'ratio')::numeric;
    if e->>'k' = 'watch_ratio' then
      m := regexp_match(coalesce(e->>'value', ''), '([0-9.]+) من ([0-9.]+)');
      if m is not null then
        avg := m[1]::numeric; secs := m[2]::numeric;
        e := e || jsonb_build_object('label', 'الشخص العادي شاف', 'value', avg || ' من ' || secs || ' ث (' || round(100 * avg / secs) || '%)',
                                     'note', 'رقم إنستغرام: متوسط وقت المشاهدة لكل شخص');
      end if;
      ev := ev || e; continue;
    end if;
    if e->>'k' = 'skip_rate' and e->>'value' ~ '^[0-9.]+%$' then skip := replace(e->>'value', '%', '')::numeric; end if;
    if st in ('good', 'bad', 'mid') then
      lv := case when stage7 and n >= 15 and ratio is not null and (ratio >= 1.5 or ratio <= 0.67) then 'c'
                 when age < 24 or n < 8 or ratio is null then 'w' else 'e' end;
      e := e || jsonb_build_object('lv', lv);
      if st = 'good' then worked := worked || jsonb_build_object('t', r->'worked'->>gi, 'lv', lv, 'k', e->>'k'); gi := gi + 1; end if;
      if st = 'bad' then didnt := didnt || jsonb_build_object('t', r->'didnt'->>bi, 'lv', lv, 'k', e->>'k'); bi := bi + 1; end if;
      if ratio is not null and ratio < weak_r then weak_r := ratio; weak_lv := lv; end if;
      if ratio is not null and ratio > strong_r then strong_r := ratio; strong_lv := lv; end if;
    end if;
    ev := ev || e;
  end loop;

  -- Reels: how long the people who did not skip stayed, between «skippers watched 3 s» and «0.5 s»
  if avg is not null and skip is not null and skip < 100 and secs > 0 then
    lo := greatest(avg, round((avg - skip / 100 * 3) / (1 - skip / 100)));
    hi := least(secs, round((avg - skip / 100 * 0.5) / (1 - skip / 100)));
    if lo <= hi then
      ev := ev || jsonb_build_object('k', 'stayers', 'label', 'اللي تعدّوا أول 3 ثواني', 'value', 'تقريباً ' || lo || '–' || hi || ' ث',
                                     'usual', '—', 'state', 'est', 'lv', 'w', 'note', 'تقدير: ' || skip || '% تخطّوه بأول 3 ثواني');
      if avg / secs < 0.2 then
        didnt := didnt || jsonb_build_object('t', 'الشخص العادي شاف ' || round(100 * avg / secs) || '% بس من الفيلم (' || avg || ' من ' || secs
                                              || ' ث)، واللي تعدّوا أول 3 ثواني تقريباً ' || lo || '–' || hi || ' ث.', 'lv', 'e', 'k', 'watch_ratio');
      end if;
    end if;
  end if;

  if jsonb_array_length(worked) = 0 then worked := jsonb_build_array(jsonb_build_object('t', 'ما فيه رقم فوق المعتاد بوضوح.', 'lv', 'w')); end if;
  if jsonb_array_length(didnt) = 0 then didnt := jsonb_build_array(jsonb_build_object('t', 'ما فيه رقم تحت المعتاد بوضوح.', 'lv', 'w')); end if;
  for ln in select jsonb_array_elements_text(coalesce(r->'try_next', '[]')) loop
    tryn := tryn || jsonb_build_object('t', ln, 'lv', case when ln like 'خلّ %' then strong_lv
                                                           when ln like 'جرّب فكرة جديدة%' or ln like 'غيّر شي واحد%' then 'w' else weak_lv end);
  end loop;
  return r || jsonb_build_object('worked', worked, 'didnt', didnt, 'evidence', ev, 'try_next', tryn, 'lessons', worked || didnt, 'next', tryn,
    'level', case when stage7 and n >= 15 and coalesce((r->>'signals_compared')::int, 0) >= 4 then 'c' when age < 24 or n < 8 then 'w' else 'e' end);
end $$;

-- ── a film's own opening and its test become things the learning can group by ──────────────────────────────────────
create or replace function public.studio_film_attrs(f jsonb) returns jsonb language sql immutable as $$
  with m as (select coalesce(f->>'meta', '') meta, (f->>'seconds')::numeric secs)
  select jsonb_strip_nulls(jsonb_build_object(
    'القصة', (select x from unnest(array['قصة وسيرة', 'شرح بالأرقام', 'تاريخ خفي', 'قصة حقيقية']) x where meta like '%' || x || '%' limit 1),
    'الأسلوب', case when meta ~ 'ورقي' then 'ورقي' when meta ~ 'نقش' then 'نقش النحاس' when meta ~ 'آرت ديكو' then 'آرت ديكو'
                    when meta ~ 'رسم تقني' then 'رسم تقني' when meta ~ 'رسومات بسيطة' then 'رسومات بسيطة'
                    when meta ~ '(بيانات|بالأرقام)' and meta !~ 'صور' then 'بيانات' when meta ~ 'صور' then 'صور حقيقية' end,
    'الصوت', case when meta ~ 'بدون صوت' then 'بدون صوت' when meta ~* 'فيصل|Faisal' then 'Faisal' when meta ~* 'Jarnathan' then 'Jarnathan'
                  when meta ~* 'Abdullah' then 'Abdullah' when meta ~* 'Omni' then 'OmniVoice' end,
    'الطول', case when secs is null then null when secs < 45 then 'أقل من 45 ث' when secs < 75 then '45–75 ث' when secs < 100 then '75–100 ث' else '100 ث وأكثر' end,
    'اللغة', case when meta ~ 'كويتي' then 'كويتي' end,
    'الموسيقى', case when meta ~ 'صوت بس' then 'بدون موسيقى' when f->'rules' ? 'reel-music' then 'موسيقى' end,
    'الموضوع', f->>'topic',
    'الافتتاحية', f->'hook'->>'type',
    'افتتاحية', f->'hook'->>'text',
    'التجربة', f->>'test',
    'seconds', secs, 'slides', case when jsonb_typeof(f->'slides') = 'array' then jsonb_array_length(f->'slides') end,
    'rules', f->'rules')) || coalesce(f->'attributes', '{}')
    from m
$$;

-- the learning also groups by the film's real opening type and its test
do $$
declare src text;
begin
  src := pg_get_functiondef('public.ig_recipe(text, integer)'::regprocedure);
  if position('''الافتتاحية''' in src) = 0 then
    src := replace(src, '''الموسيقى'', ''الموضوع'')', '''الموسيقى'', ''الموضوع'', ''الافتتاحية'', ''التجربة'')');
    execute src;
  end if;
end $$;

-- ── films: register, suggest, confirm ──────────────────────────────────────────────────────────────────────────────
create or replace function public.studio_register(p jsonb) returns integer language plpgsql security definer set search_path = public as $$
declare f jsonb; n int := 0;
begin
  for f in select * from jsonb_array_elements(coalesce(p->'films', '[]')) loop
    continue when f->'posted'->>'at' is null or coalesce(f->>'id', '') !~ '^[A-Za-z0-9_.-]{1,80}$';
    insert into studio_posts as s (film_id, kind, username, name, version, posted_at, caption, caption_hint, permalink, attributes)
    values (f->>'id', case when f->>'kind' = 'carousel' then 'carousel' else 'reel' end, coalesce(f->>'username', 'timekeeperkw'),
            f->>'name', coalesce(f->'posted'->>'version', f->>'version'), (f->'posted'->>'at')::timestamptz,
            nullif(left(f->>'caption', 2200), ''), nullif(left(f->>'caption_hint', 2200), ''), nullif(f->'posted'->>'permalink', ''), studio_film_attrs(f))
    on conflict (film_id) do update set
      username = excluded.username, name = excluded.name, version = excluded.version, posted_at = excluded.posted_at,
      attributes = s.attributes || excluded.attributes,
      caption = coalesce(excluded.caption, s.caption), caption_hint = coalesce(excluded.caption_hint, s.caption_hint),
      permalink = coalesce(excluded.permalink, s.permalink),
      media_id = case when excluded.permalink is not null and excluded.permalink is distinct from s.permalink
                       and coalesce(s.link_method, '') not in ('permalink', 'confirmed') then null else s.media_id end;
    n := n + 1;
  end loop;
  return n;
end $$;

-- One film as the studio shows it: its post (confirmed or only suggested) and its reports.
create or replace function public.studio_film_bundle(p_film text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare sp record; m record; reps jsonb := '{}'; rep jsonb; st text;
begin
  select * into sp from studio_posts where film_id = p_film;
  if not found then return null; end if;
  if sp.media_id is null then
    return jsonb_build_object('linked', false, 'kind', sp.kind, 'username', sp.username, 'posted_at', sp.posted_at);
  end if;
  select media_id, permalink, posted_at, ig_first_line(caption) first_line into m from instagram_media where media_id = sp.media_id;
  foreach st in array array['latest', '48h', '7d'] loop
    rep := ig_post_report(sp.media_id, st);
    if (rep->>'available')::boolean then reps := reps || jsonb_build_object(st, rep - 'lessons' - 'next' - 'numbers'); end if;
  end loop;
  return jsonb_build_object('linked', true, 'confirmed', sp.link_method in ('confirmed', 'permalink'), 'method', sp.link_method,
    'media_id', sp.media_id, 'permalink', m.permalink, 'posted_at', m.posted_at, 'first_line', m.first_line, 'kind', sp.kind,
    'username', sp.username, 'due', jsonb_build_object('48h', m.posted_at + interval '48 hours', '7d', m.posted_at + interval '168 hours'),
    'reports', reps);
end $$;

-- The recent posts a film could be, newest first, the best caption match marked as a suggestion.
create or replace function public.studio_candidates(p jsonb) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare k text := case when p->>'kind' = 'carousel' then 'carousel' else 'reel' end; u text := coalesce(p->>'username', 'timekeeperkw');
  t0 timestamptz := coalesce((p->'posted'->>'at')::timestamptz, now()); cap text := coalesce(nullif(p->>'caption', ''), nullif(p->>'caption_hint', ''));
  res jsonb; best text; b1 numeric; b2 numeric;
begin
  with c as (
    select m.media_id, ig_first_line(m.caption) first_line, m.posted_at, m.permalink,
           case when cap is null then 0 else ig_text_match(cap, m.caption) end score,
           (select s.film_id from studio_posts s where s.media_id = m.media_id and s.film_id <> coalesce(p->>'id', '')) taken_by
      from instagram_media m
     where m.username = u and ig_kind(m.media_product_type, m.media_type) = k and m.posted_at > t0 - interval '10 days'
     order by m.posted_at desc limit 8)
  select jsonb_agg(to_jsonb(c) order by c.posted_at desc), (array_agg(media_id order by score desc))[1],
         (array_agg(score order by score desc))[1], (array_agg(score order by score desc))[2]
    into res, best, b1, b2 from c;
  return jsonb_build_object('posts', coalesce(res, '[]'), 'synced_at', (select max(synced_at) from instagram_media where username = u),
    'suggested', case when b1 >= (case when p->>'caption' is not null then 0.6 else 0.3 end) and coalesce(b2, 0) < b1 - 0.15 then best end);
end $$;

-- The owner's tap: this film is this post (by media id, or by its link). One film per post.
create or replace function public.studio_confirm(p jsonb, p_media text) returns jsonb language plpgsql security definer set search_path = public as $$
declare mid text := p_media; other text;
begin
  if coalesce(p->>'id', '') !~ '^[A-Za-z0-9_.-]{1,80}$' then raise exception 'film id'; end if;
  perform studio_register(jsonb_build_object('films', jsonb_build_array(p)));
  if mid is null and p->'posted'->>'permalink' is not null then
    select media_id into mid from instagram_media
     where rtrim(split_part(permalink, '?', 1), '/') = rtrim(split_part(p->'posted'->>'permalink', '?', 1), '/') limit 1;
  end if;
  if mid is null or not exists (select 1 from instagram_media where media_id = mid) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select film_id into other from studio_posts where media_id = mid and film_id <> p->>'id' and link_method in ('confirmed', 'permalink');
  if other is not null then return jsonb_build_object('ok', false, 'reason', 'taken', 'film', other); end if;
  update studio_posts set media_id = null, link_method = null, link_score = null where media_id = mid and film_id <> p->>'id';
  update studio_posts set media_id = mid, link_method = 'confirmed', link_score = 1, linked_at = now() where film_id = p->>'id';
  return jsonb_build_object('ok', true, 'film', studio_film_bundle(p->>'id'));
end $$;

-- ── one account at a glance ────────────────────────────────────────────────────────────────────────────────────────
-- Posts are compared at the same age (their 48-hour reads), never by adding up reach of posts of different ages.
create or replace function public.ig_dashboard(p_username text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare fol record; fol7 int; day record; split jsonb; f int; nf int; wk jsonb; top jsonb; same jsonb; res jsonb; k text;
  cur numeric; base numeric; ncur int; nbase int;
begin
  select followers, snapshot_date into fol from instagram_daily where username = p_username and followers is not null order by snapshot_date desc limit 1;
  select followers into fol7 from instagram_daily where username = p_username and followers is not null and snapshot_date <= fol.snapshot_date - 7 order by snapshot_date desc limit 1;
  select snapshot_date, reach, profile_views, website_clicks, accounts_engaged into day
    from instagram_daily where username = p_username and reach is not null order by snapshot_date desc limit 1;
  select jsonb_path_query_first(data, '$[*] ? (@.name == "reach").total_value.breakdowns[0].results') into split
    from instagram_audience where username = p_username and kind = 'follow_type' order by snapshot_date desc limit 1;
  select sum((x->>'value')::int) filter (where x->'dimension_values'->>0 = 'FOLLOWER'), sum((x->>'value')::int) filter (where x->'dimension_values'->>0 = 'NON_FOLLOWER')
    into f, nf from jsonb_array_elements(coalesce(split, '[]')) x;
  select jsonb_build_object('posts', count(*), 'reels', count(*) filter (where media_product_type = 'REELS'),
           'carousels', count(*) filter (where media_type = 'CAROUSEL_ALBUM'), 'shares', sum(shares), 'saves', sum(saved)) into wk
    from instagram_media where username = p_username and posted_at > now() - interval '7 days';
  select jsonb_build_object('first_line', ig_first_line(caption), 'reach', reach, 'kind', ig_kind(media_product_type, media_type), 'permalink', permalink, 'posted_at', posted_at)
    into top from instagram_media where username = p_username and posted_at > now() - interval '7 days' and reach is not null order by reach desc limit 1;
  same := '{}';
  foreach k in array array['reel', 'carousel'] loop
    select percentile_cont(0.5) within group (order by reach), count(*) into cur, ncur from ig_reads('48h') x
     where x.username = p_username and x.kind = k and x.posted_at > now() - interval '9 days';
    select percentile_cont(0.5) within group (order by reach), count(*) into base, nbase from ig_reads('48h') x
     where x.username = p_username and x.kind = k and x.posted_at <= now() - interval '9 days' and x.posted_at > now() - interval '90 days';
    same := same || jsonb_build_object(k, jsonb_build_object('week', round(cur), 'week_posts', ncur, 'usual', round(base), 'usual_posts', nbase,
              'ratio', case when nbase >= 5 and ncur >= 1 and base > 0 then round((cur / base)::numeric, 2) end));
  end loop;
  res := jsonb_build_object('username', p_username, 'followers', fol.followers, 'followers_date', fol.snapshot_date,
    'followers_week', case when fol7 is not null then fol.followers - fol7 end,
    'day', case when day.snapshot_date is not null then jsonb_build_object('date', day.snapshot_date, 'reach', day.reach, 'profile_views', day.profile_views,
              'website_clicks', day.website_clicks, 'accounts_engaged', day.accounts_engaged) end,
    'split', case when f is not null or nf is not null then jsonb_build_object('followers', f, 'non_followers', nf) end,
    'week', wk, 'top', top, 'same_age', same,
    'since', (select min(snapshot_date) from instagram_daily where username = p_username and reach is not null));
  return res || jsonb_build_object('summary',
    case when day.reach is not null and f is not null and nf is not null and (f + nf) > 0 then
           format('أمس وصلنا %s حساب، %s%% منهم مو متابعين.', to_char(day.reach, 'FM999,999,990'), round(100.0 * nf / (f + nf)))
         when day.reach is not null then format('أمس وصلنا %s حساب.', to_char(day.reach, 'FM999,999,990'))
         else 'أرقام أمس ما وصلت للحين.' end);
end $$;

-- ── the sync, as the owner sees it ─────────────────────────────────────────────────────────────────────────────────
create or replace function public.studio_status() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare accts jsonb; last_ok timestamptz; last_fresh timestamptz; nf timestamptz; nd timestamptz; probs jsonb; miss jsonb; open_alerts int;
begin
  select max(started_at) into last_ok from instagram_sync_log where status in ('ok', 'partial') and finished_at is not null;
  select max(started_at) into last_fresh from instagram_sync_log where status in ('ok', 'partial') and report->>'mode' = 'fresh';
  select jsonb_object_agg(u, jsonb_build_object(
           'last_ok', (select max(l.started_at) from instagram_sync_log l, jsonb_array_elements(coalesce(l.report->'accounts', '[]')) a
                        where a->>'username' = u and a->>'error' is null and coalesce((a->>'rate_limited')::boolean, false) = false),
           'last_error', (select a->>'error' from instagram_sync_log l, jsonb_array_elements(coalesce(l.report->'accounts', '[]')) a
                           where a->>'username' = u and (a->>'error' is not null or (a->>'rate_limited')::boolean)
                             and l.started_at > now() - interval '24 hours' order by l.started_at desc limit 1),
           'reels_without_figures', (select count(*) from instagram_media where username = u and media_product_type = 'REELS' and avg_watch_time_ms is null),
           'posts', (select count(*) from instagram_media where username = u)))
    into accts from (select distinct username u from instagram_media) x;
  select min(t) into nf from generate_series(date_trunc('hour', now()) + interval '40 minutes', date_trunc('hour', now()) + interval '4 hours', interval '1 hour') t
   where t > now() and extract(hour from t)::int % 3 = 0;
  nd := date_trunc('day', now()) + interval '5 hours 15 minutes'; if nd <= now() then nd := nd + interval '1 day'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('at', at, 'kind', kind, 'detail', detail) order by at desc), '[]'), count(*)
    into probs, open_alerts from (select * from instagram_sync_alerts where resolved_at is null and at > now() - interval '48 hours' order by at desc limit 6) a;
  select jsonb_build_object(
           'films_unlinked', (select count(*) from studio_posts where media_id is null),
           'films_suggested', (select count(*) from studio_posts where media_id is not null and coalesce(link_method, '') not in ('confirmed', 'permalink'))) into miss;
  return jsonb_build_object('last_ok', last_ok, 'last_fresh', last_fresh, 'next_fresh', nf, 'next_daily', nd, 'accounts', accts,
    'problems', probs, 'missing', miss, 'refreshed_at', (select updated_at from studio_state where key = 'films'),
    'health', case when open_alerts > 0 or last_fresh is null or last_fresh < now() - interval '3 hours 30 minutes' then 'problem' else 'ok' end,
    'runs', (select jsonb_agg(jsonb_build_object('at', started_at, 'status', status, 'mode', coalesce(report->>'mode', 'daily'), 'error', error) order by started_at desc)
               from (select * from instagram_sync_log order by started_at desc limit 8) l));
end $$;

-- ── keeping it ready ───────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.studio_refresh() returns jsonb language plpgsql security definer set search_path = public as $$
declare films jsonb; dash jsonb := '{}'; recipes jsonb := '{}'; acc text; tk jsonb;
begin
  perform studio_link_posts();
  select coalesce(jsonb_object_agg(film_id, studio_film_bundle(film_id)), '{}') into films from studio_posts;
  for acc in select distinct username from instagram_media loop
    dash := dash || jsonb_build_object(acc, ig_dashboard(acc));
    recipes := recipes || jsonb_build_object(acc, ig_recipe(acc, 120));
  end loop;
  tk := recipes->'timekeeperkw';
  insert into studio_state (key, data, updated_at) values
    ('films', films, now()),
    ('dash', dash, now()),
    ('learn', jsonb_build_object('recipe', tk - 'top' - 'best_openings' - 'targets',
        'accounts', (select jsonb_object_agg(k, jsonb_build_object('posts', v->'posts', 'items', v->'items')) from jsonb_each(recipes) e(k, v)),
        'brief', jsonb_build_object('reel', ig_brief(tk, 'reel') - 'targets', 'carousel', ig_brief(tk, 'carousel') - 'targets')), now())
  on conflict (key) do update set data = excluded.data, updated_at = excluded.updated_at;
  return jsonb_build_object('films', (select count(*) from jsonb_object_keys(films)), 'accounts', (select count(*) from jsonb_object_keys(dash)));
end $$;

-- Everything the studio page shows, in one call. p = {films: [the posted films, as the studio keeps them]}.
create or replace function public.studio_page(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare films jsonb := '{}'; id text; learn jsonb; dash jsonb;
begin
  perform studio_register(p);
  perform studio_link_posts();
  for id in select x->>'id' from jsonb_array_elements(coalesce(p->'films', '[]')) x where x->'posted'->>'at' is not null loop
    films := films || jsonb_build_object(id, studio_film_bundle(id));
  end loop;
  select data into learn from studio_state where key = 'learn';
  select data into dash from studio_state where key = 'dash';
  if learn is null or dash is null then perform studio_refresh();
    select data into learn from studio_state where key = 'learn'; select data into dash from studio_state where key = 'dash'; end if;
  return jsonb_build_object('at', now(), 'films', films, 'learn', learn, 'dash', dash, 'status', studio_status());
end $$;

-- ── calling the sync, by the clock, by the watchdog, or by the owner's button ──────────────────────────────────────
create or replace function public.instagram_call(p_mode text) returns bigint language sql security definer set search_path = public as $$
  select net.http_post(
    url := 'https://ttshgrujnycapugrmyxs.supabase.co/functions/v1/instagram-sync',
    headers := jsonb_build_object('x-sync-key', (select sync_key from instagram_auth where id = 1), 'Content-Type', 'application/json'),
    body := jsonb_build_object('mode', case when p_mode = 'fresh' then 'fresh' else 'daily' end),
    timeout_milliseconds := 150000)
$$;

create or replace function public.instagram_sync_now() returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from instagram_sync_log where started_at > now() - interval '10 minutes' and finished_at is null) then
    return jsonb_build_object('started', false, 'reason', 'running');
  end if;
  if exists (select 1 from instagram_sync_log where started_at > now() - interval '5 minutes') then
    return jsonb_build_object('started', false, 'reason', 'just_ran');
  end if;
  perform instagram_call('fresh');
  return jsonb_build_object('started', true);
end $$;

-- Every hour: close runs that died, retry a failed or missed run once, alert the owner after two failures in a row,
-- and mark problems solved when a run succeeds again.
create or replace function public.instagram_watchdog() returns jsonb language plpgsql security definer set search_path = public as $$
declare last_run record; prev_run record; last_fresh timestamptz; did text[] := '{}'; who uuid; detail text; running boolean;
begin
  update instagram_sync_log set status = 'error', error = coalesce(error, 'stopped without finishing'), finished_at = now()
   where finished_at is null and started_at < now() - interval '20 minutes';
  if found then
    insert into instagram_sync_alerts (kind, detail) values ('stuck', 'مزامنة وقفت قبل ما تخلص');
    did := array_append(did, 'stuck');
  end if;
  running := exists (select 1 from instagram_sync_log where finished_at is null);
  select * into last_run from instagram_sync_log where finished_at is not null order by started_at desc limit 1;
  select * into prev_run from instagram_sync_log where finished_at is not null and id <> last_run.id order by started_at desc limit 1;
  select max(started_at) into last_fresh from instagram_sync_log where status in ('ok', 'partial') and report->>'mode' = 'fresh';

  if last_run.status = 'ok' then
    update instagram_sync_alerts set resolved_at = now() where resolved_at is null;
  elsif not running and last_run.status in ('error', 'partial') and last_run.finished_at > now() - interval '3 hours'
        and not exists (select 1 from instagram_sync_alerts where sync_log_id = last_run.id) then
    insert into instagram_sync_alerts (kind, detail, sync_log_id) values ('retry', coalesce(last_run.error, 'فشل حساب واحد أو أكثر'), last_run.id);
    perform instagram_call('fresh'); did := array_append(did, 'retry'); running := true;
  end if;

  if not running and (last_fresh is null or last_fresh < now() - interval '3 hours 20 minutes')
     and not exists (select 1 from instagram_sync_alerts where kind = 'missed' and at > now() - interval '50 minutes') then
    insert into instagram_sync_alerts (kind, detail) values ('missed', 'ما صار تحديث من أكثر من 3 ساعات');
    perform instagram_call('fresh'); did := array_append(did, 'missed'); running := true;
  end if;

  if not running and (now() at time zone 'Asia/Kuwait')::time > time '09:30'
     and not exists (select 1 from instagram_sync_log where coalesce(report->>'mode', 'daily') = 'daily' and status in ('ok', 'partial')
                      and started_at > date_trunc('day', now()) + interval '5 hours')
     and not exists (select 1 from instagram_sync_alerts where kind = 'retry_daily' and at > date_trunc('day', now())) then
    insert into instagram_sync_alerts (kind, detail) values ('retry_daily', 'تحديث الصبح ما خلص');
    perform instagram_call('daily'); did := array_append(did, 'retry_daily');
  end if;

  if last_run.status in ('error', 'partial') and prev_run.status in ('error', 'partial')
     and not exists (select 1 from instagram_sync_alerts where kind = 'notified' and at > now() - interval '12 hours') then
    select alert_user into who from instagram_auth where id = 1;
    detail := coalesce(last_run.error, 'فشل حساب واحد أو أكثر');
    perform notify_event('instagram_sync_failed', 'أرقام إنستغرام ما تتحدث',
      'فشلت المزامنة مرتين ورا بعض: ' || left(detail, 140) || '. النظام يعيد المحاولة كل ساعة.', '/instagram', null, who, null,
      'igfail-' || to_char(now(), 'YYYYMMDDHH24'), null);
    insert into instagram_sync_alerts (kind, detail, sync_log_id) values ('notified', detail, last_run.id);
    did := array_append(did, 'notified');
  end if;
  return jsonb_build_object('did', did);
end $$;

revoke execute on function public.ig_post_report(text, text), public.studio_register(jsonb), public.studio_film_bundle(text),
  public.studio_candidates(jsonb), public.studio_confirm(jsonb, text), public.ig_dashboard(text), public.studio_status(),
  public.studio_refresh(), public.studio_page(jsonb), public.instagram_call(text), public.instagram_sync_now(), public.instagram_watchdog()
  from public, anon, authenticated;
grant execute on function public.ig_post_report(text, text), public.studio_register(jsonb), public.studio_film_bundle(text),
  public.studio_candidates(jsonb), public.studio_confirm(jsonb, text), public.ig_dashboard(text), public.studio_status(),
  public.studio_refresh(), public.studio_page(jsonb), public.instagram_call(text), public.instagram_sync_now(), public.instagram_watchdog()
  to service_role;

-- ── the clock ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- the daily job reads the sync key when it runs (it held a copy of it) and waits long enough to record the answer
select cron.schedule('instagram-daily-sync', '15 5 * * *', 'select public.instagram_call(''daily'')');
select cron.schedule('instagram-fresh-sync', '40 */3 * * *', 'select public.instagram_call(''fresh'')');
select cron.schedule('studio-refresh', '50 */3 * * *', 'select public.studio_refresh()');
select cron.schedule('studio-refresh-morning', '30 5 * * *', 'select public.studio_refresh()');
select cron.schedule('instagram-watchdog', '25 * * * *', 'select public.instagram_watchdog()');
