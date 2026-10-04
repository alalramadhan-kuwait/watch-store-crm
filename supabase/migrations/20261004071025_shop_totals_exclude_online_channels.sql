-- Shop totals are shops only; Online and WhatsApp are listed beside them (4 Oct 2026).
--
-- The owner opened Today's Log on "All outlets" and saw "1 sale, 298 KD" that no shop
-- could be chosen to show. It was an online order (invoice 12572, rung up by the website
-- account "TK - Online Orders"): store_day_sales() and lightspeed_today() added Online and
-- WhatsApp orders into the all-outlets total, yet Online and WhatsApp are not shops, so
-- picking Avenues or Time Gallery never found the sale. This month the same mix-up had
-- put 15 online sales (2,979 KD) into the shops' 30 sales / 7,997 KD.
--
--   * With no outlet given, the totals are the physical shops that sell.
--   * Online / WhatsApp come back beside them as `channels` (code, name, sales, revenue),
--     for a screen to show on its own line. Revenue is null for the shared shop login.
--   * Asking for a named outlet, shop or channel, behaves as before.
--   * lightspeed_today() now counts the way store_day_sales() does: a return is not a
--     sale, and only the statuses that count as sales are included.

create or replace function public.store_day_sales(p_outlet text, p_from date, p_to date)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  with me as (select public.get_my_role() as role),
  base as (
    select s.*, o.kind, o.display_name
      from public.lightspeed_sales s
      join public.outlets o on o.code = s.scope_code, me
     where me.role in ('admin', 'manager', 'sales', 'staff')
       and s.sale_day between p_from and p_to
       and s.status = any(public.lightspeed_sale_counts())
       and o.sells
       and (me.role <> 'manager' or s.scope_code in (select unnest(public.my_scope_codes())))
  ),
  s as (
    select * from base
     where case when coalesce(p_outlet, '') = '' then kind = 'physical'
                else scope_code = public.resolve_outlet(p_outlet) end
  )
  select jsonb_build_object(
    'sales',   (select count(*) from s where return_for is null),
    'revenue', case when (select role from me) = 'staff' then null
                    else (select round(coalesce(sum(total_price_incl), 0), 3) from s) end,
    'as_of',   (select max(last_success_at) from public.lightspeed_sync_state where kind = 'sales'),
    'by_person', coalesce((
        select jsonb_agg(jsonb_build_object('name', q.name, 'count', q.n, 'kd', q.kd) order by q.kd desc)
          from (select e.dsr_staff_name as name, count(*) n, round(sum(s.total_price_incl), 3) kd
                  from s join public.sale_credits sc on sc.sale_id = s.id
                  join public.employees e on e.id = sc.employee_id
                 where s.return_for is null and e.dsr_staff_name is not null
                 group by e.dsr_staff_name) q), '[]'::jsonb),
    'channels', case when coalesce(p_outlet, '') <> '' then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object('code', c.code, 'name', c.name, 'sales', c.n,
                 'revenue', case when (select role from me) = 'staff' then null else c.kd end) order by c.code)
          from (select b.scope_code as code, b.display_name as name,
                       count(*) filter (where b.return_for is null) as n,
                       round(sum(b.total_price_incl), 3) as kd
                  from base b where b.kind <> 'physical'
                 group by b.scope_code, b.display_name) c), '[]'::jsonb) end)
$function$;

create or replace function public.lightspeed_today(p_outlet text default null)
 returns jsonb
 language sql
 stable
 set search_path to 'public', 'pg_temp'
as $function$
  with t as (
    select s.*, o.kind, o.display_name
      from public.lightspeed_sales s
      join public.outlets o on o.code = s.scope_code
     where s.sale_day = public.kuwait_today()
       and s.status = any(public.lightspeed_sale_counts())
       and o.sells
  ),
  shops as (
    select * from t
     where case when coalesce(p_outlet, '') = '' then kind = 'physical'
                else scope_code = public.resolve_outlet(p_outlet) end
  )
  select jsonb_build_object(
    'sales',   (select count(*) from shops where return_for is null),
    'revenue', (select round(coalesce(sum(total_price_incl), 0), 3) from shops),
    'scope',   public.resolve_outlet(p_outlet),
    'as_of',   (select max(last_success_at) from public.lightspeed_sync_state where kind = 'sales'),
    'channels', case when coalesce(p_outlet, '') <> '' then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object('code', c.code, 'name', c.name, 'sales', c.n, 'revenue', c.kd) order by c.code)
          from (select t.scope_code as code, t.display_name as name,
                       count(*) filter (where t.return_for is null) as n,
                       round(sum(t.total_price_incl), 3) as kd
                  from t where t.kind <> 'physical'
                 group by t.scope_code, t.display_name) c), '[]'::jsonb) end)
$function$;
