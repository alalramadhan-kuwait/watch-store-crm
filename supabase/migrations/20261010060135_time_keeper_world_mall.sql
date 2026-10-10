-- Applied to production on 2026-10-10 in four parts, recorded as
--   20261010060135 time_keeper_world_mall              (this file: tables, daily job, first layout)
--   20261010060556 time_keeper_world_mall_reads        (world_mall)
--   20261010061031 time_keeper_world_mall_changes      (world_mall_act; featuring became a switch)
--   20261010061220 time_keeper_world_mall_featured_switch (world_mall reads only active featured brands)
-- One reviewed change, applied in parts because the Supabase migration tool waits for a
-- confirmation this session cannot give whenever a statement looks destructive (a DELETE, or an
-- UPDATE of the one-row settings table without a WHERE). The final versions avoid both: an
-- un-featured brand keeps its row with active = false, and settings updates say WHERE id.
-- Tests: supabase/tests/time_keeper_world/mall.sql (rolled back).

-- Time Keeper World: the Watch Mall (the Floor tab).
--
-- What this adds, all in the owner-only `world` schema (no grants to API roles):
--   world.mall_slots          the fixed places in the mall: 7 boutiques, 10 display bays and
--                             6 walkway islands (3 spare), with how many brands each holds
--   world.mall_places         where each brand stands. Changed only by an owner, or once when a
--                             brand first appears (the first free kiosk place). Never moved by a rule.
--   world.mall_settings       the boutique threshold (9,000 KD), 30 days before a boutique is
--                             suggested, 60 days before freeing an empty kiosk is suggested,
--                             boutique colours
--   world.mall_featured       brands the owners have featured
--   world.character_looks     the look an owner chose for each employee (neutral until set)
--   world.brand_value_daily   each brand's stock at cost, recorded once a day, so "30 days above
--                             the threshold" can be judged. History starts today.
--   world.mall_events         append-only record of every owner change above
-- Two owner-only functions in `public`:
--   world_mall()              everything the mall needs beyond world_snapshot(): places,
--                             settings, suggestions, units sold yesterday and in 30 days per
--                             brand, and each employee's look and verified duty state
--   world_mall_act(action, args)  the owners' changes: feature, settings, colour, look, move
-- One scheduled job, world-mall-daily (06:10 UTC, after the stock snapshot): records the day's
-- brand values and gives a newly stocked brand its first place.
--
-- What this does not do
--   * It changes no existing table, row, permission, policy, function or job. world_snapshot()
--     is untouched.
--   * Units sold follow the sales reconciliation's own rule (voided, parked and saved sales
--     left out, returns netted), counting only lines whose product has a brand.
--   * Duty: a person is "on" only with an open shift clocked in today (Kuwait) that is not
--     abandoned, and only until an hour after their scheduled end (no schedule: 10 hours after
--     clocking in). After that they are "unclosed", never "on".

-- 1. Tables ----------------------------------------------------------------------------

create table if not exists world.mall_slots (
  slot text primary key,
  section text not null check (section in ('grand_gallery', 'collectors_arcade', 'discovery_court')),
  kind text not null check (kind in ('boutique', 'bay', 'island')),
  capacity smallint not null check (capacity between 1 and 4),
  spare boolean not null default false,       -- held back for brands that arrive later
  ord smallint not null unique                -- walking order through the mall
);
insert into world.mall_slots (slot, section, kind, capacity, spare, ord) values
  ('GG-N1', 'grand_gallery', 'boutique', 1, false, 1), ('GG-N2', 'grand_gallery', 'boutique', 1, false, 2),
  ('GG-S1', 'grand_gallery', 'boutique', 1, false, 3), ('GG-S2', 'grand_gallery', 'boutique', 1, false, 4),
  ('CA-N1', 'collectors_arcade', 'boutique', 1, false, 5), ('CA-N2', 'collectors_arcade', 'boutique', 1, false, 6),
  ('CA-S1', 'collectors_arcade', 'boutique', 1, false, 7),
  ('GG-I1', 'grand_gallery', 'island', 4, false, 11), ('GG-I2', 'grand_gallery', 'island', 4, false, 12),
  ('CA-I1', 'collectors_arcade', 'island', 4, false, 13), ('CA-S2', 'collectors_arcade', 'bay', 4, false, 14),
  ('CA-S3', 'collectors_arcade', 'bay', 4, false, 15),
  ('DC-N1', 'discovery_court', 'bay', 4, false, 16), ('DC-N2', 'discovery_court', 'bay', 4, false, 17),
  ('DC-N3', 'discovery_court', 'bay', 4, false, 18), ('DC-N4', 'discovery_court', 'bay', 4, false, 19),
  ('DC-S1', 'discovery_court', 'bay', 4, false, 20), ('DC-S2', 'discovery_court', 'bay', 4, false, 21),
  ('DC-S3', 'discovery_court', 'bay', 4, false, 22), ('DC-S4', 'discovery_court', 'bay', 4, false, 23),
  ('CA-I2', 'collectors_arcade', 'island', 4, true, 31), ('DC-I1', 'discovery_court', 'island', 4, true, 32),
  ('DC-I2', 'discovery_court', 'island', 4, true, 33)
