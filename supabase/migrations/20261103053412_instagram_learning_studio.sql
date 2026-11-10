-- Instagram learning for the studio (3 Nov 2026).
-- Every post is judged against its own account's earlier posts of the same format, at the same age when that history
-- exists (48 hours, 7 days), on the signals Meta names for ranking: reach, sends (shares) per reach, the skip rate in the
-- first 3 seconds and the watch time for Reels, saves, likes, and follows for feed posts. Views alone never decide it.
-- A figure Instagram did not give is "unavailable", never zero. Patterns need 5+ posts and carry a confidence; they are
-- correlations, labelled so. Nothing here changes the studio's creative rules or any approved film.

-- ── safety: a failed read never wipes good figures; one snapshot per post per 45 minutes; the sync's report ─────────
alter table public.instagram_sync_log add column if not exists report jsonb;

create or replace function public.ig_keep_metrics() returns trigger language plpgsql set search_path = public as $$
begin
  new.reach := coalesce(new.reach, old.reach);
  new.saved := coalesce(new.saved, old.saved);
  new.shares := coalesce(new.shares, old.shares);
  new.views := coalesce(new.views, old.views);
  new.total_interactions := coalesce(new.total_interactions, old.total_interactions);
  new.profile_visits := coalesce(new.profile_visits, old.profile_visits);
  new.follows := coalesce(new.follows, old.follows);
  new.reposts := coalesce(new.reposts, old.reposts);
  new.avg_watch_time_ms := coalesce(new.avg_watch_time_ms, old.avg_watch_time_ms);
  new.total_watch_time_ms := coalesce(new.total_watch_time_ms, old.total_watch_time_ms);
  new.children_count := coalesce(new.children_count, old.children_count);
  new.thumbnail_url := coalesce(new.thumbnail_url, old.thumbnail_url);
  if new.insights is null then
    new.insights := old.insights;
    new.engagement := coalesce(old.engagement, new.engagement);
  elsif old.insights is not null then
    new.insights := old.insights || new.insights;        -- a metric Instagram stops sending keeps its last value
  end if;
  return new;
end $$;
create or replace trigger ig_keep_metrics before update on public.instagram_media
  for each row execute function public.ig_keep_metrics();

create or replace function public.ig_snapshot_once() returns trigger language plpgsql set search_path = public as $$
begin
  if new.reach is null and new.views is null and coalesce(new.metrics, '{}'::jsonb) = '{}'::jsonb then return null; end if;
  if exists (select 1 from public.instagram_media_snapshots s
              where s.media_id = new.media_id and s.captured_at > coalesce(new.captured_at, now()) - interval '45 minutes') then
    return null;                                          -- a second sync in the same window adds nothing
  end if;
  return new;
end $$;
create or replace trigger ig_snapshot_once before insert on public.instagram_media_snapshots
  for each row execute function public.ig_snapshot_once();

-- permissions: the anon key never touches Instagram data; signed-in users keep what RLS allows, minus TRUNCATE
revoke all on public.instagram_auth, public.instagram_media, public.instagram_daily, public.instagram_posts,
  public.instagram_sync_log, public.instagram_media_snapshots, public.instagram_audience from anon;
revoke truncate, trigger, references on public.instagram_auth, public.instagram_media, public.instagram_daily,
  public.instagram_posts, public.instagram_sync_log, public.instagram_media_snapshots, public.instagram_audience from authenticated;
revoke all on public.instagram_auth from authenticated;

-- ── small helpers ────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.ig_kind(p_product text, p_type text) returns text language sql immutable as $$
  select case when p_product = 'REELS' then 'reel' when p_type = 'CAROUSEL_ALBUM' then 'carousel'
              when p_type = 'VIDEO' then 'video' else 'image' end
$$;

-- Arabic-aware normal form: no diacritics or tatweel, one alef, ة→ه, ى→ي, Arabic digits→Latin, 71,400→71400
create or replace function public.ig_norm(t text) returns text language sql immutable as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           translate(lower(coalesce(t, '')), 'أإآٱةىؤئ٠١٢٣٤٥٦٧٨٩', 'ااااهيوي0123456789'),
           '[\u064B-\u0652\u0640]', '', 'g'), '([0-9])[,٬.]([0-9])', '\1\2', 'g'), '^ال|\sال', ' ', 'g'), '[^[:alnum:]]+', ' ', 'g'))
$$;

-- how much two captions share: shared words over the shorter caption's words (0 when either has under 4 words)
create or replace function public.ig_text_match(a text, b text) returns numeric language sql immutable as $$
  with x as (
    select array(select distinct w from regexp_split_to_table(public.ig_norm(left(a, 500)), '\s+') w where length(w) >= 3 or w ~ '^[0-9]+$') wa,
           array(select distinct w from regexp_split_to_table(public.ig_norm(left(b, 500)), '\s+') w where length(w) >= 3 or w ~ '^[0-9]+$') wb)
  select case when least(cardinality(wa), cardinality(wb)) < 4 then 0
              else round((select count(*) from unnest(wa) u where u = any (wb))::numeric / least(cardinality(wa), cardinality(wb)), 2) end
    from x
$$;

-- the first line of a caption, and what kind of opening it is
create or replace function public.ig_first_line(t text) returns text language sql immutable as $$
  select left(btrim(split_part(regexp_replace(coalesce(t, ''), '[\u2066-\u2069\t]', '', 'g'), E'\n', 1)), 140)
$$;
create or replace function public.ig_hook_type(t text) returns text language sql immutable as $$
  select case when public.ig_first_line(t) ~ '[؟?]' then 'سؤال'
              when public.ig_first_line(t) ~ '[0-9٠-٩]' then 'رقم'
              when public.ig_first_line(t) ~ '(^|\s)(من هو|من هي|قصة|بداية|سر|ليش|كيف|شلون)' then 'قصة'
              else 'جملة خبرية' end
$$;
create or replace function public.ig_content_type(t text) returns text language sql immutable as $$
  select case when t ~ '(ملخص)' then 'ملخص أسبوعي'
              when t ~ '(من هو|من هي|قصة|بداية|سر |ليش|كيف|شلون|تاريخ)' then 'قصة أو شرح'
              when t ~ '(معرض|افتتاح|بوتيك|حفل|جناح|تستضيف|دعوتكم|زيارة)' then 'فعالية أو معرض'
              when t ~ '(تطلق|تكشف|تضيف|توسع|تعيد|إصدار|اصدار|جديد)' then 'خبر إصدار'
              else 'أخرى' end
$$;
-- a weighted mean over the parts that exist
create or replace function public.ig_wmean(v numeric[], w numeric[]) returns numeric language sql immutable as $$
  select round(sum(v[i] * w[i]) / nullif(sum(w[i]) filter (where v[i] is not null), 0), 2)
    from generate_subscripts(v, 1) i where v[i] is not null
