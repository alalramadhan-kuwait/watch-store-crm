-- Time Keeper World, the Watch Mall: world_mall_act(), the owners' changes (part 3 of 4; see 20261010060135).
-- Featuring is a switch: un-featuring keeps the row and the record of who featured it.

alter table world.mall_featured add column if not exists active boolean not null default true;

create or replace function public.world_mall_act(p_action text, p_args jsonb default '{}'::jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public, world as $$
declare
  v_user uuid := auth.uid();
  v_name text;
  v_args jsonb := coalesce(p_args, '{}'::jsonb);
  v_brand text := nullif(trim(coalesce(v_args ->> 'brand', '')), '');
  v_on boolean;
  v_old jsonb;
  v_n integer := 0;
  m jsonb;
  v_slot world.mall_slots;
  v_pos integer;
  v_threshold numeric; v_promote integer; v_free integer;
begin
  perform world_guard();
  if v_user is null or not stock_ai_allowed() then
    raise exception 'Only an owner can change the mall.' using errcode = '42501';
  end if;
  select coalesce(nullif(trim(full_name), ''), 'Owner') into v_name from profiles where id = v_user;
  v_name := coalesce(v_name, 'Owner');

  if p_action in ('feature', 'colour') and (v_brand is null or not (
       exists (select 1 from world.mall_places where brand = v_brand)
       or exists (select 1 from world.brand_value_daily where brand = v_brand))) then
    raise exception 'No brand called "%" in the mall.', coalesce(v_brand, '') using errcode = '22023';
  end if;

  if p_action = 'feature' then
    v_on := coalesce((v_args ->> 'on')::boolean, true);
    if v_on then
      insert into world.mall_featured (brand, featured_by, featured_by_name, active) values (v_brand, v_user, v_name, true)
      on conflict (brand) do update set active = true, featured_at = now(), featured_by = excluded.featured_by,
        featured_by_name = excluded.featured_by_name
      where not world.mall_featured.active;
    else
      update world.mall_featured set active = false where brand = v_brand and active;
    end if;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      insert into world.mall_events (kind, brand, actor, actor_name)
      values (case when v_on then 'feature' else 'unfeature' end, v_brand, v_user, v_name);
    end if;

  elsif p_action = 'settings' then
    select to_jsonb(s) - 'id' - 'boutique_colours' into v_old from world.mall_settings s where s.id;
    v_threshold := coalesce((v_args ->> 'boutique_threshold_kd')::numeric, (v_old ->> 'boutique_threshold_kd')::numeric);
    v_promote := coalesce((v_args ->> 'promote_after_days')::integer, (v_old ->> 'promote_after_days')::integer);
    v_free := coalesce((v_args ->> 'free_after_days')::integer, (v_old ->> 'free_after_days')::integer);
    if v_threshold <= 0 or v_threshold > 10000000 or v_promote not between 1 and 365 or v_free not between 1 and 730 then
      raise exception 'The threshold must be above zero, and the days between 1 and 365 (boutique) or 730 (empty kiosk).' using errcode = '22023';
    end if;
    update world.mall_settings set boutique_threshold_kd = v_threshold, promote_after_days = v_promote,
      free_after_days = v_free, updated_at = now(), updated_by = v_user, updated_by_name = v_name
    where id;
    insert into world.mall_events (kind, detail, actor, actor_name)
    values ('settings', jsonb_build_object('from', v_old - 'updated_at' - 'updated_by' - 'updated_by_name',
            'to', jsonb_build_object('boutique_threshold_kd', v_threshold, 'promote_after_days', v_promote, 'free_after_days', v_free)),
            v_user, v_name);
    v_n := 1;

  elsif p_action = 'colour' then
    if v_args ? 'colour' and v_args ->> 'colour' is not null and (v_args ->> 'colour') !~ '^#[0-9a-fA-F]{6}$' then
      raise exception 'A colour is written like #1F3A5C.' using errcode = '22023';
    end if;
    update world.mall_settings
       set boutique_colours = case when v_args ->> 'colour' is null then boutique_colours - v_brand
                                   else boutique_colours || jsonb_build_object(v_brand, lower(v_args ->> 'colour')) end,
           updated_at = now(), updated_by = v_user, updated_by_name = v_name
     where id;
    insert into world.mall_events (kind, brand, detail, actor, actor_name)
    values ('colour', v_brand, jsonb_build_object('colour', v_args ->> 'colour'), v_user, v_name);
    v_n := 1;

  elsif p_action = 'look' then
    if (v_args ->> 'look') not in ('neutral', 'man', 'woman', 'woman_hijab') then
      raise exception 'A look is neutral, man, woman or woman_hijab.' using errcode = '22023';
    end if;
    if not exists (select 1 from employees where id = (v_args ->> 'employee_id')::uuid and status = 'Active') then
      raise exception 'No active employee with that id.' using errcode = '22023';
    end if;
    insert into world.character_looks (employee_id, look, set_by, set_by_name)
    values ((v_args ->> 'employee_id')::uuid, v_args ->> 'look', v_user, v_name)
    on conflict (employee_id) do update set look = excluded.look, set_at = now(), set_by = excluded.set_by, set_by_name = excluded.set_by_name;
    insert into world.mall_events (kind, detail, actor, actor_name)
    values ('look', jsonb_build_object('employee_id', v_args ->> 'employee_id', 'look', v_args ->> 'look'), v_user, v_name);
    v_n := 1;

  elsif p_action = 'move' then
    if jsonb_typeof(v_args -> 'moves') <> 'array' or jsonb_array_length(v_args -> 'moves') = 0
       or jsonb_array_length(v_args -> 'moves') > 12 then
      raise exception 'Send between 1 and 12 moves.' using errcode = '22023';
    end if;
    for m in select * from jsonb_array_elements(v_args -> 'moves') loop
      v_brand := nullif(trim(coalesce(m ->> 'brand', '')), '');
      select * into v_slot from world.mall_slots where slot = m ->> 'slot';
      v_pos := coalesce((m ->> 'position')::integer, 0);
      if v_slot.slot is null then
        raise exception 'There is no place "%".', coalesce(m ->> 'slot', '') using errcode = '22023';
      end if;
      if v_pos < 0 or v_pos >= v_slot.capacity then
        raise exception 'Place % holds % brand(s).', v_slot.slot, v_slot.capacity using errcode = '22023';
      end if;
      if v_brand is null or not (exists (select 1 from world.mall_places where brand = v_brand)
                                 or exists (select 1 from world.brand_value_daily where brand = v_brand)) then
        raise exception 'No brand called "%" in the mall.', coalesce(v_brand, '') using errcode = '22023';
      end if;
      select jsonb_build_object('slot', slot, 'position', position) into v_old from world.mall_places where brand = v_brand;
      insert into world.mall_places (brand, slot, position, how, placed_by, placed_by_name)
      values (v_brand, v_slot.slot, v_pos, 'owner', v_user, v_name)
      on conflict (brand) do update set slot = excluded.slot, position = excluded.position, how = 'owner',
        placed_at = now(), placed_by = excluded.placed_by, placed_by_name = excluded.placed_by_name;
      insert into world.mall_events (kind, brand, detail, actor, actor_name)
      values ('place', v_brand, jsonb_build_object('from', v_old, 'to', jsonb_build_object('slot', v_slot.slot, 'position', v_pos),
              'reason', nullif(trim(coalesce(v_args ->> 'reason', '')), '')), v_user, v_name);
      v_n := v_n + 1;
    end loop;
    set constraints world.mall_places_one_per_place immediate;

  else
    raise exception 'Unknown action "%".', coalesce(p_action, '') using errcode = '22023';
  end if;

  return jsonb_build_object('ok', true, 'action', p_action, 'changed', v_n);
end $$;

revoke all on function public.world_mall_act(text, jsonb) from public, anon, service_role;
grant execute on function public.world_mall_act(text, jsonb) to authenticated;
