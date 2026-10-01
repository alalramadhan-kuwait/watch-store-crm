-- The weekly target is customers contacted, not sales (1 Oct 2026, the owner's correction).
-- How many different customers a person opened WhatsApp for, from the customer lists,
-- in a Saturday–Friday week, against a target. weekly_sales_targets and
-- team_week_sales() from 20261001132900 stay in place but are no longer shown.
-- Seeded at 20 customers a week for the four salespeople (about three a working
-- day; the Top list alone is 630 people, so a week's worth is a small bite).

create table if not exists public.weekly_contact_targets (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  target_customers integer not null check (target_customers > 0),
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
alter table public.weekly_contact_targets enable row level security;
create policy weekly_contact_targets_read on public.weekly_contact_targets for select to authenticated
  using (public.get_my_role() in ('admin', 'manager') or employee_id = public.my_employee_id());

insert into public.weekly_contact_targets (employee_id, target_customers)
select e.id, 20 from public.employees e
 where e.dsr_staff_name in ('Raneen', 'Ahmad Khalaf', 'Ahmad Ysari', 'Fadi')
on conflict (employee_id) do nothing;

create or replace function public.team_week_contacts(p_from date, p_to date)
returns table(employee_id uuid, staff_name text, customers integer, messages integer, target_customers integer)
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
  select e.id, e.dsr_staff_name, coalesce(c.cust, 0)::int, coalesce(c.msgs, 0)::int, t.target_customers
    from public.employees e
    left join public.weekly_contact_targets t on t.employee_id = e.id
    left join lateral (
      select count(distinct h.customer_id) cust, count(*) msgs
        from public.whatsapp_handoffs h
       where h.employee_id = e.id
         and h.created_at >= (p_from::text || ' 00:00+03')::timestamptz
         and h.created_at <  ((p_to + 1)::text || ' 00:00+03')::timestamptz
    ) c on true
   where e.dsr_staff_name is not null
     and coalesce(e.status, 'active') <> 'inactive'
     and (public.get_my_role() in ('admin', 'manager') or e.id = public.my_employee_id())
$function$;
grant execute on function public.team_week_contacts(date, date) to authenticated;

create or replace function public.set_weekly_contact_target(p_employee uuid, p_target integer)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if public.get_my_role() not in ('admin', 'manager') then
    raise exception 'Only an owner or manager can set a target';
  end if;
  if p_target is null or p_target <= 0 then
    delete from public.weekly_contact_targets where employee_id = p_employee;
  else
    insert into public.weekly_contact_targets (employee_id, target_customers, updated_by, updated_at)
    values (p_employee, p_target, auth.uid(), now())
    on conflict (employee_id) do update set target_customers = excluded.target_customers, updated_by = auth.uid(), updated_at = now();
  end if;
end $function$;
grant execute on function public.set_weekly_contact_target(uuid, integer) to authenticated;