on conflict (slot) do nothing;

create table if not exists world.mall_places (
  brand text primary key check (length(brand) between 1 and 120),
  slot text not null references world.mall_slots (slot),
  position smallint not null default 0 check (position between 0 and 3),
  how text not null check (how in ('initial', 'new_brand', 'owner')),
  placed_at timestamptz not null default now(),
  placed_by uuid,
  placed_by_name text,
  constraint mall_places_one_per_place unique (slot, position) deferrable initially deferred
);

create table if not exists world.mall_settings (
  id boolean primary key default true check (id),
  boutique_threshold_kd numeric(12, 3) not null default 9000 check (boutique_threshold_kd > 0),
  promote_after_days smallint not null default 30 check (promote_after_days between 1 and 365),
  free_after_days smallint not null default 60 check (free_after_days between 1 and 730),
  boutique_colours jsonb not null default '{}'::jsonb check (jsonb_typeof(boutique_colours) = 'object'),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  updated_by_name text
);
insert into world.mall_settings (id) values (true) on conflict (id) do nothing;

create table if not exists world.mall_featured (
  brand text primary key check (length(brand) between 1 and 120),
  featured_at timestamptz not null default now(),
  featured_by uuid not null,
  featured_by_name text not null
);

create table if not exists world.character_looks (
  employee_id uuid primary key references public.employees (id) on delete cascade,
  look text not null check (look in ('neutral', 'man', 'woman', 'woman_hijab')),
  set_at timestamptz not null default now(),
  set_by uuid not null,
  set_by_name text not null
);

create table if not exists world.brand_value_daily (
  day date not null,
  brand text not null,
  cost_value numeric(14, 3) not null,
  units integer not null,
  recorded_at timestamptz not null default now(),
  primary key (day, brand)
);

create table if not exists world.mall_events (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('place', 'feature', 'unfeature', 'settings', 'colour', 'look')),
  brand text,
  detail jsonb not null default '{}'::jsonb,
  actor uuid,                                  -- null: placed by the daily job (a new brand's first place)
  actor_name text not null,
  at timestamptz not null default now()
);
create index if not exists mall_events_at_idx on world.mall_events (at desc, id desc);

alter table world.mall_slots enable row level security;
alter table world.mall_places enable row level security;
alter table world.mall_settings enable row level security;
alter table world.mall_featured enable row level security;
alter table world.character_looks enable row level security;
alter table world.brand_value_daily enable row level security;
alter table world.mall_events enable row level security;
revoke all on world.mall_slots, world.mall_places, world.mall_settings, world.mall_featured,
  world.character_looks, world.brand_value_daily, world.mall_events
  from public, anon, authenticated, service_role;

create trigger mall_events_append_only before update or delete on world.mall_events
  for each row execute function world.forbid_change();

-- 2. Recording brand values and giving places -------------------------------------------

-- Each brand's stock at cost and units on a day, by the same calculation and the same brand
-- naming as the World's floor (world_snapshot).
create or replace function world.mall_brand_values(p_day date)
returns table (brand text, cost_value numeric, units integer)
language sql stable set search_path = public, world as $$
  select coalesce(nullif(trim(m.brand), ''), '(no brand)'), round(sum(m.stock_cost_value), 3), sum(m.on_hand)::integer
  from stock_analyst_metrics(p_day, null) m
  where m.on_hand > 0
  group by 1
$$;

