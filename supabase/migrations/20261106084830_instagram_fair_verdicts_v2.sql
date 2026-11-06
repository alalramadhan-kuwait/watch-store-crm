-- Step 1 of the simple Instagram dashboard: close the leftover test table, and make verdicts fair and honest.
alter table public._v21_check enable row level security;
revoke all on table public._v21_check from anon, authenticated;

-- A post boosted through Meta ads, matched by its Instagram shortcode.
create or replace function public.ig_is_boosted(p_permalink text)
returns boolean language sql stable security definer set search_path to 'public' as $f$
  select exists (select 1 from meta_ads a
    where substring(a.creative->>'instagram_permalink_url' from '/(?:p|reel|reels|tv)/([^/?]+)') = substring(p_permalink from '/(?:p|reel|reels|tv)/([^/?]+)'))
$f$;

-- Carousels mix daily news and studio stories; they are compared with their own class when 8+ final posts exist.
create or replace function public.ig_content_class(t text)
returns text language sql immutable as $f$
  select case when public.ig_content_type(coalesce(t, '')) = 'قصة أو شرح' then 'story' else 'news' end
$f$;

do $do$
declare d text; pairs text[][] := array[
  -- new variables
  [$o$  weakest text; weak_v numeric := 99;$o$,
   $n$  cls text; ncls int; use_pct boolean; boosted boolean;
  weakest text; weak_v numeric := 99;$n$],
  -- pick the comparison class before the baseline
  [$o$  -- the baseline: up to 30 earlier posts$o$,
   $n$  boosted := ig_is_boosted(r.permalink);
  if r.kind = 'carousel' then
    cls := ig_content_class(r.caption);
    select count(*) into ncls from ig_reads('latest') x where x.username = r.username and x.kind = r.kind and x.media_id <> r.media_id
       and x.age_hours >= 168 and x.posted_at < r.posted_at and x.posted_at > r.posted_at - interval '120 days' and ig_content_class(x.caption) = cls;
    if ncls < 8 then cls := null; end if;
  end if;

  -- the baseline: the larger of 30 posts or 60 days, up to 120 days; never boosted posts. Earlier: up to 30 earlier posts$n$],
  [$o$    from (select * from ig_reads(cur) x where x.username = r.username and x.kind = r.kind and x.media_id <> r.media_id
             and x.posted_at < r.posted_at and x.posted_at > r.posted_at - interval '120 days'
           order by x.posted_at desc limit 30) s;$o$,
   $n$    from (select * from (select x.*, row_number() over (order by x.posted_at desc) rn from ig_reads(cur) x
             where x.username = r.username and x.kind = r.kind and x.media_id <> r.media_id
               and x.posted_at < r.posted_at and x.posted_at > r.posted_at - interval '120 days'
               and not ig_is_boosted(x.permalink) and (cls is null or ig_content_class(x.caption) = cls)) q
           where q.rn <= 30 or q.posted_at > r.posted_at - interval '60 days') s;$n$],
  [$o$      from (select * from ig_reads('latest') x where x.username = r.username and x.kind = r.kind and x.media_id <> r.media_id
               and x.age_hours >= 168 and x.posted_at < r.posted_at and x.posted_at > r.posted_at - interval '120 days'
             order by x.posted_at desc limit 30) s;$o$,
   $n$      from (select * from (select x.*, row_number() over (order by x.posted_at desc) rn from ig_reads('latest') x
               where x.username = r.username and x.kind = r.kind and x.media_id <> r.media_id
                 and x.age_hours >= 168 and x.posted_at < r.posted_at and x.posted_at > r.posted_at - interval '120 days'
                 and not ig_is_boosted(x.permalink) and (cls is null or ig_content_class(x.caption) = cls)) q
             where q.rn <= 30 or q.posted_at > r.posted_at - interval '60 days') s;$n$],
  -- percentage watched replaces seconds once 5+ comparable films have a known length
  [$o$    rawn := case sig.k when 'shares_pr' then r.shares$o$,
   $n$    use_pct := sig.k = 'avg_watch_s' and r.watch_ratio is not null and coalesce(b.n_watch_ratio, 0) >= 5;
    if use_pct then val := r.watch_ratio; med := b.watch_ratio; nmet := b.n_watch_ratio; end if;
    rawn := case sig.k when 'shares_pr' then r.shares$n$],
  [$o$    if val is null then state := 'na';$o$,
   $n$    if use_pct then vtxt := round(val * 100) || '%'; mtxt := round(med * 100) || '%'; end if;
    if val is null then state := 'na';$n$],
  -- a verdict needs a fair comparison: reach included, 5+ comparable posts, and 36 hours
  [$o$  if nscored >= 3 and r.age_hours >= 12 then$o$,
   $n$  if nscored >= 3 and comparable and b.n >= 5 and r.age_hours >= 36 then$n$],
  [$o$case when r.age_hours < 12 then 'بدري نحكم' else 'ما نقدر نحكم' end)$o$,
   $n$case when not comparable or r.age_hours < 36 then 'بدري نحكم' else 'ما نقدر نحكم' end)$n$],
  -- what the verdict was compared with, for the detailed view
  [$o$    'basis', basis, 'baseline_posts', b.n, 'signals_compared', nscored,$o$,
   $n$    'basis', basis, 'baseline_posts', b.n, 'signals_compared', nscored, 'score_version', 2, 'boosted', boosted,
    'comparison', jsonb_build_object('posts', b.n, 'same_account', true, 'format', r.kind, 'same_age', basis = 'same_stage',
                                     'content_class', cls, 'excludes_boosted', true, 'needed', 5),$n$]];
  i int;
begin
  select pg_get_functiondef('public.ig_post_report_core(text,text)'::regprocedure) into d;
  for i in 1 .. array_length(pairs, 1) loop
    if position(pairs[i][1] in d) = 0 then raise exception 'pattern % not found', i; end if;
    d := replace(d, pairs[i][1], pairs[i][2]);
  end loop;
  execute d;
end $do$;

update public.instagram_auth set graph_version = 'v27.0' where id = 1;
