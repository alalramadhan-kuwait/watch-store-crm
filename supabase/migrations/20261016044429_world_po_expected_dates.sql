-- Time Keeper World: an expected-arrival date the owners set on a purchase order.
--
-- purchase_orders.expected_arrival is Lightspeed's due date and the PO sync rewrites it, so
-- the owners' own date lives apart from it and nothing the sync does touches it. One current
-- date per order (world.po_expected), and every set or clear kept in an append-only log
-- (world.po_expected_events), like the World's other logs. Read and written only through two
-- owner-only functions behind world_guard(); the tables stay closed to clients.

create table if not exists world.po_expected (
  po_id uuid primary key references public.purchase_orders(id) on delete cascade,
  expected_on date not null,
  note text,
  set_by uuid,
  set_by_name text not null,
  set_at timestamptz not null default now()
);

create table if not exists world.po_expected_events (
  id bigint generated always as identity primary key,
  po_id uuid not null,
  expected_on date,              -- null: the date was cleared
  note text,
  actor uuid,
  actor_name text not null,
  at timestamptz not null default now()
);
create index if not exists po_expected_events_po on world.po_expected_events (po_id, at desc);

create or replace trigger po_expected_events_append_only before update or delete on world.po_expected_events
  for each row execute function world.forbid_change();

revoke all on world.po_expected, world.po_expected_events from public, anon, authenticated, service_role;

create or replace function public.world_po_expected()
returns jsonb
language plpgsql
stable security definer
set search_path to 'public', 'world'
as $function$
begin
  perform world_guard();
  return (
    select coalesce(jsonb_object_agg(e.po_id, jsonb_build_object(
             'on', e.expected_on, 'note', e.note, 'by', e.set_by_name, 'at', e.set_at)), '{}'::jsonb)
    from world.po_expected e);
end $function$;

create or replace function public.world_po_expected_set(p_po_id uuid, p_expected_on date, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'world'
as $function$
declare
  v_user uuid := auth.uid();
  v_name text;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_today date := (now() at time zone 'Asia/Kuwait')::date;
begin
  perform world_guard();
  if v_user is null or not stock_ai_allowed() then
    raise exception 'Only an owner can set an expected date.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.purchase_orders where id = p_po_id) then
    raise exception 'No purchase order with that id.' using errcode = 'P0002';
  end if;
  if p_expected_on is not null and (p_expected_on < v_today - 365 or p_expected_on > v_today + 730) then
    raise exception 'Pick a date within a year back and two years ahead.' using errcode = '22023';
  end if;
  if length(coalesce(v_note, '')) > 300 then
    raise exception 'Keep the note under 300 characters.' using errcode = '22023';
  end if;
  select coalesce(nullif(trim(full_name), ''), 'Owner') into v_name from profiles where id = v_user;
  v_name := coalesce(v_name, 'Owner');

  if p_expected_on is null then
    delete from world.po_expected where po_id = p_po_id;
  else
    insert into world.po_expected (po_id, expected_on, note, set_by, set_by_name, set_at)
    values (p_po_id, p_expected_on, v_note, v_user, v_name, now())
    on conflict (po_id) do update set expected_on = excluded.expected_on, note = excluded.note,
      set_by = excluded.set_by, set_by_name = excluded.set_by_name, set_at = now();
  end if;
  insert into world.po_expected_events (po_id, expected_on, note, actor, actor_name)
  values (p_po_id, p_expected_on, v_note, v_user, v_name);
  return jsonb_build_object('ok', true, 'po_id', p_po_id, 'on', p_expected_on);
end $function$;

revoke all on function public.world_po_expected() from public, anon;
revoke all on function public.world_po_expected_set(uuid, date, text) from public, anon;
grant execute on function public.world_po_expected() to authenticated;
grant execute on function public.world_po_expected_set(uuid, date, text) to authenticated;

comment on function public.world_po_expected() is
  'Time Keeper World (owners only): the expected-arrival dates the owners set, by purchase order id.';
comment on function public.world_po_expected_set(uuid, date, text) is
  'Time Keeper World (owners only): set (or with a null date, clear) the owners'' expected-arrival date on a purchase order. Every change is logged in world.po_expected_events.';
