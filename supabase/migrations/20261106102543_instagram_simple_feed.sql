-- Step 2: the simple dashboard. Every recent post gets a verdict, one reason, one tip and a small saved thumbnail.
alter table public.instagram_media add column if not exists thumb text;

create or replace function public.ig_post_line(rep jsonb)
returns jsonb language plpgsql immutable as $f$
declare e jsonb; rr numeric; top_k text; top_r numeric := 0; low_k text; low_r numeric := 99; reach numeric; strong text; weak text; why text; tip text; v text := rep->>'verdict';
begin
  for e in select * from jsonb_array_elements(coalesce(rep->'evidence', '[]')) loop
    rr := (e->>'ratio')::numeric;
    continue when rr is null;
    if e->>'k' = 'reach' then reach := rr; end if;
    if rr > top_r then top_r := rr; top_k := e->>'k'; end if;
    if rr < low_r then low_r := rr; low_k := e->>'k'; end if;
  end loop;
  strong := case top_k
    when 'shares_pr' then case when top_r >= 3 then 'انرسل 3 مرات أكثر من المعتاد' when top_r >= 2 then 'انرسل ضعف المعتاد' else 'انرسل أكثر من المعتاد' end
    when 'reach' then 'وصل لناس أكثر من المعتاد' when 'saves_pr' then 'انحفظ أكثر من المعتاد' when 'skip_rate' then 'الافتتاحية مسكت الناس'
    when 'avg_watch_s' then 'شافوه وقت أطول من المعتاد' when 'likes_pr' then 'عجب الناس أكثر من المعتاد' when 'follows_pr' then 'جاب متابعين أكثر من المعتاد'
    when 'comments_pr' then 'فتح نقاش بالتعليقات' end;
  weak := case low_k
    when 'shares_pr' then 'قليل اللي أرسلوه' when 'reach' then 'وصل لناس أقل من المعتاد' when 'saves_pr' then 'قليل اللي حفظوه'
    when 'skip_rate' then 'كثير تخطّوه بأول 3 ثواني' when 'avg_watch_s' then 'طلعوا بدري' when 'likes_pr' then 'اللايكات أقل من المعتاد'
    when 'follows_pr' then 'ما جاب متابعين مثل العادة' when 'comments_pr' then 'التعليقات أقل من المعتاد' end;
  why := case v when 'good' then strong when 'bad' then weak
    when 'mid' then case when reach < 0.7 and top_r >= 1.2 then strong || '، بس وصل لناس أقل' else 'قريب من المعتاد' end end;
  if v in ('bad', 'mid') then
    select x->>'t' into tip from jsonb_array_elements(coalesce(rep->'try_next', '[]')) x
     where x->>'t' !~ '^(خلّ|جرّب فكرة جديدة|غيّر شي واحد)' limit 1;
  end if;
  return jsonb_build_object('why', why, 'tip', tip);
end $f$;

do $do$
declare d text;
begin
  select pg_get_functiondef('public.studio_refresh()'::regprocedure) into d;
  if position($o$begin d2 := ig_dash2(acc, case when acc = 'timekeeperkw' then briefs end);$o$ in d) = 0 then raise exception 'refresh'; end if;
  execute replace(d, $o$begin d2 := ig_dash2(acc, case when acc = 'timekeeperkw' then briefs end);$o$,
    $n$begin d2 := ig_dash2(acc, case when acc = 'timekeeperkw' then briefs end) || jsonb_build_object('feed', ig_feed(acc));$n$);
end $do$;

select cron.schedule('instagram-thumbs', '*/10 * * * *', $c$select net.http_post(url := 'https://ttshgrujnycapugrmyxs.supabase.co/functions/v1/instagram-thumbs', headers := jsonb_build_object('x-sync-key', (select a.sync_key from public.instagram_auth a where a.id = 1), 'Content-Type', 'application/json'), body := '{}'::jsonb, timeout_milliseconds := 120000)$c$);
