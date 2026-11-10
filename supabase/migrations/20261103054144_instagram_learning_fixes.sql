-- Instagram learning, first fixes after the real data (3 Nov 2026):
--   studio_link_posts  a film saved without a caption is linked through its twin film's caption at 30%+ shared words
--                      when every other post is 20+ points behind (Halter 1: 0.38 against 0.09).
--   studio_sync        a film's tags merge across syncs, so a measured length is kept.
--   ig_recipe          every format the account posts (the shop and the gallery post images); «أخرى» is not a pattern.
--   ig_brief           an opening that goes with weaker posts is said as such.
create or replace function public.ig_recipe(p_username text default 'timekeeperkw', p_days integer default 120)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  with p as (
    select x.*, (x.posted_at at time zone 'Asia/Kuwait') kw, sp.attributes sa, sp.film_id
      from ig_reads('latest') x left join studio_posts sp on sp.media_id = x.media_id
     where x.username = p_username and x.age_hours >= 168
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
    union all select kind, score, 'نوع المحتوى', ig_content_type(caption), false from scored where ig_content_type(caption) <> 'أخرى'
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
        'rule', case kind when 'reel' then 'الريلز' when 'carousel' then 'الكاروسيل' when 'image' then 'الصور' else 'الفيديو' end || ' · ' || dim || ': «' || val || '» '
                || case when vs_all > 1 then 'يجي معاه أداء أعلى' else 'يجي معاه أداء أقل' end,
        'why', format('%s منشور، أداؤها ×%s من وسيط %s، و%s%% منها فوق الوسيط.', n, vs_all,
                      case kind when 'reel' then 'الريلز' when 'carousel' then 'الكاروسيلات' when 'image' then 'الصور' else 'الفيديوهات' end, round(above * 100)),
        'from', 'أرقام إنستغرام · آخر ' || p_days || ' يوم · علاقة، مو سبب مثبت')
        order by case conf when 'high' then 0 when 'medium' then 1 else 2 end, abs(vs_all - 1) desc) from rated where conf is not null), '[]'),
    'needs_data', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'dim', dim, 'val', val, 'n', n, 'need', 5 - n))
        from groups where studio and n < 5), '[]'),
    'caveat', 'هذي علاقات من أرقامنا، مو أسباب مثبتة. المحتوى والوقت يتداخلون، فأي نمط نجربه عمداً قبل ما نعتمده.')
    into res;
  return res;
end $$;

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
  s := (select i from jsonb_array_elements(items) i where i->>'dim' = 'أول سطر' order by abs((i->>'vs')::numeric - 1) desc limit 1);
  sections := sections || jsonb_build_object('key', 'hook', 'title', 'الافتتاحية',
    'advice', coalesce(case when s is not null and (s->>'vs')::numeric > 1 then 'افتح بـ«' || (s->>'val') || '»: ' || (s->>'why')
                            when s is not null then 'أول سطر بـ«' || (s->>'val') || '» يجي معاه أداء أقل عندنا؛ جرّب سؤال أو جملة قصة: ' || (s->>'why') end,
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
      -- its own caption: 60%+ of words shared and no close second; a twin film's caption (the carousel of the same
      -- story) words things differently: 30%+ and every other post at least 20 points behind
      if (sp.caption is not null and sc >= 0.6 and coalesce(sc2, 0) < sc - 0.15)
         or (sp.caption is null and sc >= 0.3 and coalesce(sc2, 0) < sc - 0.2) then
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
      username = excluded.username, name = excluded.name, version = excluded.version, posted_at = excluded.posted_at,
      attributes = s.attributes || excluded.attributes,      -- a tag learnt once (a measured length) is kept
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