$$;

-- ── the studio's films and the Instagram post each became ─────────────────────────────────────────────────────────
create table if not exists public.studio_posts (
  film_id text primary key,
  kind text not null check (kind in ('reel', 'carousel')),
  username text not null default 'timekeeperkw',
  name text,
  version text,
  posted_at timestamptz,                         -- when the owner pressed «تم النشر»
  caption text,
  caption_hint text,                             -- the twin film's caption, for a film saved without one
  permalink text,                                -- given by the owner; wins over any guess
  attributes jsonb not null default '{}',        -- story, style, voice, seconds, length, language, topic ...
  media_id text references public.instagram_media(media_id),
  link_method text,                              -- permalink | caption | twin_caption
  link_score numeric,
  registered_at timestamptz not null default now(),
  linked_at timestamptz
);
create unique index if not exists studio_posts_media_once on public.studio_posts (media_id) where media_id is not null;
alter table public.studio_posts enable row level security;
revoke all on public.studio_posts from anon, authenticated;
comment on table public.studio_posts is 'Studio films (claude.ai studio artifact) and the Instagram post each became. Written by studio_sync().';

-- ── the figures of every post at a stage ──────────────────────────────────────────────────────────────────────────
-- latest: the newest read. 48h: the snapshot nearest 48 h (42-60 h). 7d: nearest 168 h (150-200 h). A post with no read
-- in that window is not in that stage: nothing is guessed. null = Instagram did not give it; 0 = a real zero.
create or replace function public.ig_reads(p_stage text default 'latest')
returns table(media_id text, username text, kind text, posted_at timestamptz, caption text, permalink text, children_count integer,
  read_at timestamptz, age_hours numeric, views integer, reach integer, likes integer, comments integer, saved integer, shares integer,
  follows integer, profile_visits integer, reposts integer, avg_watch_s numeric, skip_rate numeric, seconds numeric, watch_ratio numeric,
  views_pr numeric, likes_pr numeric, shares_pr numeric, saves_pr numeric, comments_pr numeric, follows_pr numeric)
language sql stable security definer set search_path = public as $$
  select m.media_id, m.username, public.ig_kind(m.media_product_type, m.media_type), m.posted_at, m.caption, m.permalink, m.children_count,
         x.read_at, x.age_hours, x.views, x.reach, x.likes, x.comments, x.saved, x.shares, x.follows, x.profile_visits, x.reposts,
         round(x.avg_watch_time_ms / 1000.0, 1), x.skip_rate, sp.seconds,
         round(x.avg_watch_time_ms / 1000.0 / nullif(sp.seconds, 0), 3),
         round(x.views::numeric / nullif(x.reach, 0), 3), round(x.likes::numeric / nullif(x.reach, 0), 5),
         round(x.shares::numeric / nullif(x.reach, 0), 5), round(x.saved::numeric / nullif(x.reach, 0), 5),
         round(x.comments::numeric / nullif(x.reach, 0), 5), round(x.follows::numeric / nullif(x.reach, 0), 6)
    from public.instagram_media m
    left join lateral (select (s.attributes->>'seconds')::numeric seconds from public.studio_posts s where s.media_id = m.media_id) sp on true
    cross join lateral (
      select m.synced_at read_at, round((extract(epoch from m.synced_at - m.posted_at) / 3600)::numeric, 1) age_hours,
             m.views, m.reach, m.like_count likes, m.comments_count comments, m.saved, m.shares, m.follows, m.profile_visits,
             m.reposts, m.avg_watch_time_ms, m.skip_rate
       where p_stage = 'latest'
      union all
      select * from (
        select sn.captured_at, sn.age_hours, sn.views, sn.reach, sn.likes, sn.comments, sn.saved, sn.shares, sn.follows,
               sn.profile_visits, sn.reposts, sn.avg_watch_time_ms, sn.skip_rate
          from public.instagram_media_snapshots sn
         where sn.media_id = m.media_id and p_stage in ('48h', '7d')
           and sn.age_hours between (case p_stage when '48h' then 42 else 150 end) and (case p_stage when '48h' then 60 else 200 end)
         order by abs(sn.age_hours - (case p_stage when '48h' then 48 else 168 end)) limit 1) s) x
   where x.reach > 0
$$;

-- ── one post, judged and explained in Arabic ──────────────────────────────────────────────────────────────────────
-- Answers: شنو نجح؟ شنو ما نجح؟ شنو الدليل؟ شنو نجرب بالفيديو القادم؟
create or replace function public.ig_post_report(p_media_id text, p_stage text default 'latest')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  r record; b record; rj jsonb; bj jsonb; sig record;
  cur text := p_stage; note text; basis text; comparable boolean; kind_ar text;
  val numeric; med numeric; ratio numeric; nmet int; state text; vtxt text; mtxt text; rawn numeric;
  ev jsonb := '[]'; worked jsonb := '[]'; didnt jsonb := '[]'; tryn jsonb := '[]'; nums jsonb := '{}';
  wsum numeric := 0; acc numeric := 0; nscored int := 0; score numeric; verdict text; label text;
  weakest text; weak_v numeric := 99; strongest text; strong_v numeric := 0; conf text;
  good jsonb := '{"reach":"الخوارزمية وصّلته لناس أكثر","shares_pr":"الناس أرسلوه لغيرهم أكثر من العادة","saves_pr":"حفظوه يرجعون له",
    "likes_pr":"عجبهم أكثر من العادة","comments_pr":"فتح كلام بالتعليقات","follows_pr":"جاب متابعين أكثر من العادة",
    "skip_rate":"الافتتاحية مسكت: قليل اللي تخطّوه","avg_watch_s":"تابعوه وقت أطول من العادة"}';
  bad jsonb := '{"reach":"وصل لناس أقل من العادة","shares_pr":"قليل اللي أرسلوه لغيرهم","saves_pr":"قليل اللي حفظوه",
    "likes_pr":"اللايكات أقل من العادة","comments_pr":"التعليقات أقل من العادة","follows_pr":"ما جاب متابعين مثل العادة",
    "skip_rate":"الافتتاحية ما مسكت: كثير تخطّوه بأول 3 ثواني","avg_watch_s":"طلعوا بدري"}';
  fix jsonb := '{"skip_rate":"الافتتاحية: حط النتيجة أو السؤال بأول ثانيتين، بدون مقدمة.",
    "avg_watch_s":"الوسط: قصّره، وخلّ كل 3–4 ثواني فيها معلومة أو لقطة جديدة.",
    "shares_pr":"الخاتمة: معلومة يتفاخر فيها اللي يرسلها، أو سؤال يخليه يرسله لربعه.",
    "saves_pr":"زيد شي يرجعون له: أرقام، قائمة، أو مقارنة.",
    "likes_pr":"أول لقطة أو الغلاف: أوضح وأجمل.",
    "reach":"الغلاف وأول سطر بالكابشن: سؤال أوضح، وجرّب وقت نشر ثاني من الوصفة.",
    "follows_pr":"اختم بسبب للمتابعة: جزء ثاني أو سلسلة.",
    "comments_pr":"اختم بسؤال سهل يجاوبونه بكلمة."}';
  keep jsonb := '{"skip_rate":"نفس نوع الافتتاحية","avg_watch_s":"نفس الإيقاع والطول","shares_pr":"نفس نوع المعلومة اللي تنرسل",
    "saves_pr":"نفس كمية الأرقام والمعلومات","likes_pr":"نفس جودة الصورة الأولى","reach":"نفس الموضوع ووقت النشر",
    "follows_pr":"نفس الخاتمة","comments_pr":"نفس سؤال الخاتمة"}';
