-- DSR sales come from Lightspeed, not from typing (3 Oct 2026).
--
-- Staff were entering every sale twice, once at the till and once in the DSR:
-- 98% of the sales typed in matched a Lightspeed sale, and Lightspeed held about
-- 20% more (all of Eman's online and WhatsApp sales, and floor sales nobody
-- typed). So the DSR now reads its sales from Lightspeed.
--
--   store_day_sales(outlet, from, to)   count, revenue, per-person and "as of" for
--                                       a shop and a date range; what the day
--                                       report, the target line, Team and Home use.
--   follow_up_sale_matches()            open follow-ups whose customer has since
--                                       bought in Lightspeed, to be confirmed with
--                                       one tap rather than marked won by hand.
--   answer_follow_up_sale()             records yes/no, and marks the follow-up Won
--                                       on yes, under the caller's own permissions.
--   follow_up_sale_checks               the answers, so a "no" is not asked twice.

create or replace function public.store_day_sales(p_outlet text, p_from date, p_to date)
returns jsonb
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
  with me as (select public.get_my_role() as role),
  s as (
    select s.* from public.lightspeed_sales s, me
     where me.role in ('admin', 'manager', 'sales', 'staff')
       and s.sale_day between p_from and p_to
       and s.status = any(public.lightspeed_sale_counts())
       and (coalesce(p_outlet, '') = '' or s.scope_code = public.resolve_outlet(p_outlet))
       and (me.role <> 'manager' or s.scope_code in (select unnest(public.my_scope_codes())))
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
                 group by e.dsr_staff_name) q), '[]'::jsonb))
$function$;
grant execute on function public.store_day_sales(text, date, date) to authenticated;

create table if not exists public.follow_up_sale_checks (
  case_id uuid not null references public.cases(id) on delete cascade,
  sale_id text not null,
  bought boolean not null,
  answered_by uuid not null default auth.uid(),
  answered_at timestamptz not null default now(),
  primary key (case_id, sale_id)
);
alter table public.follow_up_sale_checks enable row level security;
create policy follow_up_sale_checks_insert on public.follow_up_sale_checks for insert to authenticated
  with check (answered_by = auth.uid());
create policy follow_up_sale_checks_update on public.follow_up_sale_checks for update to authenticated
  using (answered_by = auth.uid()) with check (answered_by = auth.uid());
create policy follow_up_sale_checks_read on public.follow_up_sale_checks for select to authenticated
  using (answered_by = auth.uid() or public.get_my_role() in ('admin', 'manager'));

create or replace function public.follow_up_sale_matches()
returns table(case_id uuid, customer_name text, product text, followed_up_on date,
              sale_id text, sale_at timestamptz, sale_kd numeric, sold_by text, receipt text)
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
  select distinct on (c.id)
         c.id,
         coalesce(nullif(trim(cu.display_name), ''), c.customer_name),
         c.product, c.date_logged,
         s.id, s.sale_date, s.total_price_incl,
         (select e.dsr_staff_name from public.sale_credits sc join public.employees e on e.id = sc.employee_id
           where sc.sale_id = s.id limit 1),
         s.receipt_number
    from public.cases c
    join public.customers cu on cu.id = c.customer_id
    join public.lightspeed_customers lc on lc.phone_e164 = cu.phone_e164
    join public.lightspeed_sales s on s.customer_id = lc.id
   where c.case_type = 'Follow-up' and c.status = 'Open' and not c.deleted
     and cu.phone_e164 is not null
     and s.return_for is null and s.total_price_incl > 0
     and s.status = any(public.lightspeed_sale_counts())
     and s.sale_date >= coalesce(c.interaction_at, (c.date_logged::timestamp at time zone 'Asia/Kuwait'))
     and not exists (select 1 from public.follow_up_sale_checks k where k.case_id = c.id and k.sale_id = s.id)
     and (public.get_my_role() = 'admin'
          or (public.get_my_role() = 'manager' and public.resolve_outlet(c.outlet) = any(public.my_scope_codes()))
          or c.customer_id in (select public.my_related_customers())
          or c.staff = public.get_my_sales_name())
   order by c.id, s.sale_date
$function$;
grant execute on function public.follow_up_sale_matches() to authenticated;

create or replace function public.answer_follow_up_sale(p_case uuid, p_sale text, p_bought boolean)
returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  if p_bought then
    update public.cases set status = 'Won', updated_by = auth.uid(), updated_at = now()
     where id = p_case and case_type = 'Follow-up' and status = 'Open';
    if not found then raise exception 'You cannot close this follow-up'; end if;
  end if;
  insert into public.follow_up_sale_checks (case_id, sale_id, bought)
  values (p_case, p_sale, p_bought)
  on conflict (case_id, sale_id) do update set bought = excluded.bought, answered_at = now();
end $function$;
grant execute on function public.answer_follow_up_sale(uuid, text, boolean) to authenticated;
