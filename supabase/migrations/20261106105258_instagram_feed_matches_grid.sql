-- The grid must match Instagram: the 30 newest posts in order with none skipped, plus linked studio films so the filter finds them.
-- Covers load apart from the page's data, a few at a time, so they can be sharper.
drop function if exists public.ig_feed_thumbs();
update public.instagram_media set thumb = null where thumb is not null;

create or replace function public.ig_feed(p_username text, p_n integer default 30)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $f$
declare m record; st text; q jsonb; rep jsonb; first_rep jsonb; line jsonb; why text; res jsonb := '[]';
begin
  for m in select * from (
             select i.media_id, i.posted_at, i.permalink, i.boosted, ig_kind(i.media_product_type, i.media_type) kind, ig_first_line(i.caption) title, sp.film_id,
                    row_number() over (order by i.posted_at desc) rn
               from instagram_media i left join studio_posts sp on sp.media_id = i.media_id
              where i.username = p_username and i.reach is not null) z
            where z.rn <= p_n or z.film_id is not null order by z.posted_at desc loop
    rep := null; first_rep := null;
    foreach st in array array['7d', '48h', 'latest'] loop
      q := ig_post_report(m.media_id, st);
      continue when not coalesce((q->>'available')::boolean, false);
      if q->>'verdict' is not null then rep := q; exit; end if;
      first_rep := coalesce(first_rep, q);
    end loop;
    rep := coalesce(rep, first_rep);
    continue when rep is null;
    line := ig_post_line(rep);
    why := coalesce(line->>'why', case when (rep->>'age_hours')::numeric >= 144 then 'ما عندنا منشورات مشابهة كفاية'
                                       else 'نعطيك الحكم يوم ' || ig_date_ar(((m.posted_at at time zone 'Asia/Kuwait') + interval '7 days')::date) end);
    res := res || jsonb_build_object('id', m.media_id, 'kind', m.kind, 'title', left(coalesce(m.title, ''), 80), 'permalink', m.permalink,
      'posted_at', m.posted_at, 'film', m.film_id, 'boosted', m.boosted, 'verdict', rep->>'verdict', 'why', why, 'tip', line->>'tip',
      'score', rep->'score', 'confidence_ar', rep->'confidence_ar', 'comparison', rep->'comparison', 'vs', rep->'vs', 'stage', rep->'read_stage', 'at', rep->'at',
      'evidence', (select coalesce(jsonb_agg(jsonb_build_object('k', e->>'k', 'label', e->>'label', 'value', e->>'value', 'usual', e->>'usual', 'ratio', e->'ratio', 'state', e->>'state')), '[]')
                     from jsonb_array_elements(coalesce(rep->'evidence', '[]')) e where e->>'state' in ('good', 'mid', 'bad', 'nc', 'info')));
  end loop;
  return res;
end $f$;

create or replace function public.studio_thumbs(p jsonb)
returns jsonb language sql stable security definer set search_path to 'public' as $f$
  select coalesce(jsonb_object_agg(media_id, thumb), '{}') from instagram_media
   where thumb <> '' and media_id in (select jsonb_array_elements_text(p))
$f$;

select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'instagram-thumbs'), schedule := '*/2 * * * *');