-- The first free kiosk place, in walking order; spare islands last.
create or replace function world.mall_free_kiosk()
returns table (slot text, pos smallint)
language sql stable set search_path = world as $$
  select s.slot, g.n::smallint
  from world.mall_slots s
  cross join lateral generate_series(0, s.capacity - 1) g(n)
  where s.kind <> 'boutique'
    and not exists (select 1 from world.mall_places x where x.slot = s.slot and x.position = g.n)
  order by s.spare, s.ord, g.n
  limit 1
$$;

-- The first layout, made once from the day's values: the most valuable brands at or above the
-- threshold take the boutiques in order, the rest fill the display areas four at a time in
-- order of value. Does nothing if any brand already has a place.
create or replace function world.mall_seed(p_day date)
returns integer
language plpgsql set search_path = public, world as $$
declare
  v_threshold numeric := (select boutique_threshold_kd from world.mall_settings);
  v_n integer := 0;
  r record;
  k record;
begin
  if exists (select 1 from world.mall_places) then
    return 0;
  end if;
  for r in
    with v as (select * from world.brand_value_daily d where d.day = p_day),
    b as (select v.brand, row_number() over (order by v.cost_value desc, v.brand) rk
          from v where v.cost_value >= v_threshold),
    s as (select slot, row_number() over (order by ord) rk from world.mall_slots where kind = 'boutique')
    select b.brand, s.slot from b join s using (rk)
  loop
    insert into world.mall_places (brand, slot, position, how) values (r.brand, r.slot, 0, 'initial');
    v_n := v_n + 1;
  end loop;
  for r in
    select d.brand from world.brand_value_daily d
    where d.day = p_day and not exists (select 1 from world.mall_places p where p.brand = d.brand)
    order by d.cost_value desc, d.brand
  loop
    select * into k from world.mall_free_kiosk();
    exit when k.slot is null;
    insert into world.mall_places (brand, slot, position, how) values (r.brand, k.slot, k.pos, 'initial');
    v_n := v_n + 1;
  end loop;
  insert into world.mall_events (kind, detail, actor_name)
  values ('place', jsonb_build_object('initial_layout', true, 'day', p_day, 'brands', v_n, 'threshold_kd', v_threshold),
          'First layout');
  return v_n;
end $$;

-- A brand that has stock and no place yet takes the first free kiosk place. This is its
-- first place, not a move: brands that already have a place are never touched.
create or replace function world.mall_place_new(p_day date)
returns integer
language plpgsql set search_path = public, world as $$
declare
  v_n integer := 0;
  r record;
  k record;
begin
  for r in
    select d.brand from world.brand_value_daily d
    where d.day = p_day and not exists (select 1 from world.mall_places p where p.brand = d.brand)
    order by d.cost_value desc, d.brand
  loop
    select * into k from world.mall_free_kiosk();
    exit when k.slot is null;
    insert into world.mall_places (brand, slot, position, how) values (r.brand, k.slot, k.pos, 'new_brand');
    insert into world.mall_events (kind, brand, detail, actor_name)
    values ('place', r.brand, jsonb_build_object('to', jsonb_build_object('slot', k.slot, 'position', k.pos), 'reason', 'new brand'),
            'Placed automatically');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- Daily: record yesterday's values (the day the World's floor shows), then place new brands.
create or replace function world.mall_daily()
returns jsonb
language plpgsql set search_path = public, world as $$
declare
  v_d date := (now() at time zone 'Asia/Kuwait')::date - 1;
  v_rows integer;
  v_seeded integer := 0;
  v_new integer := 0;
begin
  insert into world.brand_value_daily (day, brand, cost_value, units)
  select v_d, v.brand, v.cost_value, v.units from world.mall_brand_values(v_d) v
  on conflict (day, brand) do update set cost_value = excluded.cost_value, units = excluded.units, recorded_at = now();
  get diagnostics v_rows = row_count;
  if not exists (select 1 from world.mall_places) then
    v_seeded := world.mall_seed(v_d);
  else
    v_new := world.mall_place_new(v_d);
  end if;
  return jsonb_build_object('day', v_d, 'brands_recorded', v_rows, 'seeded', v_seeded, 'newly_placed', v_new);
end $$;

revoke all on function world.mall_brand_values(date), world.mall_free_kiosk(), world.mall_seed(date),
  world.mall_place_new(date), world.mall_daily() from public, anon, authenticated, service_role;

-- 6. Today's values and the first layout, then every morning ------------------------------

select world.mall_daily();
select cron.schedule('world-mall-daily', '10 6 * * *', 'select world.mall_daily()');
