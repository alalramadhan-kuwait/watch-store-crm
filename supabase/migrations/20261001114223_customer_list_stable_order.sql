-- customer_list() returns every customer the caller may see (8,914 for the owner),
-- but the API hands back at most 1,000 rows per request, so the CRM screens saw
-- only the first 1,000 in no particular order: Occasions showed nobody although
-- Home counted 3, and a search only reached those 1,000. The apps now read the
-- list a page at a time; for pages to be consistent the order must be stable.
create or replace function public.customer_list()
returns table(id uuid, name text, contact text, phone_e164 text, is_vip boolean, responsible_employee_id uuid, responsible text, mine boolean, visits bigint, last_visit timestamp with time zone, open_followups bigint, purchases bigint, purchases_kd numeric, last_purchase timestamp with time zone, next_occasion date, next_occasion_label text, next_occasion_days integer)
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  with mine as (select public.my_related_customers() as id),
  v as (
    select customer_id, count(*) as visits, max(interaction_at) as last_visit,
           count(*) filter (where case_type = 'Follow-up' and status = 'Open') as open_followups
      from public.cases
     where customer_id is not null and not deleted
     group by customer_id),
  p as (
    select lc.phone_e164,
           count(*) filter (where s.return_for is null) as purchases,
           sum(s.total_price_incl) as kd,
           max(s.sale_date) filter (where s.return_for is null) as last_purchase
      from public.lightspeed_sales s
      join public.lightspeed_customers lc on lc.id = s.customer_id
     where s.status = any(public.lightspeed_sale_counts())
     group by lc.phone_e164),
  o as (
    select distinct on (customer_id) customer_id, occasion_date, label, days_until
      from public.upcoming_occasions(60)
     order by customer_id, days_until)
  select c.id,
         coalesce(nullif(trim(c.display_name), ''), c.contact),
         c.contact, c.phone_e164, coalesce(c.is_vip, false),
         c.responsible_employee_id, r.staff_name,
         (c.id in (select id from mine)),
         coalesce(v.visits, 0), v.last_visit, coalesce(v.open_followups, 0),
         coalesce(p.purchases, 0), coalesce(p.kd, 0), p.last_purchase,
         o.occasion_date, o.label, o.days_until
    from public.customers c
    left join v on v.customer_id = c.id
    left join p on p.phone_e164 = c.phone_e164
    left join public.roster_employees() r on r.employee_id = c.responsible_employee_id
    left join o on o.customer_id = c.id
   order by c.id
$function$;
