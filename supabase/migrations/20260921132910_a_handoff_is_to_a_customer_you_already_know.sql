-- A handoff is to a customer you already know.
--
-- Found in validation: a handoff could be logged against any customer id at
-- all, and since a handoff is a relationship source, that was a way to grant
-- yourself a customer. It is not a first interaction; the visit or the sale
-- is. So a handoff may only be recorded for a customer the attributed
-- salesperson already has a relationship with — or by a manager in scope, or
-- an admin.
--
-- The shared device cannot see customers at all, so it cannot insert a row
-- that the policy would then need to read back. It goes through
-- log_whatsapp_handoff(), which checks the selected salesperson's
-- relationship and writes on their behalf. Personal logins may use it too.

drop policy if exists "handoffs_insert" on public.whatsapp_handoffs;
create policy "handoffs_insert" on public.whatsapp_handoffs for insert to authenticated
  with check (
    (select public.get_my_role()) in ('admin', 'manager', 'sales')
    and customer_id in (select id from public.customers)   -- visible to me, by the customers policy
  );

create or replace function public.log_whatsapp_handoff(
  p_customer uuid, p_template text, p_lang text, p_employee uuid default null, p_case uuid default null)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare who uuid; ok boolean; id bigint;
begin
  who := public.attributed_employee(p_employee);
  ok := public.get_my_role() = 'admin'
     or (public.get_my_role() = 'manager' and public.customer_in_my_scope(p_customer))
     or exists (select 1 from public.customer_relationships r where r.customer_id = p_customer and r.employee_id = who);
  if not ok then
    raise exception 'No relationship with this customer yet. Log the visit first; a message is not a first contact.'
      using errcode = 'insufficient_privilege';
  end if;
  insert into public.whatsapp_handoffs (employee_id, customer_id, template_key, lang, case_id)
  values (who, p_customer, p_template, p_lang, p_case)
  returning whatsapp_handoffs.id into id;
  return id;
end $$;
grant execute on function public.log_whatsapp_handoff(uuid, text, text, uuid, uuid) to authenticated;

-- The same door for outlet changes on the shared device, for symmetry with
-- the screen that will call it.
create or replace function public.log_outlet_change(p_to_outlet text, p_from_outlet text default null, p_employee uuid default null)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare id bigint;
begin
  insert into public.outlet_changes (employee_id, from_outlet, to_outlet)
  values (public.attributed_employee(p_employee), p_from_outlet, p_to_outlet)
  returning outlet_changes.id into id;
  return id;
end $$;
grant execute on function public.log_outlet_change(text, text, uuid) to authenticated;
