-- Time Keeper World, the Watch Mall: The Promenade, and a boutique for every brand over 5,000 KD at cost.
--
-- Owner request (16 Oct 2026): every brand with more than 5,000 KD of stock at cost gets a boutique.
-- Thirteen brands qualify: the seven with boutiques already, and Beda’a, Wolf, Baltic, Citizen, Raketa
-- and Seven Friday, which stand on the Grand Gallery's walkway islands (GG-I1, GG-I2).
--
-- 1. A fourth section, The Promenade ('promenade'), at the mall's west end: six boutiques
--    (PR-N1..N3 on the back row, PR-S1..S3 on the front row) and two spare walkway islands
--    (PR-I1, PR-I2). The app draws it west of the Grand Gallery (src/world/mall/layout.ts), so no
--    existing place moves on screen. The slot table's section check is widened to allow it: the
--    only way to change a check constraint is to drop and add it again, done here in one statement
--    with the old three values kept (no row is touched by it).
-- 2. The boutique threshold goes from 9,000 to 5,000 KD, recorded as a 'settings' event like
--    world_mall_act() records one.
-- 3. The six brands move into the six new boutiques, the most valuable (latest
--    world.brand_value_daily) to the first place by ord, each recorded as a 'place' event with the
--    reason. Nobody else moves; Unimatic and WMT keep their kiosks on GG-I2.
--
-- No function names the sections: world.mall_seed, world.mall_free_kiosk, world_mall() and
-- world_mall_act() read world.mall_slots, so they need no change. New islands are spare, so
-- mall_free_kiosk() offers them to a new brand only after every other free kiosk, as it does the
-- other spare islands.
--
-- Safe to run twice: slots are inserted only if missing, the threshold is changed (and logged) only
-- if it is not 5,000 already, and a brand is moved only if it is not in a Promenade boutique yet and
-- its new place is empty.

alter table world.mall_slots
  drop constraint if exists mall_slots_section_check,
  add constraint mall_slots_section_check
    check (section = any (array['promenade', 'grand_gallery', 'collectors_arcade', 'discovery_court']));

insert into world.mall_slots (slot, section, kind, capacity, spare, ord) values
  ('PR-N1', 'promenade', 'boutique', 1, false, 41),
  ('PR-N2', 'promenade', 'boutique', 1, false, 42),
  ('PR-N3', 'promenade', 'boutique', 1, false, 43),
  ('PR-S1', 'promenade', 'boutique', 1, false, 44),
  ('PR-S2', 'promenade', 'boutique', 1, false, 45),
  ('PR-S3', 'promenade', 'boutique', 1, false, 46),
  ('PR-I1', 'promenade', 'island',   4, true,  47),
  ('PR-I2', 'promenade', 'island',   4, true,  48)
on conflict (slot) do nothing;

do $$
declare
  v_old jsonb;
  v_from jsonb;
  r record;
begin
  -- the threshold, logged as world_mall_act('settings') logs it
  select to_jsonb(s) - 'id' - 'boutique_colours' into v_old from world.mall_settings s where s.id;
  if (v_old ->> 'boutique_threshold_kd')::numeric <> 5000 then
    update world.mall_settings
       set boutique_threshold_kd = 5000, updated_at = now(), updated_by = null, updated_by_name = 'Owner request'
     where id;
    insert into world.mall_events (kind, detail, actor, actor_name)
    values ('settings', jsonb_build_object(
              'from', v_old - 'updated_at' - 'updated_by' - 'updated_by_name',
              'to', jsonb_build_object('boutique_threshold_kd', 5000,
                                       'promote_after_days', (v_old ->> 'promote_after_days')::integer,
                                       'free_after_days', (v_old ->> 'free_after_days')::integer),
              'reason', 'every brand over 5,000 KD at cost gets a boutique'),
            null, 'Owner request');
  end if;

  -- the six brands, most valuable first, into the Promenade's boutiques in order
  for r in
    with v as (
      select b.brand,
             coalesce((select d.cost_value from world.brand_value_daily d
                        where d.brand = b.brand order by d.day desc limit 1), 0) as cost
      from unnest(array['Beda’a', 'Wolf', 'Baltic', 'Citizen', 'Raketa', 'Seven Friday']) b(brand)
    ),
    ranked as (select brand, cost, row_number() over (order by cost desc, brand) as rk from v),
    slots as (
      select slot, row_number() over (order by ord) as rk
      from world.mall_slots where section = 'promenade' and kind = 'boutique'
    )
    select ranked.brand, ranked.cost, slots.slot
    from ranked join slots using (rk)
    where not exists (select 1 from world.mall_places p
                       join world.mall_slots s on s.slot = p.slot
                      where p.brand = ranked.brand and s.section = 'promenade' and s.kind = 'boutique')
      and not exists (select 1 from world.mall_places p where p.slot = slots.slot)
    order by rk
  loop
    select jsonb_build_object('slot', slot, 'position', position) into v_from
      from world.mall_places where brand = r.brand;
    insert into world.mall_places (brand, slot, position, how, placed_by, placed_by_name)
    values (r.brand, r.slot, 0, 'owner', null, 'Owner request')
    on conflict (brand) do update set slot = excluded.slot, position = excluded.position, how = 'owner',
      placed_at = now(), placed_by = excluded.placed_by, placed_by_name = excluded.placed_by_name;
    insert into world.mall_events (kind, brand, detail, actor, actor_name)
    values ('place', r.brand, jsonb_build_object('from', v_from, 'to', jsonb_build_object('slot', r.slot, 'position', 0),
                                                 'reason', 'over 5,000 KD at cost', 'cost_kd', r.cost),
            null, 'Owner request');
  end loop;
end $$;

set constraints world.mall_places_one_per_place immediate;
