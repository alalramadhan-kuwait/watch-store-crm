-- Shop costs on the Payroll page, owners only. For a month, each place the
-- business pays rent for: what it sold (Lightspeed, counted as every report
-- counts it), its rent (pay.rents, the row in force that month), and its
-- staff's pay that month (pay_month's lines, by where each person works).
-- What is left is sales after rent and staff pay, before the cost of goods.
-- Online and WhatsApp sales belong to the head office, which is where the
-- accountant's report puts them too.

create or replace function public.pay_shop_costs(p_month date)
returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'pay'
as $$
declare
  v_m0 date := date_trunc('month', p_month)::date;
  v_m1 date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_lines jsonb;
begin
  perform pay.guard();
  v_lines := coalesce(public.pay_month(v_m0) -> 'lines', '[]'::jsonb);
  return (
    with c as (
      select code, case code when 'hq' then 'Online & head office' else display_name end as name, sort_order
        from outlets where kind = 'physical' and active),
    centre as (
      select o.code as scope, case when o.code in (select code from c) then o.code else 'hq' end as code from outlets o),
    sales as (
      select ce.code, sum(s.total_price_incl) as kd
        from lightspeed_sales s join centre ce on ce.scope = s.scope_code
       where s.sale_day >= v_m0 and s.sale_day < v_m1 and s.status = any(lightspeed_sale_counts())
       group by ce.code),
    staff as (
      select coalesce(resolve_outlet(l ->> 'location'), 'hq') as code,
             sum((l ->> 'net')::numeric) as kd,
             count(*) filter (where (l ->> 'net')::numeric > 0) as n
        from jsonb_array_elements(v_lines) l group by 1),
    rent as (
      select distinct on (scope_code) scope_code, monthly_rent, paid_every_months, note
        from pay.rents where effective_from < v_m1
       order by scope_code, effective_from desc, id desc),
    hist as (
      select scope_code, jsonb_agg(jsonb_build_object('from', effective_from, 'rent', monthly_rent,
               'every', paid_every_months, 'note', note, 'by', set_by_name, 'at', at)
               order by effective_from desc, id desc) as h
        from pay.rents group by scope_code)
    select jsonb_build_object('month', v_m0, 'shops', coalesce(jsonb_agg(jsonb_build_object(
             'code', c.code, 'name', c.name,
             'sales', round(coalesce(sa.kd, 0), 3),
             'rent', coalesce(r.monthly_rent, 0), 'has_rent', r.scope_code is not null,
             'rent_every', r.paid_every_months, 'rent_note', r.note,
             'staff', round(coalesce(st.kd, 0), 3), 'people', coalesce(st.n, 0),
             'left', round(coalesce(sa.kd, 0) - coalesce(r.monthly_rent, 0) - coalesce(st.kd, 0), 3),
             'rent_history', coalesce(h.h, '[]'::jsonb)) order by c.sort_order), '[]'::jsonb))
      from c
      left join sales sa on sa.code = c.code
      left join staff st on st.code = c.code
      left join rent r on r.scope_code = c.code
      left join hist h on h.scope_code = c.code);
end $$;

-- A new rent is a new row with the month it starts; the old one stays as history.
create or replace function public.pay_rent_set(p_scope text, p_effective_from date, p_monthly_rent numeric,
                                               p_paid_every_months int default 1, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pay'
as $$
declare v_id bigint;
begin
  perform pay.guard();
  if not exists (select 1 from outlets where code = p_scope and kind = 'physical') then
    raise exception 'No shop or office with that code.' using errcode = 'P0002';
  end if;
  if p_monthly_rent is null or p_monthly_rent < 0 then
    raise exception 'Give the monthly rent.' using errcode = '22023';
  end if;
  if p_effective_from is null or p_effective_from > ((now() at time zone 'Asia/Kuwait')::date + 366) then
    raise exception 'Give the month the rent starts (at most a year ahead).' using errcode = '22023';
  end if;
  insert into pay.rents (scope_code, effective_from, monthly_rent, paid_every_months, note, set_by_name)
  values (p_scope, p_effective_from, p_monthly_rent, greatest(1, least(12, coalesce(p_paid_every_months, 1))),
          nullif(trim(coalesce(p_note, '')), ''), pay.my_name())
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

revoke all on function public.pay_shop_costs(date) from public, anon;
revoke all on function public.pay_rent_set(text, date, numeric, int, text) from public, anon;
grant execute on function public.pay_shop_costs(date) to authenticated;
grant execute on function public.pay_rent_set(text, date, numeric, int, text) to authenticated;