begin
  select * into r from ig_reads(cur) x where x.media_id = p_media_id;
  if not found and p_stage = '7d' then
    select * into r from ig_reads('latest') x where x.media_id = p_media_id and x.age_hours >= 168;
    if found then cur := 'latest'; note := format('ما فيه قراءة عند 7 أيام بالضبط؛ هذي آخر قراءة (عمره %s يوم).', round(r.age_hours / 24)); end if;
  end if;
  if r.media_id is null then
    return jsonb_build_object('media_id', p_media_id, 'stage', p_stage, 'available', false,
      'reason', case when p_stage = '48h' then 'ما فيه قراءة عند 48 ساعة لهالمنشور.' when p_stage = '7d' then 'ما وصل 7 أيام للحين.'
                     else 'المنشور مو موجود أو إنستغرام ما عطانا أرقامه.' end);
  end if;
  kind_ar := case r.kind when 'reel' then 'ريل' when 'carousel' then 'كاروسيل' when 'video' then 'فيديو' else 'صورة' end;

  -- the baseline: up to 30 earlier posts of the same format on the same account (120 days), at the same age when 5+
  -- have a read there; otherwise their final figures (posts a week old or more)
  select count(*) n, count(reach) n_reach, count(shares_pr) n_shares_pr, count(saves_pr) n_saves_pr, count(likes_pr) n_likes_pr,
         count(comments_pr) n_comments_pr, count(follows_pr) n_follows_pr, count(skip_rate) n_skip_rate, count(avg_watch_s) n_avg_watch_s,
         count(watch_ratio) n_watch_ratio, count(views) n_views,
         percentile_cont(0.5) within group (order by s.reach) reach, percentile_cont(0.5) within group (order by s.shares_pr) shares_pr,
         percentile_cont(0.5) within group (order by s.saves_pr) saves_pr, percentile_cont(0.5) within group (order by s.likes_pr) likes_pr,
         percentile_cont(0.5) within group (order by s.comments_pr) comments_pr, percentile_cont(0.5) within group (order by s.follows_pr) follows_pr,
         percentile_cont(0.5) within group (order by s.skip_rate) skip_rate, percentile_cont(0.5) within group (order by s.avg_watch_s) avg_watch_s,
         percentile_cont(0.5) within group (order by s.watch_ratio) watch_ratio, percentile_cont(0.5) within group (order by s.views) views
    into b
    from (select * from ig_reads(cur) x where x.username = r.username and x.kind = r.kind and x.media_id <> r.media_id
             and x.posted_at < r.posted_at and x.posted_at > r.posted_at - interval '120 days'
           order by x.posted_at desc limit 30) s;
  basis := 'same_stage';
  if cur = 'latest' or b.n < 5 then
    select count(*) n, count(reach) n_reach, count(shares_pr) n_shares_pr, count(saves_pr) n_saves_pr, count(likes_pr) n_likes_pr,
           count(comments_pr) n_comments_pr, count(follows_pr) n_follows_pr, count(skip_rate) n_skip_rate, count(avg_watch_s) n_avg_watch_s,
           count(watch_ratio) n_watch_ratio, count(views) n_views,
           percentile_cont(0.5) within group (order by s.reach) reach, percentile_cont(0.5) within group (order by s.shares_pr) shares_pr,
           percentile_cont(0.5) within group (order by s.saves_pr) saves_pr, percentile_cont(0.5) within group (order by s.likes_pr) likes_pr,
           percentile_cont(0.5) within group (order by s.comments_pr) comments_pr, percentile_cont(0.5) within group (order by s.follows_pr) follows_pr,
           percentile_cont(0.5) within group (order by s.skip_rate) skip_rate, percentile_cont(0.5) within group (order by s.avg_watch_s) avg_watch_s,
           percentile_cont(0.5) within group (order by s.watch_ratio) watch_ratio, percentile_cont(0.5) within group (order by s.views) views
      into b
      from (select * from ig_reads('latest') x where x.username = r.username and x.kind = r.kind and x.media_id <> r.media_id
               and x.age_hours >= 168 and x.posted_at < r.posted_at and x.posted_at > r.posted_at - interval '120 days'
             order by x.posted_at desc limit 30) s;
    basis := 'final';
  end if;
  comparable := basis = 'same_stage' or r.age_hours >= 144;
  rj := to_jsonb(r); bj := to_jsonb(b);

  -- the signals Meta names, per format; views are shown, never scored
  for sig in select * from (values
      ('reel', 'reach', 'الوصول', 0.25, 1), ('reel', 'shares_pr', 'المشاركات', 0.25, 1), ('reel', 'skip_rate', 'تخطّوه بأول 3 ثواني', 0.15, -1),
      ('reel', 'avg_watch_s', 'متوسط المشاهدة', 0.15, 1), ('reel', 'saves_pr', 'الحفظ', 0.10, 1), ('reel', 'likes_pr', 'اللايكات', 0.10, 1),
      ('feed', 'reach', 'الوصول', 0.30, 1), ('feed', 'shares_pr', 'المشاركات', 0.25, 1), ('feed', 'saves_pr', 'الحفظ', 0.20, 1),
      ('feed', 'likes_pr', 'اللايكات', 0.10, 1), ('feed', 'follows_pr', 'متابعين جدد', 0.10, 1), ('feed', 'comments_pr', 'التعليقات', 0.05, 1)
    ) v(fmt, k, label, w, dir) where v.fmt = case when r.kind = 'reel' then 'reel' else 'feed' end loop
    val := (rj->>sig.k)::numeric; med := (bj->>sig.k)::numeric; nmet := coalesce((bj->>('n_' || sig.k))::int, 0); ratio := null;
    rawn := case sig.k when 'shares_pr' then r.shares when 'saves_pr' then r.saved when 'likes_pr' then r.likes
                       when 'comments_pr' then r.comments when 'follows_pr' then r.follows end;
    vtxt := case when val is null then 'غير متوفر'
                 when sig.k = 'reach' then to_char(val, 'FM999,999,990')
                 when sig.k = 'skip_rate' then round(val, 1) || '%'
                 when sig.k = 'avg_watch_s' then round(val, 1) || ' ث'
                 else to_char(rawn, 'FM999,999,990') || ' · ' || round(val * 1000, 1) || ' لكل 1000' end;
    mtxt := case when med is null or nmet < 5 then '—'
                 when sig.k = 'reach' then to_char(round(med), 'FM999,999,990')
                 when sig.k = 'skip_rate' then round(med, 1) || '%'
                 when sig.k = 'avg_watch_s' then round(med, 1) || ' ث'
                 else round(med * 1000, 1) || ' لكل 1000' end;
    if val is null then state := 'na';
    elsif sig.k = 'reach' and not comparable then state := 'nc';
    elsif nmet < 5 or med is null then state := 'nobase';
    elsif med = 0 then state := case when val > 0 then 'good' else 'mid' end;
    else
      ratio := round(least(greatest(case when sig.dir = 1 then val / med when val = 0 then 3 else med / val end, 0), 3), 2);
      state := case when ratio >= 1.2 then 'good' when ratio <= 0.8 then 'bad' else 'mid' end;
      acc := acc + sig.w * ratio; wsum := wsum + sig.w; nscored := nscored + 1;
      if ratio < weak_v then weak_v := ratio; weakest := sig.k; end if;
      if ratio > strong_v then strong_v := ratio; strongest := sig.k; end if;
    end if;
    ev := ev || jsonb_build_object('k', sig.k, 'label', sig.label, 'value', vtxt, 'usual', mtxt, 'ratio', ratio, 'state', state,
      'note', case state when 'na' then 'إنستغرام ما عطاه' when 'nc' then 'ما ينقارن الحين: المنشور عمره ' || round(r.age_hours) || ' ساعة والمعتاد أرقام نهائية'
                         when 'nobase' then 'ما عندنا منشورات كفاية للمقارنة' end);
    if state = 'good' then worked := worked || to_jsonb((good->>sig.k) || ': ' || vtxt || case when mtxt <> '—' then '، والمعتاد ' || mtxt else '' end || case when ratio is not null then ' (×' || ratio || ').' else '.' end); end if;
    if state = 'bad' then didnt := didnt || to_jsonb((bad->>sig.k) || ': ' || vtxt || '، والمعتاد ' || mtxt || ' (×' || ratio || ').'); end if;
    if val is not null then nums := nums || jsonb_build_object(sig.label, vtxt); end if;
  end loop;

  -- shown, not scored
  ev := ev || jsonb_build_object('k', 'views', 'label', 'المشاهدات', 'value', coalesce(to_char(r.views, 'FM999,999,990'), 'غير متوفر'),
    'usual', case when b.n_views >= 5 and comparable then to_char(round(b.views), 'FM999,999,990') else '—' end, 'state', 'info',
    'note', 'للعلم: ما نحكم بالمشاهدات بروحها');
  if r.views is not null then nums := nums || jsonb_build_object('المشاهدات', to_char(r.views, 'FM999,999,990')); end if;
  if r.kind = 'reel' then
    ev := ev || jsonb_build_object('k', 'watch_ratio', 'label', 'شافوا من طول الفيلم',
      'value', case when r.watch_ratio is not null then round(r.watch_ratio * 100) || '% (' || r.avg_watch_s || ' من ' || r.seconds || ' ث)' else 'غير متوفر' end,
      'usual', case when b.n_watch_ratio >= 5 then round(b.watch_ratio * 100) || '%' else '—' end,
      'state', case when r.watch_ratio is null then 'na' else 'info' end,
      'note', case when r.watch_ratio is null then 'طول الفيلم مو مسجل' when b.n_watch_ratio < 5 then 'ما عندنا أفلام كفاية للمقارنة' end);
    ev := ev || jsonb_build_object('k', 'follows', 'label', 'متابعين جدد', 'value', 'غير متوفر', 'usual', '—', 'state', 'na',
      'note', 'إنستغرام ما يعطي المتابعين الجدد للريلز');
    if r.watch_ratio is not null then nums := nums || jsonb_build_object('شافوا من طوله', round(r.watch_ratio * 100) || '%'); end if;
  end if;

  score := round(acc / nullif(wsum, 0), 2);
  if nscored >= 3 and r.age_hours >= 12 then
    verdict := case when score >= 1.2 then 'good' when score <= 0.8 then 'bad' else 'mid' end;
    label := case verdict when 'good' then 'ناجح' when 'bad' then 'ضعيف' else 'متوسط' end || ' ×' || score;
  end if;
  conf := case when nscored < 3 or r.age_hours < 24 then 'low'
               when basis = 'same_stage' and b.n >= 15 and nscored >= 4 then 'high'
               when b.n >= 8 and comparable then 'medium' else 'low' end;

  if jsonb_array_length(worked) = 0 then worked := '["ما فيه رقم فوق المعتاد بوضوح."]'; end if;
  if jsonb_array_length(didnt) = 0 then didnt := '["ما فيه رقم تحت المعتاد بوضوح."]'; end if;
  if weakest is not null and weak_v < 1 then tryn := tryn || to_jsonb(fix->>weakest); end if;
  if strongest is not null and strong_v >= 1.2 then tryn := tryn || to_jsonb('خلّ ' || (keep->>strongest) || '، هذا اللي نجح هني.'); end if;
  if weakest is null or weak_v >= 1 then tryn := tryn || '"جرّب فكرة جديدة وحدة (أسلوب أو موضوع): النجاح ما يعني نوقف التجارب."'::jsonb; end if;
  tryn := tryn || '"غيّر شي واحد بس بالفيديو القادم، عشان نعرف أثره."'::jsonb;

  return jsonb_build_object(
    'media_id', r.media_id, 'username', r.username, 'kind', r.kind, 'permalink', r.permalink,
    'stage', p_stage, 'read_stage', cur, 'at', r.read_at, 'age_hours', r.age_hours, 'available', true, 'source', 'instagram',
    'verdict', verdict, 'label', coalesce(case when label is not null and r.age_hours < 36 then 'مبدئي · ' || label else label end,
                                       case when r.age_hours < 12 then 'بدري نحكم' else 'ما نقدر نحكم' end), 'score', score,
    'confidence', conf, 'confidence_ar', case conf when 'high' then 'ثقة عالية' when 'medium' then 'ثقة متوسطة' else 'ثقة منخفضة' end,
    'vs', case when b.n = 0 then 'ما فيه ' || kind_ar || ' قبله بهالحساب نقارن فيه.'
               else format('مقارنة بوسيط آخر %s %s بنفس الحساب%s.', b.n, kind_ar,
                           case basis when 'same_stage' then ' بنفس العمر' else ' بأرقامها النهائية' end) end,
    'basis', basis, 'baseline_posts', b.n, 'signals_compared', nscored,
    'worked', worked, 'didnt', didnt, 'evidence', ev, 'try_next', tryn,
    'note', nullif(concat_ws(' ', note, case when r.age_hours < 24 then format('المنشور جديد (%s ساعة)، الحكم مبدئي.', round(r.age_hours)) end,
                      case when b.n < 5 then 'ما عندنا تاريخ كافي لهالنوع بهالحساب.' end), ''),
    'caveat', 'الأرقام تقول شنو صار، مو أكيد ليش. السبب يحتاج يتكرر بأكثر من منشور قبل ما نعتمده.',
    'numbers', nums, 'lessons', worked || didnt, 'next', tryn);
