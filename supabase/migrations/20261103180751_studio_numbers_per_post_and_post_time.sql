-- Fixes to the studio's numbers (3 Nov 2026), after checking the first results:
-- * the gist named carousels for Timekeeper's fall in reach because it compared week totals, which punish this week's young
--   posts. It now compares each format per post, posts 2–9 days old against the usual: carousels held (12.6 thousand
--   per post), Reels fell (about 4 thousand against 8–11).
-- * the second number (shares or saves per 1000) is not judged on fewer than 3 posts in the week.
-- * a film's prediction made after posting uses the post's Instagram time, not the time the studio was told; the two
--   made with the wrong time are worked out again.

create or replace function public.ig_kind_the(p_kind text) returns text language sql immutable as $$
  select case p_kind when 'reel' then 'الريل' when 'carousel' then 'الكاروسيل' when 'image' then 'الصورة' else 'البوست' end
$$;

create or replace function public.ig_dash2(p_username text, p_brief jsonb default null) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare prio int; d0 date; nw int; series jsonb; r7 numeric; r14 numeric; pv7 numeric; pv14 numeric; wc7 numeric; kinds jsonb; sh numeric; shu numeric; sv numeric; svu numeric;
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
                    posted_at <= now() - interval '7 days' and posted_at > now() - interval '67 days' usual,
                    posted_at > now() - interval '9 days' and posted_at <= now() - interval '2 days' recent
               from instagram_media where username = p_username and posted_at > now() - interval '67 days' and reach is not null)
  select coalesce(jsonb_agg(to_jsonb(z) order by z.n desc, z.n_usual desc), '[]') into kinds from (
    select kind, count(*) filter (where wk = 'w') n, count(*) filter (where wk = 'p') n_prev, count(*) filter (where usual) n_usual,
      sum(reach) filter (where wk = 'w') reach_sum, sum(reach) filter (where wk = 'p') reach_sum_prev,
      round(percentile_cont(0.5) within group (order by reach) filter (where wk = 'w')) reach,
      round(percentile_cont(0.5) within group (order by reach) filter (where usual)) reach_usual,
      round(percentile_cont(0.5) within group (order by reach) filter (where recent)) reach_recent, count(*) filter (where recent) n_recent,
      round(1000.0 * sum(shares) filter (where wk = 'w') / nullif(sum(reach) filter (where wk = 'w'), 0), 1) shares_pk,
      round(1000.0 * sum(shares) filter (where usual) / nullif(sum(reach) filter (where usual), 0), 1) shares_pk_usual,
      round(1000.0 * sum(saved) filter (where wk = 'w') / nullif(sum(reach) filter (where wk = 'w'), 0), 1) saves_pk,
      round(1000.0 * sum(saved) filter (where usual) / nullif(sum(reach) filter (where usual), 0), 1) saves_pk_usual,
      round((percentile_cont(0.5) within group (order by skip_rate) filter (where wk = 'w'))::numeric) skip,
      round((percentile_cont(0.5) within group (order by skip_rate) filter (where usual))::numeric) skip_usual,
      round((percentile_cont(0.5) within group (order by watch) filter (where usual))::numeric, 1) watch_usual
      from m group by kind having count(*) filter (where wk = 'w' or usual or recent) > 0) z;
  select round(1000.0 * sum(shares) filter (where posted_at > now() - interval '7 days') / nullif(sum(reach) filter (where posted_at > now() - interval '7 days'), 0), 1),
         round(1000.0 * sum(shares) filter (where posted_at <= now() - interval '7 days') / nullif(sum(reach) filter (where posted_at <= now() - interval '7 days'), 0), 1),
         round(1000.0 * sum(saved) filter (where posted_at > now() - interval '7 days') / nullif(sum(reach) filter (where posted_at > now() - interval '7 days'), 0), 1),
         round(1000.0 * sum(saved) filter (where posted_at <= now() - interval '7 days') / nullif(sum(reach) filter (where posted_at <= now() - interval '7 days'), 0), 1)
    into sh, shu, sv, svu from instagram_media where username = p_username and posted_at > now() - interval '67 days' and reach is not null;
  select count(*) into nw from instagram_media where username = p_username and posted_at > now() - interval '7 days';
  if nw < 3 then sh := null; sv := null; end if;
  chg := case when r14 > 0 then round(100 * (r7 / r14 - 1)) end;
  hero := jsonb_build_array(jsonb_build_object('label', 'الوصول · آخر 7 أيام', 'value', r7, 'text', ig_fmt(r7), 'chg', chg,
            'tone', case when chg <= -20 then 'down' when chg >= 20 then 'up' else 'ok' end));
  hero := hero || case prio
    when 1 then jsonb_build_object('label', 'مشاركات لكل 1000 وصول', 'value', sh, 'text', coalesce(sh::text, '—'), 'usual', shu, 'sub', case when sh is null then 'بوستات قليلة هالأسبوع' end,
                  'tone', case when sh is null then 'ok' when sh < 0.8 * shu then 'down' when sh > 1.2 * shu then 'up' else 'ok' end)
    when 2 then jsonb_build_object('label', 'حفظ لكل 1000 وصول', 'value', sv, 'text', coalesce(sv::text, '—'), 'usual', svu, 'sub', case when sv is null then 'بوستات قليلة هالأسبوع' end,
                  'tone', case when sv is null then 'ok' when sv < 0.8 * svu then 'down' when sv > 1.2 * svu then 'up' else 'ok' end)
    else jsonb_build_object('label', 'زيارات البروفايل · 7 أيام', 'value', pv7, 'text', ig_fmt(pv7),
                  'chg', case when pv14 > 0 then round(100 * (pv7 / pv14 - 1)) end, 'sub', format('%s ضغطة على الموقع', coalesce(wc7, 0)),
                  'tone', case when pv14 > 0 and pv7 < 0.8 * pv14 then 'down' when pv14 > 0 and pv7 > 1.2 * pv14 then 'up' else 'ok' end) end;
  select * into sft from ig_shifts where username = p_username and detected_at > now() - interval '14 days' order by detected_at desc limit 1;
  -- the gist: one note, one recommendation
  if prio = 3 then
    note := format('زيارات البروفايل %s هالأسبوع%s، و%s ضغطة على الموقع.', ig_fmt(pv7),
                   case when pv14 > 0 then format(' (%s الأسبوع اللي قبل)', ig_fmt(pv14)) else '' end, coalesce(wc7, 0));
  elsif chg is not null and abs(chg) >= 25 then
    -- the format whose posts (2–9 days old) moved furthest from their usual, per post
    select x into t from jsonb_array_elements(kinds) x
     where coalesce((x->>'n_recent')::int, 0) >= 2 and coalesce((x->>'reach_usual')::numeric, 0) > 0 and (x->>'reach_recent')::numeric > 0
     order by abs(ln((x->>'reach_recent')::numeric / (x->>'reach_usual')::numeric)) desc limit 1;
    rk := t->>'kind';
    note := format('%sالوصول %s %s%%.', case when sft.id is not null then format('من %s: ', ig_date_ar(sft.since)) else '' end,
                   case when chg < 0 then 'نازل' else 'طالع' end, abs(chg));
    if rk is not null then
      note := note || format(' %s صار يوصل %s للبوست بدل %s', ig_kind_the(rk), ig_fmt((t->>'reach_recent')::numeric), ig_fmt((t->>'reach_usual')::numeric));
      select x into o from jsonb_array_elements(kinds) x
       where x->>'kind' <> rk and coalesce((x->>'n_recent')::int, 0) >= 3 and coalesce((x->>'reach_usual')::numeric, 0) > 0
       order by (x->>'n_recent')::int desc limit 1;
      if o is not null then
        note := note || case when abs((o->>'reach_recent')::numeric / (o->>'reach_usual')::numeric - 1) <= 0.2
                               then format('، و%s على حاله (%s).', ig_kind_the(o->>'kind'), ig_fmt((o->>'reach_recent')::numeric))
                             else format('، و%s %s بدل %s.', ig_kind_the(o->>'kind'), ig_fmt((o->>'reach_recent')::numeric), ig_fmt((o->>'reach_usual')::numeric)) end;
      else note := note || '.'; end if;
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


