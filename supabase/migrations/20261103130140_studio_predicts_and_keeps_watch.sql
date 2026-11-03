-- The studio predicts and keeps watch (3 Nov 2026, the approved iPhone design «شاشات الستوديو الجديدة»).
-- Timekeeper first, the gallery second, the other accounts tracked simply. One number before posting (the expected
-- 7-day reach and its range), expected against actual after; models per account and format with every version kept
-- and a weekly check that replaces one only when it predicts unseen posts better; changes in our accounts recorded
-- with before/after by format; Instagram's official news kept apart from opinion and shown only when it touches us.
-- Nothing here changes the studio's creative rules, a film, or Instagram.

create table if not exists public.ig_models (
  id bigserial primary key,
  username text not null,
  kind text not null,
  version integer not null,
  trained_until timestamptz not null,
  params jsonb not null,
  backtest jsonb,                                 -- how it did on posts it had not seen when it was chosen
  active boolean not null default false,
  reason text,
  created_at timestamptz not null default now(),
  unique (username, kind, version));
create unique index if not exists ig_models_one_active on public.ig_models (username, kind) where active;

create table if not exists public.ig_model_checks (
  id bigserial primary key,
  at timestamptz not null default now(),
  username text not null,
  kind text not null,
  active_version integer,
  candidate_score jsonb,
  active_score jsonb,
  decision text);

create table if not exists public.ig_predictions (
  id bigserial primary key,
  film_id text,
  media_id text,
  username text not null,
  kind text not null,
  model_id bigint references public.ig_models (id),
  basis text not null check (basis in ('before', 'after')),   -- made before posting, or worked out afterwards
  made_at timestamptz not null default now(),
  predicted integer not null,
  low integer not null,
  high integer not null,
  features jsonb,
  actual integer,
  actual_at timestamptz,
  within boolean,
  error_pct numeric);
create unique index if not exists ig_predictions_film on public.ig_predictions (film_id) where film_id is not null;

create table if not exists public.ig_updates (
  id bigserial primary key,
  found_at timestamptz not null default now(),
  announced_on date,
  title text not null,
  source_url text not null,
  source_name text,
  source_kind text not null check (source_kind in ('official', 'third_party', 'unverified')),
  affects text[] not null default '{}',
  affects_us boolean not null default false,
  importance text not null default 'normal' check (importance in ('high', 'normal', 'low')),
  summary text,
  action text,
  status text not null default 'open' check (status in ('open', 'done', 'dismissed')),
  unique (source_url, title));

create table if not exists public.ig_update_checks (
  id bigserial primary key,
  at timestamptz not null default now(),
  ok boolean not null,
  found integer not null default 0,
  sources text[],
  note text);

create table if not exists public.ig_shifts (
  id bigserial primary key,
  detected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  username text not null,
  kind text not null default 'all',
  since date not null,
  direction text not null check (direction in ('down', 'up')),
  ratio numeric,
  detail jsonb,
  update_ids bigint[] not null default '{}');

do $$
declare t text;
begin
  foreach t in array array['ig_models', 'ig_model_checks', 'ig_predictions', 'ig_updates', 'ig_update_checks', 'ig_shifts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Graph API: v21.0 ends on 21 Jan 2027; v26.0 tested on all three accounts on 3 Nov 2026 (same figures, nothing lost).
update public.instagram_auth set graph_version = 'v26.0' where id = 1;

-- ── features: the same groups the learning uses, for a post or for a film not posted yet ──────────────────────────
create or replace function public.ig_feats(p_kind text, p_caption text, p_children integer, p_posted timestamptz, p_attrs jsonb default '{}')
returns jsonb language sql immutable set search_path = public as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'أول سطر', case when coalesce(p_caption, '') <> '' then ig_hook_type(p_caption) end,
    'نوع المحتوى', case when coalesce(p_caption, '') <> '' then ig_content_type(p_caption) end,
    'طول الكابشن', case when coalesce(p_caption, '') = '' then null when length(p_caption) < 150 then 'قصير' when length(p_caption) < 600 then 'متوسط' else 'طويل' end,
    'عدد الشرائح', case when p_kind = 'carousel' and p_children is not null then
                     case when p_children <= 5 then '5 أو أقل' when p_children <= 9 then '6–9' else '10+' end end,
    'وقت النشر', case when p_posted is null then null
                     when extract(hour from p_posted at time zone 'Asia/Kuwait') between 6 and 11 then 'الصبح (6–12)'
                     when extract(hour from p_posted at time zone 'Asia/Kuwait') between 12 and 16 then 'الظهر (12–5)'
                     when extract(hour from p_posted at time zone 'Asia/Kuwait') between 17 and 20 then 'العصر والمغرب (5–9)'
                     else 'الليل (9 وبعد)' end))
  || coalesce((select jsonb_object_agg(key, value) from jsonb_each(coalesce(p_attrs, '{}'))
                where key in ('الأسلوب', 'القصة', 'الافتتاحية', 'البراند') and jsonb_typeof(value) = 'string'), '{}')
$$;

-- The posts a model learns from or is tested on: final ones (a week old), their 7-day reach when a read exists, and
-- the account's level when each was posted: the median log reach of the 10 posts of the format that were final by then.
create or replace function public.ig_train_rows(p_username text, p_kind text, p_from timestamptz, p_until timestamptz)
returns table(media_id text, posted_at timestamptz, reach numeric, feats jsonb, lvl numeric)
language sql stable security definer set search_path = public as $$
  with a as (
    select m.media_id, m.posted_at, coalesce(r.reach, m.reach)::numeric reach, m.caption, m.children_count, m.media_product_type, m.media_type, sp.attributes
      from instagram_media m
      left join studio_posts sp on sp.media_id = m.media_id
      left join (select x.media_id, x.reach from ig_reads('7d') x) r on r.media_id = m.media_id
     where m.username = p_username and ig_kind(m.media_product_type, m.media_type) = p_kind
       and m.posted_at <= now() - interval '7 days' and coalesce(r.reach, m.reach) > 0)
  select a.media_id, a.posted_at, a.reach,
         ig_feats(p_kind, a.caption, a.children_count, a.posted_at, coalesce(a.attributes, '{}')),
         (select percentile_cont(0.5) within group (order by ln(q.reach + 1))
            from (select b.reach from a b where b.posted_at <= a.posted_at - interval '7 days' order by b.posted_at desc limit 10) q
          having count(*) >= 5)
    from a where a.posted_at > p_from and a.posted_at <= p_until