end $$;

-- ── what goes with good results on one account ────────────────────────────────────────────────────────────────────
-- Final posts (a week old+, last p_days) get a score against their format's median on that account (same signals and
-- weights as the reports). Posts are grouped by when they went up, the opening line, the content type, caption length,
-- hashtags, slide count and the studio's own tags. A group is a pattern only with 5+ posts, 5+ posts outside it, a 25%+
-- gap and a share of good posts unlikely by chance; its confidence grows with size and consistency. Correlation, labelled so.
create or replace function public.ig_recipe(p_username text default 'timekeeperkw', p_days integer default 120)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  with p as (
    select x.*, (x.posted_at at time zone 'Asia/Kuwait') kw, sp.attributes sa, sp.film_id
      from ig_reads('latest') x left join studio_posts sp on sp.media_id = x.media_id
     where x.username = p_username and x.kind in ('reel', 'carousel') and x.age_hours >= 168
       and x.posted_at > now() - make_interval(days => p_days)),
  med as (
    select kind, count(*) n,
           percentile_cont(0.5) within group (order by reach) reach, percentile_cont(0.5) within group (order by shares_pr) spr,
           percentile_cont(0.5) within group (order by saves_pr) svr, percentile_cont(0.5) within group (order by likes_pr) lpr,
           percentile_cont(0.5) within group (order by comments_pr) cpr, percentile_cont(0.5) within group (order by follows_pr) fpr,
           percentile_cont(0.5) within group (order by avg_watch_s) aw, percentile_cont(0.5) within group (order by skip_rate) sk,
           percentile_cont(0.25) within group (order by skip_rate) sk_p25, percentile_cont(0.75) within group (order by avg_watch_s) aw_p75,
           percentile_cont(0.75) within group (order by shares_pr) spr_p75, percentile_cont(0.75) within group (order by saves_pr) svr_p75,
           percentile_cont(0.75) within group (order by reach) reach_p75
      from p group by kind),
  scored as (
    select p.*, case when p.kind = 'reel' then
             ig_wmean(array[least(p.reach / nullif(m.reach, 0), 3), least(p.shares_pr / nullif(m.spr, 0), 3), least(m.sk / nullif(p.skip_rate, 0), 3),
                            least(p.avg_watch_s / nullif(m.aw, 0), 3), least(p.saves_pr / nullif(m.svr, 0), 3), least(p.likes_pr / nullif(m.lpr, 0), 3)]::numeric[],
                      array[0.25, 0.25, 0.15, 0.15, 0.10, 0.10]::numeric[])
           else
             ig_wmean(array[least(p.reach / nullif(m.reach, 0), 3), least(p.shares_pr / nullif(m.spr, 0), 3), least(p.saves_pr / nullif(m.svr, 0), 3),
                            least(p.likes_pr / nullif(m.lpr, 0), 3), least(p.follows_pr / nullif(m.fpr, 0), 3), least(p.comments_pr / nullif(m.cpr, 0), 3)]::numeric[],
                      array[0.30, 0.25, 0.20, 0.10, 0.10, 0.05]::numeric[]) end score
      from p join med m using (kind)),
  feats as (
    select kind, score, 'وقت النشر' dim,
           case when extract(hour from kw) between 6 and 11 then 'الصبح (6–12)' when extract(hour from kw) between 12 and 16 then 'الظهر (12–5)'
                when extract(hour from kw) between 17 and 20 then 'العصر والمغرب (5–9)' else 'الليل (9 وبعد)' end val, false studio from scored
    union all select kind, score, 'اليوم', (array['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'])[extract(dow from kw)::int + 1], false from scored
    union all select kind, score, 'أول سطر', ig_hook_type(caption), false from scored
    union all select kind, score, 'نوع المحتوى', ig_content_type(caption), false from scored
    union all select kind, score, 'طول الكابشن', case when length(coalesce(caption, '')) < 150 then 'قصير' when length(caption) < 600 then 'متوسط' else 'طويل' end, false from scored
    union all select kind, score, 'الهاشتاقات', case when coalesce(caption, '') !~ '#' then 'بدون' when (select count(*) from regexp_matches(caption, '#', 'g')) <= 5 then '1–5' else '6+' end, false from scored
    union all select kind, score, 'عدد الشرائح', case when children_count <= 5 then '5 أو أقل' when children_count <= 9 then '6–9' else '10+' end, false
      from scored where kind = 'carousel' and children_count is not null
    union all select s.kind, s.score, a.key, a.value, true
      from scored s, jsonb_each_text(coalesce(s.sa, '{}')) a
     where a.key in ('القصة', 'الأسلوب', 'الصوت', 'الطول', 'اللغة', 'الموسيقى', 'الموضوع')),
  overall as (select kind, percentile_cont(0.5) within group (order by score) med, count(*) n from scored group by kind),
  groups as (
    select f.kind, f.dim, f.val, f.studio, count(*) n, o.n n_all,
           round((percentile_cont(0.5) within group (order by f.score) / nullif(o.med, 0))::numeric, 2) vs_all,
           round(avg((f.score > o.med)::int)::numeric, 2) above
      from feats f join overall o using (kind) where f.score is not null group by f.kind, f.dim, f.val, f.studio, o.med, o.n),
  rated as (
    -- z: how far the share of the group's posts above the format median is from a coin flip; strict, because many
    -- groups are tried at once and chance alone makes some of them look good
    select g.*, case when g.n >= 20 and abs(g.vs_all - 1) >= 0.3 and abs(g.z) >= 2.5 then 'high'
                     when g.n >= 10 and abs(g.vs_all - 1) >= 0.25 and abs(g.z) >= 2 then 'medium'
                     when g.n >= 5 and abs(g.vs_all - 1) >= 0.25 and abs(g.z) >= 1.5 then 'low' end conf
      from (select g0.*, round(((g0.above - 0.5) / sqrt(0.25 / g0.n))::numeric, 2) z from groups g0) g
     where g.n_all - g.n >= 5)
  select jsonb_build_object(
    'username', p_username, 'days', p_days, 'updated', now(),
    'posts', coalesce((select jsonb_object_agg(kind, n) from overall), '{}'),
    'studio_posts', (select count(*) from scored where film_id is not null),
    'targets', coalesce((select jsonb_object_agg(kind, jsonb_strip_nulls(jsonb_build_object(
        'reach', round(reach), 'reach_good', round(reach_p75),
        'shares_per_1000', round((spr * 1000)::numeric, 1), 'shares_per_1000_good', round((spr_p75 * 1000)::numeric, 1),
        'saves_per_1000', round((svr * 1000)::numeric, 1), 'saves_per_1000_good', round((svr_p75 * 1000)::numeric, 1),
        'avg_watch_s', round(aw::numeric, 1), 'avg_watch_s_good', round(aw_p75::numeric, 1),
        'skip_rate', round(sk::numeric, 1), 'skip_rate_good', round(sk_p25::numeric, 1)))) from med), '{}'),
    'top', coalesce((select jsonb_agg(x) from (select kind, media_id, permalink, to_char(kw, 'YYYY-MM-DD') as day, ig_first_line(caption) opening,
              score, skip_rate, avg_watch_s, reach, shares from scored where score is not null order by score desc limit 6) x), '[]'),
    'best_openings', coalesce((select jsonb_agg(x) from (select media_id, permalink, ig_first_line(caption) opening, skip_rate, avg_watch_s
              from scored where kind = 'reel' and skip_rate is not null order by skip_rate asc limit 3) x), '[]'),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'kind', kind, 'dim', dim, 'val', val, 'n', n, 'vs', vs_all, 'above', above, 'z', z, 'studio', studio,
        'confidence', conf, 'confidence_ar', case conf when 'high' then 'ثقة عالية' when 'medium' then 'ثقة متوسطة' else 'ثقة منخفضة' end,
        'rule', case when kind = 'reel' then 'الريلز' else 'الكاروسيل' end || ' · ' || dim || ': «' || val || '» '
                || case when vs_all > 1 then 'يجي معاه أداء أعلى' else 'يجي معاه أداء أقل' end,
        'why', format('%s منشور، أداؤها ×%s من وسيط %s، و%s%% منها فوق الوسيط.', n, vs_all,
                      case when kind = 'reel' then 'الريلز' else 'الكاروسيلات' end, round(above * 100)),
        'from', 'أرقام إنستغرام · آخر ' || p_days || ' يوم · علاقة، مو سبب مثبت')
        order by case conf when 'high' then 0 when 'medium' then 1 else 2 end, abs(vs_all - 1) desc) from rated where conf is not null), '[]'),
    'needs_data', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'dim', dim, 'val', val, 'n', n, 'need', 5 - n))
        from groups where studio and n < 5), '[]'),
    'caveat', 'هذي علاقات من أرقامنا، مو أسباب مثبتة. المحتوى والوقت يتداخلون، فأي نمط نجربه عمداً قبل ما نعتمده.')
    into res;
  return res;
