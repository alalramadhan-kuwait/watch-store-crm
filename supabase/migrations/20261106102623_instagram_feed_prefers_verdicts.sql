-- The feed: the 12 newest posts with a verdict, plus up to 3 still waiting (at several posts a day the newest 12 are all too young to judge).
create or replace function public.ig_feed(p_username text, p_n integer default 12)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $f$
declare m record; st text; q jsonb; rep jsonb; first_rep jsonb; line jsonb; why text; res jsonb := '[]'; judged int := 0; early int := 0;
begin
  for m in select i.media_id, i.posted_at, i.permalink, nullif(i.thumb, '') thumb, i.boosted, ig_kind(i.media_product_type, i.media_type) kind, ig_first_line(i.caption) title, sp.film_id
             from instagram_media i left join studio_posts sp on sp.media_id = i.media_id
            where i.username = p_username and i.reach is not null order by i.posted_at desc limit 70 loop
    exit when judged >= p_n;
    rep := null; first_rep := null;
    foreach st in array array['7d', '48h', 'latest'] loop
      q := ig_post_report(m.media_id, st);
      continue when not coalesce((q->>'available')::boolean, false);
      if q->>'verdict' is not null then rep := q; exit; end if;
      first_rep := coalesce(first_rep, q);
    end loop;
    rep := coalesce(rep, first_rep);
    continue when rep is null;
    if rep->>'verdict' is null then
      early := early + 1;
      continue when early > 3;
    else judged := judged + 1; end if;
    line := ig_post_line(rep);
    why := coalesce(line->>'why', case when (rep->>'age_hours')::numeric >= 144 then 'ما عندنا منشورات مشابهة كفاية'
                                       else 'نعطيك الحكم يوم ' || ig_date_ar(((m.posted_at at time zone 'Asia/Kuwait') + interval '7 days')::date) end);
    res := res || jsonb_build_object('id', m.media_id, 'kind', m.kind, 'title', left(coalesce(m.title, ''), 80), 'thumb', m.thumb, 'permalink', m.permalink,
      'posted_at', m.posted_at, 'film', m.film_id, 'boosted', m.boosted, 'verdict', rep->>'verdict', 'why', why, 'tip', line->>'tip',
      'score', rep->'score', 'confidence_ar', rep->'confidence_ar', 'comparison', rep->'comparison', 'vs', rep->'vs', 'stage', rep->'read_stage', 'at', rep->'at',
      'evidence', (select coalesce(jsonb_agg(jsonb_build_object('k', e->>'k', 'label', e->>'label', 'value', e->>'value', 'usual', e->>'usual', 'ratio', e->'ratio', 'state', e->>'state')), '[]')
                     from jsonb_array_elements(coalesce(rep->'evidence', '[]')) e where e->>'state' in ('good', 'mid', 'bad', 'nc', 'info')));
  end loop;
  return res;
end $f$;
