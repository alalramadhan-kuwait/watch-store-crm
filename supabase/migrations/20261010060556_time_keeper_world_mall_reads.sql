-- Time Keeper World, the Watch Mall: world_mall(), the owners' read (part 2 of 4; see 20261010060135).
-- Superseded in full by 20261010061220, which reads only active featured brands.

-- 3. What the mall reads ----------------------------------------------------------------

create or replace function public.world_mall()
returns jsonb
language plpgsql stable security definer set search_path = public, world as $$
declare
  v_today date := (now() at time zone 'Asia/Kuwait')::date;
  v_d date := (now() at time zone 'Asia/Kuwait')::date - 1;
  v_set world.mall_settings;
  v_last date;
  v_first date;
  v_days integer;
  v_places jsonb; v_featured jsonb; v_sold jsonb; v_sold30 jsonb; v_staff jsonb; v_suggest jsonb; v_slots jsonb;
begin
  perform world_guard();
  select * into v_set from world.mall_settings;
  select max(day), min(day), count(distinct day) into v_last, v_first, v_days from world.brand_value_daily;

  select coalesce(jsonb_agg(jsonb_build_object('slot', slot, 'section', section, 'kind', kind,
           'capacity', capacity, 'spare', spare) order by ord), '[]'::jsonb)
  into v_slots from world.mall_slots;

  select coalesce(jsonb_agg(jsonb_build_object('brand', p.brand, 'slot', p.slot, 'position', p.position, 'how', p.how,
           'placed_at', p.placed_at, 'placed_by', p.placed_by_name) order by s.ord, p.position), '[]'::jsonb)
  into v_places from world.mall_places p join world.mall_slots s using (slot);

  select coalesce(jsonb_agg(jsonb_build_object('brand', brand, 'at', featured_at, 'by', featured_by_name) order by brand), '[]'::jsonb)
  into v_featured from world.mall_featured;

  with lines as (
    select s.sale_day, nullif(trim(p.brand), '') brand, i.quantity
    from lightspeed_sales s
    join lightspeed_sale_items i on i.sale_id = s.id
    join lightspeed_products p on p.product_id = i.product_id
    where s.sale_day between v_d - 29 and v_d
      and s.outlet is not null
      and coalesce(s.status, '') !~ 'VOID|SAVED|PARKED|AWAITING'
      and coalesce(i.status, '') !~ 'VOID|SAVED')
  select coalesce(jsonb_object_agg(brand, u) filter (where u <> 0), '{}'::jsonb) into v_sold
  from (select brand, sum(quantity) u from lines where sale_day = v_d and brand is not null group by brand) x;
  with lines as (
    select nullif(trim(p.brand), '') brand, i.quantity
    from lightspeed_sales s
    join lightspeed_sale_items i on i.sale_id = s.id
    join lightspeed_products p on p.product_id = i.product_id
    where s.sale_day between v_d - 29 and v_d
      and s.outlet is not null
      and coalesce(s.status, '') !~ 'VOID|SAVED|PARKED|AWAITING'
      and coalesce(i.status, '') !~ 'VOID|SAVED')
  select coalesce(jsonb_object_agg(brand, u) filter (where u <> 0), '{}'::jsonb) into v_sold30
  from (select brand, sum(quantity) u from lines where brand is not null group by brand) x;

  with hist as (select * from world.brand_value_daily where day > coalesce(v_last, v_today) - 800),
  placed as (select p.brand, s.kind from world.mall_places p join world.mall_slots s using (slot)),
  promote as (
    select h.brand, 'promote' kind, 'threshold' reason, count(*) days
    from hist h
    where v_first is not null and v_first <= v_last - v_set.promote_after_days + 1
      and h.day > v_last - v_set.promote_after_days
      and not exists (select 1 from placed p where p.brand = h.brand and p.kind = 'boutique')
    group by h.brand
    having bool_and(h.cost_value >= v_set.boutique_threshold_kd)
       and count(*) >= greatest(v_set.promote_after_days - 2, 1)
    union all
    select f.brand, 'promote', 'featured', null
    from world.mall_featured f
    where not exists (select 1 from placed p where p.brand = f.brand and p.kind = 'boutique')),
  free as (
    select p.brand, 'free' kind, 'empty' reason, v_set.free_after_days days
    from placed p
    where p.kind <> 'boutique' and v_first is not null and v_first <= v_last - v_set.free_after_days + 1
      and not exists (select 1 from hist h where h.brand = p.brand and h.day > v_last - v_set.free_after_days and h.units > 0)),
  below as (
    select p.brand, 'below' kind, 'threshold' reason,
           (select v_last - max(h.day) from hist h where h.brand = p.brand and h.cost_value >= v_set.boutique_threshold_kd) days
    from placed p
    where p.kind = 'boutique'
      and coalesce((select h.cost_value from hist h where h.brand = p.brand and h.day = v_last), 0) < v_set.boutique_threshold_kd)
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'brand', brand, 'reason', reason, 'days', days) order by kind, brand), '[]'::jsonb)
  into v_suggest from (select * from promote union all select * from free union all select * from below) x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'employee_id', e.id, 'name', trim(e.full_name), 'name_ar', e.name_ar, 'role', trim(e.job_title),
           'location', e.location, 'look', coalesce(l.look, 'neutral'),
           'duty', jsonb_build_object('state', d.state, 'clock_in', o.clock_in, 'until', d.deadline, 'outlet', o.outlet_code))
           order by e.location, e.full_name), '[]'::jsonb)
  into v_staff
  from employees e
  left join world.character_looks l on l.employee_id = e.id
  left join lateral (
    select sh.clock_in, sh.outlet_code from attendance_shifts sh
    where sh.employee_id = e.id and sh.work_date = v_today and sh.is_open and not sh.is_abandoned
    order by sh.clock_in desc limit 1) o on true
  left join lateral (
    select sc.shift_start, sc.shift_end, sc.working_days from schedule_on(e.id, v_today) sc limit 1) sc on true
  cross join lateral (
    select dl deadline,
           case when o.clock_in is null then 'off' when now() <= dl then 'on' else 'unclosed' end state
    from (select case
            when o.clock_in is null then null
            when sc.shift_end is not null and extract(dow from v_today)::smallint = any (sc.working_days) then
              ((v_today + sc.shift_end)::timestamp
                 + case when sc.shift_start is not null and sc.shift_end <= sc.shift_start then interval '1 day' else interval '0' end)
                 at time zone 'Asia/Kuwait' + interval '60 minutes'
            else o.clock_in + interval '10 hours'
          end dl) z) d
  where e.status = 'Active';

  return jsonb_build_object(
    'settings', jsonb_build_object('boutique_threshold_kd', v_set.boutique_threshold_kd,
      'promote_after_days', v_set.promote_after_days, 'free_after_days', v_set.free_after_days,
      'boutique_colours', v_set.boutique_colours, 'updated_at', v_set.updated_at, 'updated_by', v_set.updated_by_name),
    'slots', v_slots, 'places', v_places, 'featured', v_featured, 'suggestions', v_suggest,
    'history', jsonb_build_object('first_day', v_first, 'last_day', v_last, 'days', v_days),
    'sold', jsonb_build_object('day', v_d, 'by_brand', v_sold, 'days_30_by_brand', v_sold30),
    'staff', v_staff,
    'generated_at', now());
end $$;

revoke all on function public.world_mall() from public, anon, service_role;
grant execute on function public.world_mall() to authenticated;