end $$;

-- ── before the next film: what the history says, with confidence, and what to test ───────────────────────────────
create or replace function public.ig_brief(p_recipe jsonb, p_kind text default 'reel')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  t jsonb := p_recipe->'targets'->p_kind; items jsonb; sections jsonb := '[]'; tests jsonb := '[]';
  n_posts int := coalesce((p_recipe->'posts'->>p_kind)::int, 0); n_studio int; s jsonb; tried text[];
  kind_ar text := case when p_kind = 'reel' then 'الريلز' else 'الكاروسيلات' end;
  best_open text; lo numeric; hi numeric;
begin
  select min((attributes->>'seconds')::numeric), max((attributes->>'seconds')::numeric) into lo, hi
    from studio_posts where kind = 'reel' and media_id is not null and username = p_recipe->>'username';
  select coalesce(jsonb_agg(i), '[]') into items from jsonb_array_elements(coalesce(p_recipe->'items', '[]')) i where i->>'kind' = p_kind;
  select count(*) into n_studio from studio_posts where kind = p_kind and media_id is not null and username = p_recipe->>'username';

  -- 1. the opening
  select string_agg(format('«%s» (%s%% تخطّوه)', o->>'opening', o->>'skip_rate'), ' · ') into best_open
    from jsonb_array_elements(coalesce(p_recipe->'best_openings', '[]')) o where p_kind = 'reel';
  s := (select i from jsonb_array_elements(items) i where i->>'dim' = 'أول سطر' order by (i->>'vs')::numeric desc limit 1);
  sections := sections || jsonb_build_object('key', 'hook', 'title', 'الافتتاحية',
    'advice', coalesce(case when s is not null and (s->>'vs')::numeric > 1 then 'افتح بـ«' || (s->>'val') || '»: ' || (s->>'why') end,
                       case when p_kind = 'reel' then 'حط النتيجة أو السؤال بأول ثانيتين. الناس يقررون بأول 3 ثواني.'
                            else 'الغلاف: سؤال أو رقم واضح بسطرين.' end),
    'evidence', case when p_kind = 'reel' and t ? 'skip_rate' then
                  format('عندنا %s%% يتخطّون الريل بالعادة، وأحسن ربع ريلز تحت %s%%. هذا هدف الافتتاحية.', t->>'skip_rate', t->>'skip_rate_good')
                  || coalesce(' أقوى افتتاحيات (أول سطر بالكابشن): ' || best_open || '.', '')
                when t ? 'shares_per_1000' then format('المعتاد %s مشاركة لكل 1000 وصول، وأحسن ربع فوق %s.', t->>'shares_per_1000', t->>'shares_per_1000_good') end,
    'confidence', coalesce(s->>'confidence', 'principle'),
    'confidence_ar', coalesce(s->>'confidence_ar', 'مبدأ عام من Meta، مو من أرقامنا'));

  -- 2. the visual style and 3. the storytelling: the studio's own tags once 5+ films carry them; until then, say so
  for s in select * from jsonb_array_elements(jsonb_build_array(
      jsonb_build_object('key', 'style', 'title', 'الأسلوب البصري', 'dim', 'الأسلوب'),
      jsonb_build_object('key', 'story', 'title', 'طريقة السرد', 'dim', 'القصة'))) loop
    sections := sections || coalesce((
      select jsonb_build_object('key', s->>'key', 'title', s->>'title',
        'advice', case when (i->>'vs')::numeric > 1 then '«' || (i->>'val') || '» يجي معاه أداء أعلى عندنا.' else '«' || (i->>'val') || '» يجي معاه أداء أقل عندنا.' end,
        'evidence', i->>'why', 'confidence', i->>'confidence', 'confidence_ar', i->>'confidence_ar')
        from jsonb_array_elements(items) i where i->>'dim' = s->>'dim' order by abs((i->>'vs')::numeric - 1) desc limit 1),
      (select jsonb_build_object('key', s->>'key', 'title', s->>'title',
        'advice', case when s->>'key' = 'story' and c is not null then '«' || (c->>'val') || '» '
                       || case when (c->>'vs')::numeric > 1 then 'يجي معاه أداء أعلى بالحساب كله.' else 'يجي معاه أداء أقل بالحساب كله.' end
                       else 'ما عندنا أفلام كفاية نقارن فيها. اختار اللي يناسب القصة.' end,
        'evidence', format('مربوط %s من أفلام الاستوديو (%s)، ونحتاج 5 لكل %s عشان نقارن.', n_studio, kind_ar, case when s->>'key' = 'style' then 'أسلوب' else 'نوع سرد' end)
                    || case when s->>'key' = 'story' and c is not null then ' ' || (c->>'why') else '' end,
        'confidence', case when s->>'key' = 'story' and c is not null then c->>'confidence' else 'not_enough' end,
        'confidence_ar', case when s->>'key' = 'story' and c is not null then c->>'confidence_ar' else 'البيانات ما تكفي' end)
        from (select (select i from jsonb_array_elements(items) i where i->>'dim' = 'نوع المحتوى' order by (i->>'vs')::numeric desc limit 1) c) cc));
  end loop;

  -- 4. the length
  sections := sections || case when p_kind = 'reel' then jsonb_build_object('key', 'length', 'title', 'الطول',
      'advice', case when t ? 'avg_watch_s' then format('حط أهم معلومة قبل الثانية %s: هذا متوسط اللي يشوفونه من ريلزنا.', round((t->>'avg_watch_s')::numeric)) else 'ما عندنا وقت مشاهدة كافي.' end,
      'evidence', case when t ? 'avg_watch_s' then format('متوسط المشاهدة عندنا %s ث، وأحسن ربع فوق %s ث.', t->>'avg_watch_s', t->>'avg_watch_s_good')
                  || case when lo is not null then format(' أفلامنا المنشورة %s ث، يعني أغلب الناس ما يوصلون نصها.', case when lo = hi then lo::text else lo || '–' || hi end) else '' end end,
      'confidence', case when n_posts >= 15 then 'medium' else 'low' end,
      'confidence_ar', case when n_posts >= 15 then 'ثقة متوسطة' else 'ثقة منخفضة' end)
    else coalesce((select jsonb_build_object('key', 'length', 'title', 'عدد الشرائح',
        'advice', '«' || (i->>'val') || '» شريحة ' || case when (i->>'vs')::numeric > 1 then 'تجي معاها نتائج أعلى.' else 'تجي معاها نتائج أقل.' end,
        'evidence', i->>'why', 'confidence', i->>'confidence', 'confidence_ar', i->>'confidence_ar')
        from jsonb_array_elements(items) i where i->>'dim' = 'عدد الشرائح' order by abs((i->>'vs')::numeric - 1) desc limit 1),
      jsonb_build_object('key', 'length', 'title', 'عدد الشرائح', 'advice', 'ما فيه فرق واضح بعدد الشرائح عندنا.', 'confidence', 'not_enough', 'confidence_ar', 'البيانات ما تكفي')) end;

  -- 5. when to post
  sections := sections || coalesce((select jsonb_build_object('key', 'time', 'title', 'وقت النشر',
      'advice', '«' || (i->>'val') || '» ' || case when (i->>'vs')::numeric > 1 then 'يجي معاه أداء أعلى.' else 'يجي معاه أداء أقل.' end,
      'evidence', i->>'why', 'confidence', i->>'confidence', 'confidence_ar', i->>'confidence_ar')
      from jsonb_array_elements(items) i where i->>'dim' = 'وقت النشر' order by (i->>'vs')::numeric desc limit 1),
    jsonb_build_object('key', 'time', 'title', 'وقت النشر', 'advice', 'ما فيه وقت أحسن بوضوح عندنا.', 'confidence', 'not_enough', 'confidence_ar', 'البيانات ما تكفي'));

  -- what to test: one fix aimed at our weakest signal, one thing we have not tried, and always one wild card
  select array_agg(distinct a.value) into tried from studio_posts sp, jsonb_each_text(sp.attributes) a
   where sp.media_id is not null and sp.kind = p_kind and a.key = 'الأسلوب';
  if p_kind = 'reel' then
    tests := tests || jsonb_build_object('idea', 'افتتاحية بالنتيجة أو السؤال بأول ثانيتين، بدون شعار أو مقدمة.',
      'why', case when t ? 'skip_rate' then format('التخطي عندنا %s%%؛ الهدف تحت %s%%.', t->>'skip_rate', t->>'skip_rate_good') else 'التخطي أول إشارة تقرا فيها إنستغرام الريل.' end,
      'measure', 'نسبة التخطي بأول 3 ثواني عند 48 ساعة');
  else
    tests := tests || jsonb_build_object('idea', 'آخر شريحة: معلومة تنرسل أو سؤال لصديق.',
      'why', case when t ? 'shares_per_1000' then format('المشاركات عندنا %s لكل 1000؛ أحسن ربع فوق %s.', t->>'shares_per_1000', t->>'shares_per_1000_good') else 'المشاركات أقوى إشارة للوصول.' end,
      'measure', 'المشاركات لكل 1000 وصول عند 7 أيام');
  end if;
  tests := tests || coalesce((select jsonb_build_object('idea', 'جرّب أسلوب «' || st || '»', 'why', 'ما نشرنا فيه شي للحين، فما نعرف أثره.', 'measure', 'نفس مقاييس التقرير')
                                from unnest(array['ورقي', 'نقش النحاس', 'آرت ديكو', 'بيانات', 'رسم تقني']) st
                               where st <> all (coalesce(tried, '{}')) limit 1),
                     jsonb_build_object('idea', 'جرّب موضوع أو أسلوب ما سويناه', 'why', 'حتى لو شي ناجح، نخلي مكان للتجربة.', 'measure', 'نفس مقاييس التقرير'));

  return jsonb_build_object('kind', p_kind, 'username', p_recipe->>'username', 'updated', now(),
    'sample', jsonb_build_object('posts', n_posts, 'studio_posts', n_studio),
    'targets', coalesce(t, '{}'), 'sections', sections, 'test_next', tests,
    'review', 'توصيات للمراجعة. القواعد ما تتغير إلا بموافقتك، ونخلي مكان للتجارب دايماً.');
