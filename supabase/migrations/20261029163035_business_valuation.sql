-- Owner-only Business Valuation page: owners' answers + assumptions, and a live Lightspeed snapshot.
create table public.val_inputs (
  key text primary key,
  kind text not null check (kind in ('question','assumption')),
  section text not null,
  sort int not null default 0,
  question text not null,
  why text,
  answer text,
  value numeric,
  unit text,
  status text not null default 'open' check (status in ('open','answered','skipped')),
  found text,
  updated_at timestamptz not null default now(),
  updated_by text
);
comment on table public.val_inputs is 'Business Valuation page: the questions the owners answer and the assumptions (multiples, rates) the valuation methods use. Owners only.';
alter table public.val_inputs enable row level security;
create policy val_inputs_owners on public.val_inputs for all to authenticated using (public.is_owner()) with check (public.is_owner());

create or replace function public.val_operational_snapshot() returns json
language plpgsql stable security definer set search_path = public as $$
declare r json;
begin
  if not public.is_owner() then raise exception 'owners only'; end if;
  with last_sold as (
    select i.product_id, max(s.sale_day) d from lightspeed_sale_items i join lightspeed_sales s on s.id = i.sale_id
    where not i.is_return group by 1),
  st as (
    select s.product_id, s.brand, s.stock_on_hand q, coalesce(c.cost,0) cost, s.price, l.d, coalesce(p.ownership,'unknown') own
    from lightspeed_stock s left join lightspeed_stock_cost c using (product_id, outlet)
    left join last_sold l using (product_id) left join lightspeed_products p using (product_id)
    where s.stock_on_hand > 0),
  s12 as (select * from lightspeed_sales where sale_day > current_date - 365 and status not ilike '%void%' and ls_deleted_at is null),
  i12 as (select i.brand, i.price_total from lightspeed_sale_items i join s12 on s12.id = i.sale_id)
  select json_build_object(
    'as_of', current_date,
    'aging', (select json_agg(x order by x.ord) from (
       select case when d is null then 'Never sold' when d > current_date-90 then 'Sold in last 3 months' when d > current_date-180 then '3–6 months'
                   when d > current_date-365 then '6–12 months' else 'Over 12 months' end bucket,
              min(case when d is null then 5 when d > current_date-90 then 1 when d > current_date-180 then 2 when d > current_date-365 then 3 else 4 end) ord,
              round(sum(q*cost)) cost, round(sum(q*price)) retail, sum(q) units
       from st where own <> 'consignment' group by 1) x),
    'ownership', (select json_agg(x) from (select own, round(sum(q*cost)) cost, round(sum(q*price)) retail from st group by 1 order by 2 desc) x),
    'stock_brands', (select json_agg(x) from (select brand, round(sum(q*cost)) cost from st where own <> 'consignment' group by 1 order by 2 desc limit 10) x),
    'sales_12m', (select round(sum(total_price)) from s12),
    'sales_brands', (select json_agg(x) from (select brand, round(sum(price_total)) rev from i12 group by 1 order by 2 desc limit 10) x),
    'sales_outlets', (select json_agg(x) from (select outlet, round(sum(total_price)) rev from s12 group by 1 order by 2 desc) x),
    'customers', (select json_build_object('buyers', count(*), 'repeat', count(*) filter (where n > 1)) from (select customer_id, count(*) n from s12 where customer_id is not null group by 1) c),
    'monthly_sales', (select json_agg(x order by m) from (select to_char(sale_day,'YYYY-MM') m, round(sum(total_price)) rev from lightspeed_sales where sale_day >= date_trunc('month', current_date) - interval '24 months' and status not ilike '%void%' and ls_deleted_at is null group by 1) x)
  ) into r;
  return r;
end $$;
revoke all on function public.val_operational_snapshot() from public, anon;
grant execute on function public.val_operational_snapshot() to authenticated;

-- The questions and starting assumptions (val_inputs rows) were seeded directly in the database.
-- They contain business figures, so they are deliberately not kept in the repository.
