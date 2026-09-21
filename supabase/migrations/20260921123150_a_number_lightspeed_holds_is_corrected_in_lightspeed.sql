-- A number Lightspeed holds is corrected in Lightspeed.
--
-- Found in validation: a salesperson corrected the number on a customer whose
-- only link to them was a Lightspeed sale matched by that number. The match
-- broke, the relationship recomputed to nothing, and the customer vanished
-- from their CRM the moment they saved — while the next sync would have
-- created a fresh record for the old number anyway. For a customer the till
-- knows, the till is where the number is right or wrong. A customer who
-- exists only from shop-floor entries can still be corrected here.
create or replace function public.customers_guard_identity()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare e text; other uuid;
begin
  e := public.normalize_phone(new.contact);
  if e is null then
    raise exception 'Not a phone number we can match on: %', new.contact using errcode = 'check_violation';
  end if;
  new.contact := case when e like '+965%' then substr(e, 5) else e end;

  if tg_op = 'UPDATE' and e is distinct from old.phone_e164 then
    if exists (select 1 from public.lightspeed_customers lc where lc.phone_e164 = old.phone_e164 and lc.ls_deleted_at is null) then
      raise exception 'This customer''s number (%) is held in Lightspeed. Correct it there; it syncs within ten minutes.', old.contact
        using errcode = 'check_violation';
    end if;
    select id into other from public.customers where phone_e164 = e and id <> new.id limit 1;
    if other is not null then
      raise exception 'That number already belongs to another customer (%). Merging customers is a manager action, not a phone edit.', other
        using errcode = 'unique_violation';
    end if;
    insert into public.customer_contact_changes (customer_id, old_contact, new_contact, old_e164, new_e164, changed_by)
    values (new.id, old.contact, new.contact, old.phone_e164, e, auth.uid());
  end if;

  if tg_op = 'UPDATE' and new.responsible_employee_id is distinct from old.responsible_employee_id then
    if public.get_my_role() not in ('admin', 'manager') and auth.uid() is not null then
      raise exception 'Only a manager or admin can assign a responsible salesperson' using errcode = 'insufficient_privilege';
    end if;
    new.responsible_assigned_by := auth.uid();
    new.responsible_assigned_at := case when new.responsible_employee_id is null then null else now() end;
  end if;
  return new;
end $$;