end $$;

-- ── the studio's films: register, link, report ────────────────────────────────────────────────────────────────────
-- A film's tags come from its own record (meta, seconds, topic, rules), so the learning can group films by them.
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
    'seconds', secs, 'slides', case when jsonb_typeof(f->'slides') = 'array' then jsonb_array_length(f->'slides') end,
    'rules', f->'rules')) || coalesce(f->'attributes', '{}')
    from m
$$;

create or replace function public.studio_link_posts() returns integer language plpgsql security definer set search_path = public as $$
declare sp record; mid text; how text; sc numeric; sc2 numeric; linked int := 0; t0 timestamptz;
begin
  for sp in select * from studio_posts where media_id is null order by (caption is null), registered_at loop
    mid := null; how := null; sc := null; t0 := coalesce(sp.posted_at, sp.registered_at);
    if sp.permalink is not null then
      select m.media_id into mid from instagram_media m
       where rtrim(split_part(m.permalink, '?', 1), '/') = rtrim(split_part(sp.permalink, '?', 1), '/') limit 1;
      if mid is not null then how := 'permalink'; sc := 1; end if;
    end if;
    if mid is null and coalesce(sp.caption, sp.caption_hint) is not null then
      -- the best caption match, and only when no other post comes close (two near-equal matches = no link)
      select (array_agg(c.media_id order by c.sc desc, c.dt))[1], (array_agg(c.sc order by c.sc desc, c.dt))[1],
             (array_agg(c.sc order by c.sc desc, c.dt))[2]
        into mid, sc, sc2
        from (select m.media_id, ig_text_match(coalesce(sp.caption, sp.caption_hint), m.caption) sc, abs(extract(epoch from m.posted_at - t0)) dt
                from instagram_media m
               where m.username = sp.username and ig_kind(m.media_product_type, m.media_type) = sp.kind
                 and m.posted_at between t0 - interval '5 days' and t0 + interval '1 day'
                 and not exists (select 1 from studio_posts o where o.media_id = m.media_id)) c;
      if sc >= (case when sp.caption is not null then 0.6 else 0.5 end) and coalesce(sc2, 0) < sc - 0.15 then
        how := case when sp.caption is not null then 'caption' else 'twin_caption' end;
      else mid := null; end if;
    end if;
    if mid is not null then
      update studio_posts set media_id = mid, link_method = how, link_score = sc, linked_at = now() where film_id = sp.film_id;
      linked := linked + 1;
    end if;
  end loop;
  return linked;
