-- A shift ends when the account recovers (8 Nov 2026). Timekeeper's reach fell from 25 Oct and came back on 5–6 Nov
-- (145 and 162 thousand a day, mostly non-followers), but the detector, run on a day already back to normal, recorded
-- a new "drop since 5 Nov" (it started its walk back from that day). Now:
-- * a new shift is recorded only when the latest day is itself on the shifted side;
-- * an open shift is closed (resolved_at) once the last 3 days' median is back in the normal band;
-- * the numbers screen shows only an open shift, so the gist and the prediction card stop warning about a drop.

alter table public.ig_shifts add column if not exists resolved_at timestamptz;

create or replace function public.ig_detect_shifts() returns integer language plpgsql security definer set search_path = public as $$
declare u text; d0 date; q25 numeric; q75 numeric; med_prev numeric; med7 numeric; med3 numeric; last_reach numeric; below int; above int; dir text; v_since date; dd record; v_detail jsonb; ex bigint; n int := 0;
begin
  foreach u in array array['timekeeperkw', 'timegallerykw'] loop
    select max(snapshot_date) into d0 from instagram_daily where username = u and reach is not null;
    continue when d0 is null;
    select percentile_cont(0.25) within group (order by reach), percentile_cont(0.5) within group (order by reach), percentile_cont(0.75) within group (order by reach)
      into q25, med_prev, q75 from instagram_daily where username = u and reach is not null and snapshot_date > d0 - 35 and snapshot_date <= d0 - 7;
    select percentile_cont(0.5) within group (order by reach), count(*) filter (where reach < q25), count(*) filter (where reach > q75)
      into med7, below, above from instagram_daily where username = u and reach is not null and snapshot_date > d0 - 7;
    select percentile_cont(0.5) within group (order by reach) into med3 from instagram_daily where username = u and reach is not null and snapshot_date > d0 - 3;
    select reach into last_reach from instagram_daily where username = u and snapshot_date = d0;
    -- an open shift ends when the last 3 days are back in the normal band
    update ig_shifts set resolved_at = now(), updated_at = now()
     where ig_shifts.username = u and ig_shifts.resolved_at is null
       and ((ig_shifts.direction = 'down' and med3 >= 0.75 * med_prev) or (ig_shifts.direction = 'up' and med3 <= 1.33 * med_prev));
    dir := case when med7 <= 0.7 * med_prev and below >= 5 then 'down' when med7 >= 1.4 * med_prev and above >= 5 then 'up' end;
    continue when dir is null;
    -- the latest day must itself be on the shifted side: a week that was low but has recovered is not a new shift
    continue when (dir = 'down' and last_reach >= 0.75 * med_prev) or (dir = 'up' and last_reach <= 1.33 * med_prev);
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
    select id into ex from ig_shifts where ig_shifts.username = u and ig_shifts.direction = dir and ig_shifts.resolved_at is null
       and v_since between ig_shifts.since - 3 and ig_shifts.since + 3 order by detected_at desc limit 1;
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

-- the numbers screen reads only an open shift
do $$
declare src text;
begin
  src := pg_get_functiondef('public.ig_dash2(text, jsonb)'::regprocedure);
  if position('and resolved_at is null' in src) = 0 then
    src := replace(src, 'from ig_shifts where username = p_username and detected_at > now() - interval ''14 days''',
                        'from ig_shifts where username = p_username and resolved_at is null and detected_at > now() - interval ''14 days''');
    execute src;
  end if;
end $$;

-- the "drop since 5 Nov" was recorded on a day already back to normal: it was never a shift
update public.ig_shifts set resolved_at = now(), updated_at = now(),
       detail = coalesce(detail, '{}'::jsonb) || jsonb_build_object('note', 'recorded on a day already back to normal (5 Nov 145k, 6 Nov 162k); not a shift')
 where username = 'timekeeperkw' and since = '2026-11-05' and resolved_at is null;
select public.studio_refresh();