$$;

-- The account's level for a format now (or at a moment): median log reach of its last 10 final posts.
create or replace function public.ig_level(p_username text, p_kind text, p_at timestamptz default now())
returns numeric language sql stable security definer set search_path = public as $$
  select percentile_cont(0.5) within group (order by ln(q.reach + 1)) from (
    select coalesce(r.reach, m.reach) reach from instagram_media m
      left join (select x.media_id, x.reach from ig_reads('7d') x) r on r.media_id = m.media_id
     where m.username = p_username and ig_kind(m.media_product_type, m.media_type) = p_kind
       and m.posted_at <= least(p_at, now()) - interval '7 days' and coalesce(r.reach, m.reach) > 0
     order by m.posted_at desc limit 10) q having count(*) >= 5
$$;

-- A model = the account's current level, moved by what the post is. Each group's effect is its posts' mean distance
-- from the level they were posted at, shrunk by n/(n+8) so small groups barely count. lambda (0–1) decides how much the
-- effects are trusted: it is chosen on the newest 30% of the training posts with effects learned on the older 70%, so
-- features that do not help on unseen posts get lambda 0 and the model is the level alone. The range is the 15th–85th
-- percentile of the errors, widened 10%.
create or replace function public.ig_model_fit(p_username text, p_kind text, p_until timestamptz, p_days integer default 365, p_lambda numeric default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare k constant numeric := 8; rws jsonb; n int; ntr int; off numeric; eff jsonb; eff_tr jsonb; off_tr numeric; lam numeric := 0; best numeric; cand numeric; err numeric; qlo numeric; qhi numeric; tested jsonb := '[]';
begin
  select jsonb_agg(jsonb_build_object('y', ln(r.reach + 1), 'l', r.lvl, 'f', r.feats) order by r.posted_at) into rws
    from ig_train_rows(p_username, p_kind, p_until - make_interval(days => p_days), p_until) r where r.lvl is not null;
  n := coalesce(jsonb_array_length(rws), 0);
  if n < 20 then return jsonb_build_object('ok', false, 'n', n, 'reason', 'few'); end if;
  ntr := floor(n * 0.7);
  -- effects learned on the older 70%
  select percentile_cont(0.5) within group (order by (x->>'y')::numeric - (x->>'l')::numeric) into off_tr
    from jsonb_array_elements(rws) with ordinality x(x, i) where i <= ntr;
  select coalesce(jsonb_object_agg(dim, vals), '{}') into eff_tr from (
    select dim, jsonb_object_agg(val, jsonb_build_object('e', round(e, 4), 'n', cnt)) vals from (
      select f.key dim, f.value #>> '{}' val, count(*) cnt, (count(*)::numeric / (count(*) + k)) * (avg((x->>'y')::numeric - (x->>'l')::numeric) - off_tr) e
        from jsonb_array_elements(rws) with ordinality x(x, i), jsonb_each(x->'f') f where i <= ntr group by 1, 2) g group by dim) d;
  if p_lambda is not null then lam := p_lambda;
  else
    foreach cand in array array[0, 0.25, 0.5, 0.75, 1]::numeric[] loop
      select percentile_cont(0.5) within group (order by abs(exp(mu) - exp(y)) / exp(y)) into err from (
        select (x->>'y')::numeric y, (x->>'l')::numeric + cand * (off_tr + coalesce((select sum((eff_tr->(f.key)->(f.value #>> '{}')->>'e')::numeric) from jsonb_each(x->'f') f), 0)) mu
          from jsonb_array_elements(rws) with ordinality x(x, i) where i > ntr) z;
      tested := tested || jsonb_build_object('lambda', cand, 'mdape', round(err * 100, 1));
      if best is null or err < best - 0.005 then best := err; lam := cand; end if;      -- a larger lambda must earn it
    end loop;
  end if;
  -- refit on everything
  select percentile_cont(0.5) within group (order by (x->>'y')::numeric - (x->>'l')::numeric) into off from jsonb_array_elements(rws) x;
  select coalesce(jsonb_object_agg(dim, vals), '{}') into eff from (
    select dim, jsonb_object_agg(val, jsonb_build_object('e', round(e, 4), 'n', cnt)) vals from (
      select f.key dim, f.value #>> '{}' val, count(*) cnt, (count(*)::numeric / (count(*) + k)) * (avg((x->>'y')::numeric - (x->>'l')::numeric) - off) e
        from jsonb_array_elements(rws) x, jsonb_each(x->'f') f group by 1, 2) g group by dim) d;
  select percentile_cont(0.15) within group (order by r), percentile_cont(0.85) within group (order by r) into qlo, qhi
    from (select (x->>'y')::numeric - (x->>'l')::numeric - lam * (off + coalesce((select sum((eff->(f.key)->(f.value #>> '{}')->>'e')::numeric) from jsonb_each(x->'f') f), 0)) r
            from jsonb_array_elements(rws) x) z;
  return jsonb_build_object('ok', true, 'n', n, 'lambda', lam, 'offset', round(off, 4), 'k', k, 'effects', eff, 'tested', tested,
    'q_lo', round(qlo * 1.1, 4), 'q_hi', round(qhi * 1.1, 4), 'until', p_until, 'days', p_days, 'target', 'reach_7d');
end $$;

-- p_level: the account's level (ig_level) at the moment of the prediction.
create or replace function public.ig_predict(p jsonb, f jsonb, p_level numeric) returns jsonb language sql immutable as $$
  with parts as (
    select fk.key dim, fk.value #>> '{}' val,
           (p->'effects'->fk.key->(fk.value #>> '{}')->>'e')::numeric e, (p->'effects'->fk.key->(fk.value #>> '{}')->>'n')::int n
      from jsonb_each(coalesce(f, '{}')) fk),
  s as (select p_level + coalesce((p->>'lambda')::numeric, 0) * (coalesce((p->>'offset')::numeric, 0) + coalesce(sum(e), 0)) mu from parts)
  select case when p_level is null then null else jsonb_build_object(
    'predicted', round(exp(mu) - 1), 'low', round(exp(mu + (p->>'q_lo')::numeric) - 1), 'high', round(exp(mu + (p->>'q_hi')::numeric) - 1),
    'usual', round(exp(p_level) - 1), 'uses_features', coalesce((p->>'lambda')::numeric, 0) > 0,
    'parts', (select coalesce(jsonb_agg(jsonb_build_object('dim', dim, 'val', val, 'e', e, 'n', n) order by e), '[]') from parts where e is not null)) end
  from s
$$;

-- How a model does on posts it has not seen (each at the level of its own time): median % error, the share inside the
-- range, and the error of the level alone.
create or replace function public.ig_model_score(p jsonb, p_username text, p_kind text, p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security definer set search_path = public as $$
  with r as (select x.reach actual, ig_predict(p, x.feats, x.lvl) pr from ig_train_rows(p_username, p_kind, p_from, p_to) x where x.lvl is not null),
  e as (select actual, (pr->>'predicted')::numeric pred, (pr->>'low')::numeric lo, (pr->>'high')::numeric hi, (pr->>'usual')::numeric usual from r)
  select jsonb_build_object('n', count(*),
    'mdape', round((percentile_cont(0.5) within group (order by abs(pred - actual) / actual) * 100)::numeric, 1),
    'naive_mdape', round((percentile_cont(0.5) within group (order by abs(usual - actual) / actual) * 100)::numeric, 1),
    'coverage', round(100.0 * avg((actual between lo and hi)::int), 1), 'from', p_from, 'to', p_to)
  from e
$$;

-- ── words and numbers the way the studio says them ──────────────────────────────────────────────────────────────────
create or replace function public.ig_fmt(n numeric) returns text language sql immutable as $$
  select case when n is null then '—'
              when abs(n) >= 1000000 then to_char(round(n / 1000000.0, 1), 'FM990.0') || ' مليون'
              when abs(n) >= 10000 then to_char(round(n / 1000.0), 'FM999,990') || ' ألف'
              when abs(n) >= 1000 then to_char(round(n / 1000.0, 1), 'FM990.0') || ' ألف'
              else to_char(round(n), 'FM999,990') end
$$;
create or replace function public.ig_kind_ar(p_kind text, p_n integer default 1, p_the boolean default false) returns text language sql immutable as $$
  select case when p_the then case p_kind when 'reel' then 'الريلز' when 'carousel' then 'الكاروسيلات' when 'image' then 'الصور' else 'البوستات' end
              else case p_kind when 'reel' then case when p_n = 1 then 'ريل' else 'ريلز' end when 'carousel' then 'كاروسيل'
                                when 'image' then case when p_n = 1 then 'صورة' else 'صور' end else 'بوست' end end
$$;
create or replace function public.ig_date_ar(d date) returns text language sql immutable as $$
  select extract(day from d)::int || ' ' || (array['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'])[extract(month from d)::int]
$$;

-- ── models: a check every week; a new version only when it predicts unseen posts better ─────────────────────────
-- Timekeeper first, the gallery second; the other accounts are tracked without a model.
create or replace function public.ig_models_check() returns jsonb language plpgsql security definer set search_path = public as $$
declare pr record; a ig_models; v int; cut timestamptz; mid timestamptz; c jsonb; cs jsonb; asc_ jsonb; full_p jsonb; nh int; decision text; v_out jsonb := '[]';
begin
  for pr in select * from (values ('timekeeperkw', 'carousel'), ('timekeeperkw', 'reel'), ('timekeeperkw', 'image'),
                                  ('timegallerykw', 'image'), ('timegallerykw', 'reel')) t(u, k) loop
    a := null; cs := null; asc_ := null; decision := null;
    select * into a from ig_models where username = pr.u and kind = pr.k and active;
    select coalesce(max(version), 0) + 1 into v from ig_models where username = pr.u and kind = pr.k;
    if a.id is null then
      -- first model: learn from the older 70% of the final posts, test on the newest 30%
      select percentile_disc(0.7) within group (order by posted_at) into cut from ig_train_rows(pr.u, pr.k, now() - interval '365 days', now()) where lvl is not null;
      c := case when cut is not null then ig_model_fit(pr.u, pr.k, cut) end;
      if c is null or not (c->>'ok')::boolean then
        decision := format('no model: %s final posts, 20 needed', coalesce(c->>'n', '0'));
      else
        cs := ig_model_score(c, pr.u, pr.k, cut, now());
        if coalesce((cs->>'n')::int, 0) >= 8 and (cs->>'mdape')::numeric < (cs->>'naive_mdape')::numeric - 1 then
          full_p := ig_model_fit(pr.u, pr.k, now()); decision := 'first model: the post''s features beat the level alone on unseen posts';
        else
          full_p := ig_model_fit(pr.u, pr.k, now(), 365, 0);
          cs := ig_model_score(ig_model_fit(pr.u, pr.k, cut, 365, 0), pr.u, pr.k, cut, now());
          decision := 'first model: the level alone (the features did not beat it on unseen posts)';
        end if;
        insert into ig_models (username, kind, version, trained_until, params, backtest, active, reason)
        values (pr.u, pr.k, v, now(), full_p, cs, true, decision);
      end if;
    else
      -- the posts the active model has never seen: split them in two; a candidate trained up to the middle must beat
      -- the active model on the second half (median error 2 points lower, its range no further from 70%)
      select count(*) into nh from ig_train_rows(pr.u, pr.k, a.trained_until, now()) where lvl is not null;
      if nh < 10 then
        decision := format('kept v%s: %s new final posts, 10 needed to judge', a.version, nh);
      else
        select percentile_disc(0.5) within group (order by posted_at) into mid from ig_train_rows(pr.u, pr.k, a.trained_until, now()) where lvl is not null;
        c := ig_model_fit(pr.u, pr.k, mid);
        cs := ig_model_score(c, pr.u, pr.k, mid, now());
        asc_ := ig_model_score(a.params, pr.u, pr.k, mid, now());
        if (cs->>'mdape')::numeric <= (asc_->>'mdape')::numeric - 2
           and abs((cs->>'coverage')::numeric - 70) <= abs((asc_->>'coverage')::numeric - 70) + 5 then
          full_p := ig_model_fit(pr.u, pr.k, now(), 365, case when (c->>'lambda')::numeric = 0 then 0 end);
          update ig_models set active = false where id = a.id;
          insert into ig_models (username, kind, version, trained_until, params, backtest, active, reason)
          values (pr.u, pr.k, v, now(), full_p, cs, true, format('replaced v%s: predicted the newest posts better (%s%% against %s%% error)', a.version, cs->>'mdape', asc_->>'mdape'));
          decision := format('replaced v%s with v%s', a.version, v);
        else
          decision := format('kept v%s: a retrained model was not better (%s%% against %s%% error)', a.version, cs->>'mdape', asc_->>'mdape');
        end if;
      end if;
    end if;
    insert into ig_model_checks (username, kind, active_version, candidate_score, active_score, decision)
    values (pr.u, pr.k, (select version from ig_models where username = pr.u and kind = pr.k and active), cs, asc_, decision);
    v_out := v_out || jsonb_build_object('username', pr.u, 'kind', pr.k, 'decision', decision);
  end loop;
  return v_out;
end $$;

-- ── predictions for films ──────────────────────────────────────────────────────────────────────────────────────────
-- 2–3 suggestions before posting, only from patterns that passed the chance test (medium or high confidence) and the
-- brief's tests; no promised gain.
create or replace function public.studio_suggest(p_kind text, p_feats jsonb) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare learn jsonb; v_out jsonb := '[]'; i jsonb; t jsonb;
begin
  select data into learn from studio_state where key = 'learn';
  for i in select x from jsonb_array_elements(coalesce(learn->'accounts'->'timekeeperkw'->'items', '[]')) x
            where x->>'kind' = p_kind and x->>'confidence' in ('medium', 'high') and (x->>'vs')::numeric < 1
              and p_feats->>(x->>'dim') = x->>'val' order by (x->>'vs')::numeric limit 2 loop
    v_out := v_out || jsonb_build_object(
      'text', case when i->>'dim' = 'أول سطر' then format('أول سطر يبدأ بـ%s. جرّب سؤال أو جملة قصة.', i->>'val')
                   when i->>'dim' = 'طول الكابشن' then format('الكابشن %s. خله أطول شوي بمعلومة زيادة.', i->>'val')
                   when i->>'dim' = 'عدد الشرائح' then format('عدد الشرائح %s. جرّب عدد ثاني.', i->>'val')
                   else format('%s: «%s» يجي معاه أداء أقل عندنا.', i->>'dim', i->>'val') end,
      'why', format('%s %s عندنا كذا جت أقل من المعتاد · %s', i->>'n', ig_kind_ar(p_kind, (i->>'n')::int), i->>'confidence_ar'),
      'action', case when i->>'dim' in ('أول سطر', 'طول الكابشن', 'الهاشتاقات') then 'text' when i->>'dim' = 'عدد الشرائح' then 'slides' else 'style' end,
      'lv', case when i->>'confidence' = 'high' then 'c' else 'e' end);
  end loop;
  for t in select x from jsonb_array_elements(coalesce(learn->'brief'->p_kind->'test_next', '[]')) x limit greatest(0, least(3 - jsonb_array_length(v_out), 2)) loop
    continue when jsonb_array_length(v_out) >= 3;
    v_out := v_out || jsonb_build_object('text', t->>'idea', 'why', 'تجربة: ' || coalesce(t->>'why', ''), 'action', 'test', 'lv', 'w');
  end loop;
  return v_out;
end $$;

-- The prediction for a film that is not posted yet (it works for an idea not made yet too, for Phase 2).
create or replace function public.studio_predict(f jsonb) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare k text := case when f->>'kind' = 'carousel' then 'carousel' else 'reel' end; u text := coalesce(f->>'username', 'timekeeperkw'); m ig_models; feats jsonb; pr jsonb;
begin
  select * into m from ig_models where username = u and kind = k and active;
  if m.id is null then return null; end if;
  feats := ig_feats(k, coalesce(nullif(f->>'caption', ''), f->>'caption_hint'), case when jsonb_typeof(f->'slides') = 'array' then jsonb_array_length(f->'slides') end, null, studio_film_attrs(f));
  pr := ig_predict(m.params, feats, ig_level(u, k));
  if pr is null then return null; end if;
  return (pr - 'parts') || jsonb_build_object('kind', k, 'username', u, 'model', jsonb_build_object('id', m.id, 'version', m.version,
           'mdape', m.backtest->'mdape', 'coverage', m.backtest->'coverage', 'n', m.backtest->'n'),
         'features', feats, 'suggestions', studio_suggest(k, feats));
end $$;

-- A posted film's prediction: the one frozen before posting, else one worked out afterwards from the account's level
-- when it was posted (said so on the page).
create or replace function public.studio_film_prediction(p_film text) returns jsonb language plpgsql security definer set search_path = public as $$
declare r ig_predictions; sp studio_posts; m ig_models; feats jsonb; x jsonb; cur numeric;
begin
  select * into sp from studio_posts where film_id = p_film;
  select * into r from ig_predictions where film_id = p_film;
  if r.id is null then
    if sp.film_id is null or sp.posted_at is null then return null; end if;
    select * into m from ig_models where username = sp.username and kind = sp.kind and active;
    if m.id is null then return null; end if;
    feats := ig_feats(sp.kind, coalesce(sp.caption, sp.caption_hint), (sp.attributes->>'slides')::int, sp.posted_at, sp.attributes);
    x := ig_predict(m.params, feats, ig_level(sp.username, sp.kind, sp.posted_at));
    if x is null then return null; end if;
    insert into ig_predictions (film_id, media_id, username, kind, model_id, basis, predicted, low, high, features)
    values (p_film, sp.media_id, sp.username, sp.kind, m.id, 'after', (x->>'predicted')::int, (x->>'low')::int, (x->>'high')::int, feats)
    on conflict (film_id) where film_id is not null do nothing returning * into r;
    if r.id is null then select * into r from ig_predictions where film_id = p_film; end if;
  end if;
  select reach into cur from instagram_media where media_id = coalesce(r.media_id, sp.media_id);
  return jsonb_build_object('predicted', r.predicted, 'low', r.low, 'high', r.high, 'basis', r.basis, 'made_at', r.made_at,
    'model_version', (select version from ig_models where id = r.model_id), 'now', cur, 'actual', r.actual, 'within', r.within,
    'final_at', sp.posted_at + interval '7 days');
end $$;

-- After 7 days, each prediction gets its real reach (confirmed links only), so accuracy is measured on real outcomes.
create or replace function public.ig_predictions_settle() returns integer language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update ig_predictions p set media_id = sp.media_id
    from studio_posts sp where p.film_id = sp.film_id and sp.media_id is not null and sp.link_method in ('confirmed', 'permalink')
     and p.media_id is distinct from sp.media_id and p.actual is null;
  update ig_predictions p set actual = v.reach, actual_at = now(), within = v.reach between p.low and p.high,
         error_pct = round(100.0 * abs(p.predicted - v.reach) / nullif(v.reach, 0), 1)
    from (select m.media_id, coalesce(r.reach, m.reach) reach from instagram_media m
            left join (select x.media_id, x.reach from ig_reads('7d') x) r on r.media_id = m.media_id
           where m.posted_at <= now() - interval '7 days') v
   where v.media_id = p.media_id and p.actual is null and v.reach is not null;
  get diagnostics n = row_count;
  return n;
end $$;

-- ── changes in our accounts ────────────────────────────────────────────────────────────────────────────────────────
-- A shift: the last 7 days' daily reach against the 4 weeks before (median 30% lower with 5+ days under the usual
-- quarter, or 40% higher with 5+ days over it). Recorded with the day it started, each format before and after (same
-- account, posts at least 2 days old), how often we posted, and any official update from around then.
create or replace function public.ig_detect_shifts() returns integer language plpgsql security definer set search_path = public as $$
declare u text; d0 date; q25 numeric; q75 numeric; med_prev numeric; med7 numeric; below int; above int; dir text; v_since date; dd record; v_detail jsonb; ex bigint; n int := 0;
begin
  foreach u in array array['timekeeperkw', 'timegallerykw'] loop
    select max(snapshot_date) into d0 from instagram_daily where username = u and reach is not null;
    continue when d0 is null;
    select percentile_cont(0.25) within group (order by reach), percentile_cont(0.5) within group (order by reach), percentile_cont(0.75) within group (order by reach)
      into q25, med_prev, q75 from instagram_daily where username = u and reach is not null and snapshot_date > d0 - 35 and snapshot_date <= d0 - 7;
    select percentile_cont(0.5) within group (order by reach), count(*) filter (where reach < q25), count(*) filter (where reach > q75)
      into med7, below, above from instagram_daily where username = u and reach is not null and snapshot_date > d0 - 7;
    dir := case when med7 <= 0.7 * med_prev and below >= 5 then 'down' when med7 >= 1.4 * med_prev and above >= 5 then 'up' end;
    continue when dir is null;
    v_since := d0;
    for dd in select snapshot_date, reach from instagram_daily where username = u and reach is not null and snapshot_date <= d0 and snapshot_date > d0 - 28 order by snapshot_date desc loop
      exit when (dir = 'down' and dd.reach >= 0.75 * med_prev) or (dir = 'up' and dd.reach <= 1.33 * med_prev);
      v_since := dd.snapshot_date;
    end loop;
    select jsonb_build_object(
      'by_kind', (select coalesce(jsonb_object_agg(kind, jsonb_build_object('before', b, 'n_before', nb, 'after', a, 'n_after', na)), '{}') from (
          select ig_kind(media_product_type, media_type) kind,
                 round(percentile_cont(0.5) within group (order by reach) filter (where posted_at < v_since)) b, count(*) filter (where posted_at < v_since) nb,
                 round(percentile_cont(0.5) within group (order by reach) filter (where posted_at >= v_since)) a, count(*) filter (where posted_at >= v_since) na
            from instagram_media where username = u and reach is not null and posted_at >= v_since - 21 and posted_at < now() - interval '2 days'
           group by 1) z),
      'posts_per_week_before', (select round(count(*) / 3.0, 1) from instagram_media where username = u and posted_at >= v_since - 21 and posted_at < v_since),
      'posts_per_week_after', (select round(count(*) * 7.0 / greatest(1, current_date - v_since), 1) from instagram_media where username = u and posted_at >= v_since),
      'median_daily_before', round(med_prev), 'median_daily_after', round(med7)) into v_detail;
    select id into ex from ig_shifts where ig_shifts.username = u and ig_shifts.direction = dir and v_since between ig_shifts.since - 3 and ig_shifts.since + 3 order by detected_at desc limit 1;
    if ex is null then
      insert into ig_shifts (username, kind, since, direction, ratio, detail, update_ids)
      values (u, 'all', v_since, dir, round(med7 / nullif(med_prev, 0), 2), v_detail,
              array(select g.id from ig_updates g where g.source_kind = 'official' and g.announced_on between v_since - 14 and v_since + 3));
    else
      update ig_shifts set ratio = round(med7 / nullif(med_prev, 0), 2), detail = ig_shifts.detail || v_detail, updated_at = now(),
             update_ids = array(select g.id from ig_updates g where g.source_kind = 'official' and g.announced_on between ig_shifts.since - 14 and ig_shifts.since + 3)
       where id = ex;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ── Instagram's own news: written by the weekly check, shown only when it touches us ──────────────────────────────
create or replace function public.ig_update_add(p jsonb) returns bigint language plpgsql security definer set search_path = public as $$
declare kind text := p->>'source_kind'; imp text := coalesce(p->>'importance', 'normal'); v_id bigint;
  aff text[] := array(select x from jsonb_array_elements_text(coalesce(p->'affects', '[]')) x where x in ('reel', 'carousel', 'image', 'story', 'api', 'all'));
begin
  if coalesce(p->>'source_url', '') !~ '^https://' or coalesce(p->>'title', '') = '' or kind not in ('official', 'third_party', 'unverified') then
    raise exception 'an update needs a title, an https source and a source kind (official, third_party, unverified)';
  end if;
  if kind <> 'official' and imp = 'high' then imp := 'normal'; end if;          -- only Instagram or Meta can make it important
  insert into ig_updates (announced_on, title, source_url, source_name, source_kind, affects, affects_us, importance, summary, action)
  values ((p->>'announced_on')::date, left(p->>'title', 200), p->>'source_url', left(p->>'source_name', 80), kind, aff,
          coalesce((p->>'affects_us')::boolean, false), imp, left(p->>'summary', 600), left(p->>'action', 300))
  on conflict (source_url, title) do update set summary = coalesce(excluded.summary, ig_updates.summary), affects = excluded.affects,
     affects_us = excluded.affects_us, importance = excluded.importance, action = coalesce(excluded.action, ig_updates.action)
  returning ig_updates.id into v_id;
  return v_id;
end $$;
create or replace function public.ig_update_check_done(p jsonb) returns bigint language sql security definer set search_path = public as $$
  insert into ig_update_checks (ok, found, sources, note)
  values (coalesce((p->>'ok')::boolean, true), coalesce((p->>'found')::int, 0),
          array(select x from jsonb_array_elements_text(coalesce(p->'sources', '[]')) x), left(p->>'note', 600))
  returning id
$$;
create or replace function public.studio_updates() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'important', coalesce((select jsonb_agg(to_jsonb(u) - 'found_at' order by coalesce(announced_on, found_at::date) desc) from (
        select * from ig_updates where status = 'open' and affects_us and importance = 'high' and source_kind = 'official'
         order by coalesce(announced_on, found_at::date) desc limit 3) u), '[]'),
    'recent', coalesce((select jsonb_agg(to_jsonb(u) order by coalesce(announced_on, found_at::date) desc) from (
        select * from ig_updates where found_at > now() - interval '60 days' and status <> 'dismissed'
         order by coalesce(announced_on, found_at::date) desc limit 8) u), '[]'),
    'last_check', (select max(at) from ig_update_checks where ok))
$$;

-- ── the numbers screen: two numbers, a chart, the gist; the rest closed ───────────────────────────────────────────
create or replace function public.ig_dash2(p_username text, p_brief jsonb default null) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare prio int; d0 date; series jsonb; r7 numeric; r14 numeric; pv7 numeric; pv14 numeric; wc7 numeric; kinds jsonb; sh numeric; shu numeric; sv numeric; svu numeric;
  hero jsonb; chg numeric; t jsonb; o jsonb; note text; rec text; rk text; models jsonb; sft record; tp record;
begin
  prio := case p_username when 'timekeeperkw' then 1 when 'timegallerykw' then 2 else 3 end;
  select max(snapshot_date) into d0 from instagram_daily where username = p_username and reach is not null;
  if d0 is null then return jsonb_build_object('priority', prio); end if;
  select coalesce(jsonb_agg(jsonb_build_array(snapshot_date, reach) order by snapshot_date), '[]') into series
    from instagram_daily where username = p_username and reach is not null and snapshot_date > d0 - 35;
  select sum(reach) filter (where snapshot_date > d0 - 7), sum(reach) filter (where snapshot_date <= d0 - 7),
         sum(profile_views) filter (where snapshot_date > d0 - 7), sum(profile_views) filter (where snapshot_date <= d0 - 7),
         sum(website_clicks) filter (where snapshot_date > d0 - 7)
    into r7, r14, pv7, pv14, wc7 from instagram_daily where username = p_username and snapshot_date > d0 - 14;
  with m as (select ig_kind(media_product_type, media_type) kind, reach, shares, saved, skip_rate, avg_watch_time_ms / 1000.0 watch,
                    case when posted_at > now() - interval '7 days' then 'w' when posted_at > now() - interval '14 days' then 'p' end wk,
                    posted_at <= now() - interval '7 days' and posted_at > now() - interval '67 days' usual
               from instagram_media where username = p_username and posted_at > now() - interval '67 days' and reach is not null)
  select coalesce(jsonb_agg(to_jsonb(z) order by z.n desc, z.n_usual desc), '[]') into kinds from (
    select kind, count(*) filter (where wk = 'w') n, count(*) filter (where wk = 'p') n_prev, count(*) filter (where usual) n_usual,
      sum(reach) filter (where wk = 'w') reach_sum, sum(reach) filter (where wk = 'p') reach_sum_prev,
      round(percentile_cont(0.5) within group (order by reach) filter (where wk = 'w')) reach,
      round(percentile_cont(0.5) within group (order by reach) filter (where usual)) reach_usual,
      round(1000.0 * sum(shares) filter (where wk = 'w') / nullif(sum(reach) filter (where wk = 'w'), 0), 1) shares_pk,
      round(1000.0 * sum(shares) filter (where usual) / nullif(sum(reach) filter (where usual), 0), 1) shares_pk_usual,
      round(1000.0 * sum(saved) filter (where wk = 'w') / nullif(sum(reach) filter (where wk = 'w'), 0), 1) saves_pk,
      round(1000.0 * sum(saved) filter (where usual) / nullif(sum(reach) filter (where usual), 0), 1) saves_pk_usual,
      round((percentile_cont(0.5) within group (order by skip_rate) filter (where wk = 'w'))::numeric) skip,
      round((percentile_cont(0.5) within group (order by skip_rate) filter (where usual))::numeric) skip_usual,
      round((percentile_cont(0.5) within group (order by watch) filter (where usual))::numeric, 1) watch_usual
      from m group by kind having count(*) filter (where wk = 'w' or usual) > 0) z;
  select round(1000.0 * sum(shares) filter (where posted_at > now() - interval '7 days') / nullif(sum(reach) filter (where posted_at > now() - interval '7 days'), 0), 1),
         round(1000.0 * sum(shares) filter (where posted_at <= now() - interval '7 days') / nullif(sum(reach) filter (where posted_at <= now() - interval '7 days'), 0), 1),
         round(1000.0 * sum(saved) filter (where posted_at > now() - interval '7 days') / nullif(sum(reach) filter (where posted_at > now() - interval '7 days'), 0), 1),
         round(1000.0 * sum(saved) filter (where posted_at <= now() - interval '7 days') / nullif(sum(reach) filter (where posted_at <= now() - interval '7 days'), 0), 1)
    into sh, shu, sv, svu from instagram_media where username = p_username and posted_at > now() - interval '67 days' and reach is not null;
  chg := case when r14 > 0 then round(100 * (r7 / r14 - 1)) end;
  hero := jsonb_build_array(jsonb_build_object('label', 'الوصول · آخر 7 أيام', 'value', r7, 'text', ig_fmt(r7), 'chg', chg,
            'tone', case when chg <= -20 then 'down' when chg >= 20 then 'up' else 'ok' end));
  hero := hero || case prio
    when 1 then jsonb_build_object('label', 'مشاركات لكل 1000 وصول', 'value', sh, 'text', sh::text, 'usual', shu,
                  'tone', case when sh < 0.8 * shu then 'down' when sh > 1.2 * shu then 'up' else 'ok' end)
    when 2 then jsonb_build_object('label', 'حفظ لكل 1000 وصول', 'value', sv, 'text', sv::text, 'usual', svu,
                  'tone', case when sv < 0.8 * svu then 'down' when sv > 1.2 * svu then 'up' else 'ok' end)
    else jsonb_build_object('label', 'زيارات البروفايل · 7 أيام', 'value', pv7, 'text', ig_fmt(pv7),
                  'chg', case when pv14 > 0 then round(100 * (pv7 / pv14 - 1)) end, 'sub', format('%s ضغطة على الموقع', coalesce(wc7, 0)),
                  'tone', case when pv14 > 0 and pv7 < 0.8 * pv14 then 'down' when pv14 > 0 and pv7 > 1.2 * pv14 then 'up' else 'ok' end) end;
  select * into sft from ig_shifts where username = p_username and detected_at > now() - interval '14 days' order by detected_at desc limit 1;
  -- the gist: one note, one recommendation
  if prio = 3 then
    note := format('زيارات البروفايل %s هالأسبوع%s، و%s ضغطة على الموقع.', ig_fmt(pv7),
                   case when pv14 > 0 then format(' (%s الأسبوع اللي قبل)', ig_fmt(pv14)) else '' end, coalesce(wc7, 0));
  elsif chg is not null and abs(chg) >= 25 then
    select x into t from jsonb_array_elements(kinds) x
     order by abs(coalesce((x->>'reach_sum')::numeric, 0) - coalesce((x->>'reach_sum_prev')::numeric, 0)) desc limit 1;
    rk := t->>'kind';
    note := format('%s%s أكثره من %s: الأسبوع اللي قبل %s %s وصلت %s، هالأسبوع %s %s وصلت %s.',
      case when sft.id is not null then format('من %s: ', ig_date_ar(sft.since)) else '' end,
      case when chg < 0 then 'النزول' else 'الزيادة' end, ig_kind_ar(rk, 2, true),
      coalesce(t->>'n_prev', '0'), ig_kind_ar(rk, coalesce((t->>'n_prev')::int, 0)), ig_fmt(coalesce((t->>'reach_sum_prev')::numeric, 0)),
      coalesce(t->>'n', '0'), ig_kind_ar(rk, coalesce((t->>'n')::int, 0)), ig_fmt(coalesce((t->>'reach_sum')::numeric, 0)));
    select x into o from jsonb_array_elements(kinds) x where x->>'kind' <> rk and coalesce((x->>'n')::int, 0) >= 3 order by (x->>'n')::int desc limit 1;
    if o is not null then
      if prio = 1 and (o->>'shares_pk_usual')::numeric > 0 and abs((o->>'shares_pk')::numeric / (o->>'shares_pk_usual')::numeric - 1) <= 0.2 then
        note := note || format(' مشاركات %s على عادتها.', case o->>'kind' when 'carousel' then 'الكاروسيل' when 'reel' then 'الريل' else 'الصور' end);
      elsif prio = 2 and (o->>'saves_pk_usual')::numeric > 0 and abs((o->>'saves_pk')::numeric / (o->>'saves_pk_usual')::numeric - 1) <= 0.2 then
        note := note || format(' حفظ %s على عادته.', case o->>'kind' when 'carousel' then 'الكاروسيل' when 'reel' then 'الريل' else 'الصور' end);
      end if;
    end if;
  else
    select ig_first_line(caption) fl, reach into tp from instagram_media where username = p_username and posted_at > now() - interval '7 days' and reach is not null order by reach desc limit 1;
    note := format('الوصول على عادته: %s هالأسبوع.', ig_fmt(r7)) || case when tp.reach is not null then format(' أقوى بوست: «%s» (%s).', left(tp.fl, 60), ig_fmt(tp.reach)) else '' end;
    select x->>'kind' into rk from jsonb_array_elements(kinds) x order by coalesce((x->>'n')::int, 0) desc limit 1;
  end if;
  if prio < 3 and p_brief is not null and rk is not null and p_brief->rk->'test_next'->0->>'idea' is not null then
    rec := format('%s الجاي: %s', case rk when 'reel' then 'الريل' when 'carousel' then 'الكاروسيل' else 'البوست' end, p_brief->rk->'test_next'->0->>'idea');
  end if;
  select coalesce(jsonb_object_agg(kind, jsonb_build_object('version', version, 'mdape', backtest->'mdape', 'coverage', backtest->'coverage', 'n', backtest->'n',
           'level_only', coalesce((params->>'lambda')::numeric, 0) = 0, 'reason', reason, 'trained', trained_until,
           'live', (select jsonb_build_object('n', count(*), 'within', count(*) filter (where z.within))
                      from (select p.within from ig_predictions p where p.username = m.username and p.kind = m.kind and p.actual is not null order by p.actual_at desc limit 10) z))), '{}')
    into models from ig_models m where username = p_username and active;
  return jsonb_build_object('priority', prio, 'hero', hero, 'series', series, 'kinds', kinds, 'models', models,
    'gist', jsonb_build_object('note', note, 'rec', rec),
    'shift', case when sft.id is not null then jsonb_build_object('since', sft.since, 'direction', sft.direction, 'ratio', sft.ratio, 'detail', sft.detail,
                    'updates', (select coalesce(jsonb_agg(jsonb_build_object('title', title, 'source_url', source_url)), '[]') from ig_updates where id = any(sft.update_ids))) end);
end $$;

-- ── a film's attributes: its brand too (Phase 2 makes films from Shopify products) ─────────────────────────────────
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
    'البراند', f->'product'->>'brand',
    'المنتج', f->'product'->>'handle',
    'seconds', secs, 'slides', case when jsonb_typeof(f->'slides') = 'array' then jsonb_array_length(f->'slides') end,
    'rules', f->'rules')) || coalesce(f->'attributes', '{}')
    from m
$$;

-- ── refresh and page, now with predictions, shifts and news ───────────────────────────────────────────────────────
create or replace function public.studio_refresh() returns jsonb language plpgsql security definer set search_path = public as $$
declare films jsonb; dash jsonb := '{}'; recipes jsonb := '{}'; acc text; tk jsonb; briefs jsonb; d2 jsonb;
begin
  perform studio_link_posts();
  begin perform ig_predictions_settle(); exception when others then raise warning 'studio_refresh settle: %', sqlerrm; end;
  begin perform ig_detect_shifts(); exception when others then raise warning 'studio_refresh shifts: %', sqlerrm; end;
  select coalesce(jsonb_object_agg(film_id, coalesce(studio_film_bundle(film_id), '{}') || jsonb_build_object('prediction', studio_film_prediction(film_id))), '{}')
    into films from studio_posts;
  for acc in select distinct username from instagram_media loop
    recipes := recipes || jsonb_build_object(acc, ig_recipe(acc, 120));
  end loop;
  tk := recipes->'timekeeperkw';
  briefs := jsonb_build_object('reel', ig_brief(tk, 'reel') - 'targets', 'carousel', ig_brief(tk, 'carousel') - 'targets');
  for acc in select distinct username from instagram_media loop
    begin d2 := ig_dash2(acc, case when acc = 'timekeeperkw' then briefs end);
    exception when others then d2 := jsonb_build_object('dash2_error', sqlerrm); end;
    dash := dash || jsonb_build_object(acc, ig_dashboard(acc) || d2);
  end loop;
  insert into studio_state (key, data, updated_at) values
    ('films', films, now()),
    ('dash', dash, now()),
    ('learn', jsonb_build_object('recipe', tk - 'top' - 'best_openings' - 'targets',
        'accounts', (select jsonb_object_agg(k, jsonb_build_object('posts', v->'posts', 'items', v->'items')) from jsonb_each(recipes) e(k, v)),
        'brief', briefs), now())
  on conflict (key) do update set data = excluded.data, updated_at = excluded.updated_at;
  return jsonb_build_object('films', (select count(*) from jsonb_object_keys(films)), 'accounts', (select count(*) from jsonb_object_keys(dash)));
end $$;

-- Everything the studio page shows, in one call. p = {films: [posted films, and films waiting or ready (state) to be
-- predicted]}. A prediction is kept (frozen) as it stood when the film was last seen unposted.
create or replace function public.studio_page(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare films jsonb := '{}'; preds jsonb := '{}'; x jsonb; v_id text; learn jsonb; dash jsonb; pr jsonb;
begin
  perform studio_register(p);
  perform studio_link_posts();
  for x in select * from jsonb_array_elements(coalesce(p->'films', '[]')) loop
    v_id := x->>'id';
    continue when coalesce(v_id, '') !~ '^[A-Za-z0-9_.-]{1,80}$';
    if x->'posted'->>'at' is not null then
      films := films || jsonb_build_object(v_id, coalesce(studio_film_bundle(v_id), '{}') || jsonb_build_object('prediction', studio_film_prediction(v_id)));
    elsif x->>'state' in ('waiting', 'done') then
      pr := studio_predict(x);
      continue when pr is null;
      preds := preds || jsonb_build_object(v_id, pr);
      insert into ig_predictions (film_id, username, kind, model_id, basis, predicted, low, high, features)
      values (v_id, pr->>'username', pr->>'kind', (pr->'model'->>'id')::bigint, 'before', (pr->>'predicted')::int, (pr->>'low')::int, (pr->>'high')::int, pr->'features')
      on conflict (film_id) where film_id is not null do update set
        model_id = excluded.model_id, predicted = excluded.predicted, low = excluded.low, high = excluded.high, features = excluded.features, made_at = now()
        where ig_predictions.basis = 'before' and ig_predictions.media_id is null and ig_predictions.actual is null;
    end if;
  end loop;
  select data into learn from studio_state where key = 'learn';
  select data into dash from studio_state where key = 'dash';
  if learn is null or dash is null then perform studio_refresh();
    select data into learn from studio_state where key = 'learn'; select data into dash from studio_state where key = 'dash'; end if;
  return jsonb_build_object('at', now(), 'films', films, 'predictions', preds, 'learn', learn, 'dash', dash,
    'status', studio_status() || jsonb_build_object('news_checked', (select max(at) from ig_update_checks where ok)),
    'updates', studio_updates());
end $$;

-- ── who may call what: the service role only (the studio reads through the owner's connector) ─────────────────────
revoke execute on function public.ig_feats(text, text, integer, timestamptz, jsonb), public.ig_train_rows(text, text, timestamptz, timestamptz),
  public.ig_level(text, text, timestamptz), public.ig_model_fit(text, text, timestamptz, integer, numeric), public.ig_predict(jsonb, jsonb, numeric),
  public.ig_model_score(jsonb, text, text, timestamptz, timestamptz), public.ig_models_check(), public.studio_suggest(text, jsonb),
  public.studio_predict(jsonb), public.studio_film_prediction(text), public.ig_predictions_settle(), public.ig_detect_shifts(),
  public.ig_update_add(jsonb), public.ig_update_check_done(jsonb), public.studio_updates(), public.ig_dash2(text, jsonb),
  public.studio_refresh(), public.studio_page(jsonb)
  from public, anon, authenticated;
grant execute on function public.ig_feats(text, text, integer, timestamptz, jsonb), public.ig_train_rows(text, text, timestamptz, timestamptz),
  public.ig_level(text, text, timestamptz), public.ig_model_fit(text, text, timestamptz, integer, numeric), public.ig_predict(jsonb, jsonb, numeric),
  public.ig_model_score(jsonb, text, text, timestamptz, timestamptz), public.ig_models_check(), public.studio_suggest(text, jsonb),
  public.studio_predict(jsonb), public.studio_film_prediction(text), public.ig_predictions_settle(), public.ig_detect_shifts(),
  public.ig_update_add(jsonb), public.ig_update_check_done(jsonb), public.studio_updates(), public.ig_dash2(text, jsonb),
  public.studio_refresh(), public.studio_page(jsonb)
  to service_role;

-- ── the clock: models checked every Sunday morning (07:10 Kuwait), after the daily read and refresh ────────────────
select cron.schedule('ig-models-weekly', '10 4 * * 0', 'select public.ig_models_check()');

-- ── the first records ──────────────────────────────────────────────────────────────────────────────────────────────
insert into public.ig_updates (announced_on, title, source_url, source_name, source_kind, affects, affects_us, importance, summary, action, status)
values ('2026-07-29', 'Graph API v21.0 تنتهي 21 يناير 2027 (آخر نسخة v26.0)', 'https://developers.facebook.com/docs/graph-api/changelog/versions/',
        'Meta for Developers', 'official', '{api}', true, 'high',
        'نسخة الـAPI اللي كنا نسحب فيها أرقام إنستغرام تنتهي 21 يناير 2027. ما تأثر على الوصول، تأثر على السحب بس.',
        'رقّيناها لـ v26 في 3 نوفمبر 2026 بعد ما جربناها على الحسابات الثلاثة.', 'done')
on conflict (source_url, title) do nothing;
select public.ig_models_check();
select public.studio_refresh();