end $$;

-- One call for the studio: register the films it sends, link them, and return each linked film's reports (48 h, 7 days,
-- latest), the account's patterns and the briefs. p = {films: [<film record with its id>, ...]}.
create or replace function public.studio_sync(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare f jsonb; out_films jsonb := '{}'; sp record; rep jsonb; reps jsonb; recipe jsonb; accounts jsonb := '{}'; acc text;
begin
  for f in select * from jsonb_array_elements(coalesce(p->'films', '[]')) loop
    continue when f->'posted'->>'at' is null;
    insert into studio_posts as s (film_id, kind, username, name, version, posted_at, caption, caption_hint, permalink, attributes)
    values (f->>'id', case when f->>'kind' = 'carousel' then 'carousel' else 'reel' end, coalesce(f->>'username', 'timekeeperkw'),
            f->>'name', coalesce(f->'posted'->>'version', f->>'version'), (f->'posted'->>'at')::timestamptz,
            nullif(f->>'caption', ''), nullif(f->>'caption_hint', ''), nullif(f->'posted'->>'permalink', ''), studio_film_attrs(f))
    on conflict (film_id) do update set
      username = excluded.username, name = excluded.name, version = excluded.version, posted_at = excluded.posted_at, attributes = excluded.attributes,
      caption = coalesce(excluded.caption, s.caption), caption_hint = coalesce(excluded.caption_hint, s.caption_hint),
      permalink = coalesce(excluded.permalink, s.permalink),
      -- a link the owner gives later replaces a guessed one; nothing else unlinks a film
      media_id = case when excluded.permalink is not null and excluded.permalink is distinct from s.permalink and s.link_method <> 'permalink' then null else s.media_id end;
  end loop;
  perform studio_link_posts();

  for sp in select s.*, m.permalink ig_permalink, m.posted_at ig_posted_at from studio_posts s left join instagram_media m using (media_id)
             where s.film_id in (select x->>'id' from jsonb_array_elements(coalesce(p->'films', '[]')) x) loop
    reps := '[]';
    if sp.media_id is not null then
      for rep in select ig_post_report(sp.media_id, st) from unnest(array['48h', '7d']) st loop
        if (rep->>'available')::boolean then reps := reps || rep; end if;
      end loop;
    end if;
    out_films := out_films || jsonb_build_object(sp.film_id, jsonb_build_object(
      'ig', jsonb_strip_nulls(jsonb_build_object('linked', sp.media_id is not null, 'media_id', sp.media_id, 'permalink', sp.ig_permalink,
              'posted_at', sp.ig_posted_at, 'method', sp.link_method, 'match', sp.link_score, 'username', sp.username,
              'latest', case when sp.media_id is not null then ig_post_report(sp.media_id, 'latest') end, 'updated', now())),
      'insights', reps, 'attributes', sp.attributes));
  end loop;

  for acc in select distinct username from instagram_media loop
    accounts := accounts || jsonb_build_object(acc, ig_recipe(acc, 120));
  end loop;
  recipe := accounts->coalesce(p->>'username', 'timekeeperkw');
  return jsonb_build_object('films', out_films, 'recipe', recipe, 'accounts', accounts,
    'brief', jsonb_build_object('reel', ig_brief(recipe, 'reel'), 'carousel', ig_brief(recipe, 'carousel')), 'at', now());
end $$;

-- only the service role and the database owner run these
revoke execute on function public.ig_reads(text), public.ig_post_report(text, text), public.ig_recipe(text, integer),
  public.ig_brief(jsonb, text), public.studio_link_posts(), public.studio_sync(jsonb) from public, anon, authenticated;
grant execute on function public.ig_reads(text), public.ig_post_report(text, text), public.ig_recipe(text, integer),
  public.ig_brief(jsonb, text), public.studio_link_posts(), public.studio_sync(jsonb) to service_role;
