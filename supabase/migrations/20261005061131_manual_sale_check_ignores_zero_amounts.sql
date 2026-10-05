-- A Manual Sale typed at 0 KD (a free item) can never match a till sale; it only made the evening alert cry wolf.
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.manual_sale_matches(date,date)'::regprocedure);
  n := replace(d, 'and c.amount_kd is not null', 'and c.amount_kd > 0');
  if n = d then raise exception 'manual_sale_matches: pattern not found'; end if;
  execute n;
end $$;