create or replace function public.studio_film_prediction(p_film text) returns jsonb language plpgsql security definer set search_path = public as $$
declare r ig_predictions; sp studio_posts; m ig_models; feats jsonb; x jsonb; cur numeric; t0 timestamptz;
begin
  select * into sp from studio_posts where film_id = p_film;
  select coalesce(im.posted_at, sp.posted_at), im.reach into t0, cur from (select 1) one left join instagram_media im on im.media_id = sp.media_id;
  select * into r from ig_predictions where film_id = p_film;
  if r.id is null then
    if sp.film_id is null or t0 is null then return null; end if;
    select * into m from ig_models where username = sp.username and kind = sp.kind and active;
    if m.id is null then return null; end if;
    feats := ig_feats(sp.kind, coalesce(sp.caption, sp.caption_hint), (sp.attributes->>'slides')::int, t0, sp.attributes);
    x := ig_predict(m.params, feats, ig_level(sp.username, sp.kind, t0));
    if x is null then return null; end if;
    insert into ig_predictions (film_id, media_id, username, kind, model_id, basis, predicted, low, high, features)
    values (p_film, sp.media_id, sp.username, sp.kind, m.id, 'after', (x->>'predicted')::int, (x->>'low')::int, (x->>'high')::int, feats)
    on conflict (film_id) where film_id is not null do nothing returning * into r;
    if r.id is null then select * into r from ig_predictions where film_id = p_film; end if;
  end if;
  if r.media_id is not null and r.media_id is distinct from sp.media_id then select reach into cur from instagram_media where media_id = r.media_id; end if;
  return jsonb_build_object('predicted', r.predicted, 'low', r.low, 'high', r.high, 'basis', r.basis, 'made_at', r.made_at,
    'model_version', (select version from ig_models where id = r.model_id), 'now', cur, 'actual', r.actual, 'within', r.within,
    'final_at', t0 + interval '7 days');
end $$;

revoke execute on function public.ig_kind_the(text) from public, anon, authenticated;
grant execute on function public.ig_kind_the(text) to service_role;

update public.ig_predictions p set predicted = (q.x->>'predicted')::int, low = (q.x->>'low')::int, high = (q.x->>'high')::int, features = c.f, made_at = now()
  from (select pr.id, m.params, ig_level(sp.username, sp.kind, im.posted_at) lvl,
               ig_feats(sp.kind, coalesce(sp.caption, sp.caption_hint), (sp.attributes->>'slides')::int, im.posted_at, sp.attributes) f
          from public.ig_predictions pr join public.studio_posts sp on sp.film_id = pr.film_id
          join public.instagram_media im on im.media_id = sp.media_id join public.ig_models m on m.id = pr.model_id
         where pr.basis = 'after' and pr.film_id in ('halter-1', 'halter-2')) c,
       lateral (select public.ig_predict(c.params, c.f, c.lvl) x) q
 where p.id = c.id and q.x is not null;
select public.studio_refresh();
