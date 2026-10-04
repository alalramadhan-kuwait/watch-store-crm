-- A Manual Sale is a claim; the till is the record. Check each claim against Lightspeed.
-- A claim matches a counted, non-return sale at the same outlet, within three hours of when
-- it was logged, whose total (or one of whose lines) equals the amount typed, to half a KD.

-- Internal: every Manual Sale in a date range with the sale that answers it, if any.
create or replace function public.manual_sale_matches(p_from date, p_to date)
 returns table(case_uuid uuid, case_ref text, outlet text, staff text, product text, amount_kd numeric,
               logged_at timestamptz, created_by uuid, sale_id text, receipt text, sale_kd numeric, sale_at timestamptz)
 language sql stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select c.id, c.case_id, c.outlet, c.staff, c.product, c.amount_kd, c.created_at, c.created_by,
         m.id, m.receipt_number, m.total_price_incl, m.sale_date
    from public.cases c
    left join lateral (
      select s.id, s.receipt_number, s.total_price_incl, s.sale_date
        from public.lightspeed_sales s
       where s.scope_code = public.resolve_outlet(c.outlet)
         and s.return_for is null
         and s.status = any(public.lightspeed_sale_counts())
         and s.sale_date between c.created_at - interval '3 hours' and c.created_at + interval '3 hours'
         and (abs(s.total_price_incl - c.amount_kd) <= 0.5
              or exists (select 1 from public.lightspeed_sale_items i
                          where i.sale_id = s.id and not i.is_return and abs(i.price_total - c.amount_kd) <= 0.5))
       order by abs(extract(epoch from (s.sale_date - c.created_at)))
       limit 1) m on true
   where c.case_type = 'Sale' and not c.deleted and c.amount_kd is not null
     and c.date_logged between p_from and p_to;
$function$;
revoke execute on function public.manual_sale_matches(date, date) from public, anon, authenticated;

-- What the app asks: the same, for the Manual Sales this login may see.
create or replace function public.manual_sale_checks(p_date date default null)
 returns table(case_uuid uuid, matched boolean, receipt text, sale_kd numeric, sale_at timestamptz, logged_at timestamptz)
 language sql stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  with me as (select public.get_my_role() as role)
  select m.case_uuid, m.sale_id is not null, m.receipt, m.sale_kd, m.sale_at, m.logged_at
    from public.manual_sale_matches(coalesce(p_date, public.kuwait_today()), coalesce(p_date, public.kuwait_today())) m, me
   where me.role = 'admin'
      or (me.role = 'manager' and public.resolve_outlet(m.outlet) = any(public.my_scope_codes()))
      or m.created_by = auth.uid()
      or m.staff = public.get_my_sales_name();
$function$;
revoke execute on function public.manual_sale_checks(date) from public, anon;
grant execute on function public.manual_sale_checks(date) to authenticated, service_role;

-- End of day: tell the people who can act which Manual Sales never reached the till.
create or replace function public.manual_sales_unmatched_digest()
 returns integer
 language plpgsql security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare n int; lines text;
begin
  select count(*), string_agg(coalesce(m.staff, '?') || ', ' || coalesce(m.outlet, '?') || ', ' ||
                              trim(trailing '.' from trim(trailing '0' from m.amount_kd::text)) || ' KD' ||
                              coalesce(', ' || nullif(trim(m.product), ''), ''), '; ' order by m.logged_at)
    into n, lines
    from public.manual_sale_matches(public.kuwait_today(), public.kuwait_today()) m
   where m.sale_id is null and m.logged_at < now() - interval '30 minutes';
  if coalesce(n, 0) = 0 then return 0; end if;
  perform public.notify_event('manual_sale_unmatched',
    n || ' manual sale' || case when n > 1 then 's' else '' end || ' not in the till',
    'Typed in the app, never rung on the till: ' || lines || '. Check cash and stock.',
    '#/', array['admin', 'manager'], null, null, 'manual_unmatched:' || public.kuwait_today()::text, null);
  return n;
end;
$function$;
revoke execute on function public.manual_sales_unmatched_digest() from public, anon, authenticated;

-- 23:30 Kuwait (20:30 UTC), after the shops have shut and the last sync has landed.
select cron.schedule('manual-sales-unmatched-digest', '30 20 * * *', $$select public.manual_sales_unmatched_digest()$$);
