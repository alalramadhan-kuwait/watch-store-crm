-- Rates per reach rise when a post reaches only its keenest followers, so a post that reached far fewer people than usual cannot be Strong.
do $do$
declare d text;
begin
  select pg_get_functiondef('public.ig_post_report_core(text,text)'::regprocedure) into d;
  if position($o$    verdict := case when score >= 1.2 then 'good' when score <= 0.8 then 'bad' else 'mid' end;$o$ in d) = 0
     or position($o$      ratio := round(least(greatest(case when sig.dir = 1 then val / med when val = 0 then 3 else med / val end, 0), 3), 2);$o$ in d) = 0 then raise exception 'pattern'; end if;
  d := replace(d, $o$  cls text; ncls int;$o$, $n$  reach_ratio numeric; cls text; ncls int;$n$);
  d := replace(d, $o$      ratio := round(least(greatest(case when sig.dir = 1 then val / med when val = 0 then 3 else med / val end, 0), 3), 2);$o$,
   $n$      ratio := round(least(greatest(case when sig.dir = 1 then val / med when val = 0 then 3 else med / val end, 0), 3), 2);
      if sig.k = 'reach' then reach_ratio := ratio; end if;$n$);
  d := replace(d, $o$    verdict := case when score >= 1.2 then 'good' when score <= 0.8 then 'bad' else 'mid' end;$o$,
   $n$    verdict := case when score >= 1.2 and coalesce(reach_ratio, 0) >= 0.7 then 'good' when score <= 0.8 then 'bad' else 'mid' end;$n$);
  execute d;
end $do$;
