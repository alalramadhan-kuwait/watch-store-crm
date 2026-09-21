-- A number typed at the counter.
--
-- Stage C2. While a salesperson types a customer's number, the form asks
-- whether we know it. The answer is shaped by the Stage B rule: a customer
-- of yours comes back with a name and a line of history; a customer who is
-- somebody else's comes back as "recognised" and nothing more, until the
-- visit is saved and the relationship exists. The shared device only ever
-- hears "recognised".
create or replace function public.customer_by_phone(p_phone text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare e text; cu record; mine boolean; visits int; last_buy date; last_visit date; open_fu int;
begin
  e := public.normalize_phone(p_phone);
  if e is null then return jsonb_build_object('valid', false, 'known', false); end if;
  select * into cu from public.customers where phone_e164 = e;
  if cu.id is null then return jsonb_build_object('valid', true, 'e164', e, 'known', false); end if;

  mine := public.get_my_role() = 'admin'
       or (public.get_my_role() = 'manager' and public.customer_in_my_scope(cu.id))
       or exists (select 1 from public.customer_relationships r where r.customer_id = cu.id and r.employee_id = public.my_employee_id());
  if not mine then return jsonb_build_object('valid', true, 'e164', e, 'known', true, 'mine', false); end if;

  select count(*), max(public.kuwait_day_of(interaction_at)), count(*) filter (where case_type = 'Follow-up' and status = 'Open')
    into visits, last_visit, open_fu
    from public.cases where customer_id = cu.id and deleted = false;
  select max(s.sale_day) into last_buy
    from public.lightspeed_sales s join public.lightspeed_customers lc on lc.id = s.customer_id
   where lc.phone_e164 = e and s.status !~ 'VOID';
  return jsonb_build_object(
    'valid', true, 'e164', e, 'known', true, 'mine', true,
    'customer_id', cu.id, 'name', cu.display_name, 'visits', visits,
    'last_visit', last_visit, 'last_purchase', last_buy, 'open_followups', open_fu,
    'birthday', cu.birthday);
end $$;
grant execute on function public.customer_by_phone(text) to authenticated;

-- What today's till shows for the outlet a phone is standing in. The Stage B
-- policy on lightspeed_sales already decides what the caller may count: a
-- manager their outlets, a salesperson the sales credited to them.
create or replace function public.lightspeed_today(p_outlet text default null)
returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'sales', count(*),
    'revenue', round(coalesce(sum(s.total_price_incl), 0), 3),
    'scope', public.resolve_outlet(p_outlet),
    'as_of', (select max(last_success_at) from public.lightspeed_sync_state where kind = 'sales'))
    from public.lightspeed_sales s
   where s.sale_day = public.kuwait_today()
     and s.status !~ 'VOID|SAVED|PARKED|AWAITING'
     and (p_outlet is null or s.scope_code = public.resolve_outlet(p_outlet))
$$;
grant execute on function public.lightspeed_today(text) to authenticated;