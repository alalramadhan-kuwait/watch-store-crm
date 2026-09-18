-- Foundation, part 1: one identity for every outlet, one schedule history,
-- one worked-hours answer.
--
-- Nothing here renames a historical record. Old spellings keep working because
-- the registry knows them as aliases; the resolver is the only place that has
-- to be taught a new one.

-- ── 1. Canonical outlets and channels ────────────────────────────────────────
-- Four places a sale can come from, plus the office. Two of them are shops you
-- can stand in; the other two are a website and a phone. Only a shop has
-- attendance, a geofence and an opening time.

create table if not exists public.outlets (
  code              text primary key,
  display_name      text not null,
  kind              text not null check (kind in ('physical', 'digital')),
  -- what this outlet takes part in
  sells             boolean not null default true,   -- sales and revenue reporting
  has_attendance    boolean not null default false,  -- staff clock in here
  has_geofence      boolean not null default false,
  tracks_store_day  boolean not null default false,  -- opens and closes
  -- how the other systems spell it
  geofence_name     text,
  pos_names         text[] not null default '{}',    -- lightspeed_sales_daily.outlet
  dsr_names         text[] not null default '{}',    -- cases.outlet, settings.outlets
  aliases           text[] not null default '{}',    -- every other spelling seen
  sort_order        int  not null default 0,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.outlets is
  'The one list of outlets and channels. resolve_outlet() maps any historical spelling to a code here; nothing else should compare outlet text directly.';
comment on column public.outlets.tracks_store_day is
  'Store open/close derives from attendance at this outlet. False for digital channels and for the office.';

insert into public.outlets
  (code, display_name, kind, sells, has_attendance, has_geofence, tracks_store_day,
   geofence_name, pos_names, dsr_names, aliases, sort_order)
values
  ('avenues', 'Time Keeper - Avenues', 'physical', true, true, true, true,
   'Avenues',
   array['Time Keeper - Avenues'],
   array['Avenues'],
   array['Avenues', 'The Avenues', 'TimeKeeper Avenues', 'Time Keeper Avenues', 'TK Avenues'],
   10),

  ('time_gallery', 'Time Gallery', 'physical', true, true, true, true,
   'Time Gallery',
   array['Time Gallery'],
   array['TimeGallery'],
   array['Time Gallery', 'TimeGallery', 'Gallery', 'Salhiya'],
   20),

  ('whatsapp', 'Time Keeper WhatsApp', 'digital', true, false, false, false,
   null,
   array['Time Keeper'],
   array['WhatsApp'],
   array['WhatsApp', 'Whats App', 'Time Keeper', 'TimeKeeper', 'WA'],
   30),

  ('online', 'Time Keeper Online', 'digital', true, false, false, false,
   null,
   array[]::text[],
   array[]::text[],
   array['Online', 'Time Keeper Online', 'Webshop', 'Web Shop', 'Website', 'E-commerce'],
   40),

  ('hq', 'Timekeeper HQ', 'physical', false, true, true, false,
   'Timekeeper HQ',
   array[]::text[],
   array[]::text[],
   array['Timekeeper HQ', 'Time Keeper HQ', 'HQ', 'Head Office', 'Office'],
   50)
on conflict (code) do nothing;

alter table public.outlets enable row level security;

drop policy if exists outlets_read on public.outlets;
create policy outlets_read on public.outlets for select to authenticated using (true);

drop policy if exists outlets_write on public.outlets;
create policy outlets_write on public.outlets for all to authenticated
  using (get_my_role() = any (array['admin', 'manager']))
  with check (get_my_role() = any (array['admin', 'manager']));

-- ── 2. The resolver ──────────────────────────────────────────────────────────
-- 'TimeGallery', 'Time Gallery' and 'time gallery' are the same shop. Compare
-- outlets through this, never with =.

create or replace function public.outlet_key(p text)
returns text
language sql immutable parallel safe
as $$
  select nullif(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]', '', 'g'), '')
$$;

comment on function public.outlet_key(text) is
  'Comparison key for outlet text: lowercase, letters and digits only.';

create or replace function public.resolve_outlet(p text)
returns text
language sql stable
set search_path to 'public', 'pg_temp'
as $$
  select o.code
    from public.outlets o
   where public.outlet_key(p) is not null
     and public.outlet_key(p) in (
       select public.outlet_key(x)
         from unnest(array[o.code, o.display_name] || o.pos_names || o.dsr_names || o.aliases) x
     )
   order by o.sort_order
   limit 1
$$;

comment on function public.resolve_outlet(text) is
  'Any historical outlet spelling to its canonical code, or null when unknown.';

-- ── 3. Schedule history ──────────────────────────────────────────────────────
-- A schedule that changes next month must not change what last month looked
-- like, so schedules are dated rather than overwritten.

create extension if not exists btree_gist;

create table if not exists public.employee_schedules (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.employees(id) on delete cascade,
  effective_from date not null,
  effective_to   date,                                        -- null = still in force
  working_days   smallint[] not null default '{0,1,2,3,4,6}', -- 0 = Sunday, Kuwait week is Sat-Thu
  shift_start    time,
  shift_end      time,
  note           text,
  created_at     timestamptz not null default now(),
  created_by     uuid,
  constraint employee_schedules_dates check (effective_to is null or effective_to >= effective_from)
);

comment on table public.employee_schedules is
  'When somebody is expected to work, by date range. Historical attendance is judged against the row covering that date, never against today''s.';

do $$
begin
  alter table public.employee_schedules
    add constraint employee_schedules_no_overlap
    exclude using gist (
      employee_id with =,
      daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
    );
exception when duplicate_table or duplicate_object then null;
end $$;

create index if not exists employee_schedules_employee_idx
  on public.employee_schedules (employee_id, effective_from desc);

alter table public.employee_schedules enable row level security;

drop policy if exists sched_write on public.employee_schedules;
create policy sched_write on public.employee_schedules for all to authenticated
  using (get_my_role() = any (array['admin', 'manager', 'hr']))
  with check (get_my_role() = any (array['admin', 'manager', 'hr']));

drop policy if exists sched_read on public.employee_schedules;
create policy sched_read on public.employee_schedules for select to authenticated
  using (
    get_my_role() = any (array['admin', 'manager', 'hr'])
    or employee_id in (select id from public.employees where user_id = auth.uid())
  );

-- Backfill: today's columns become each employee's first dated schedule, open
-- ended, starting the day they joined.
insert into public.employee_schedules (employee_id, effective_from, working_days, shift_start, shift_end, note)
select e.id,
       coalesce(e.joining_date, date '2020-01-01'),
       coalesce(e.expected_days, '{0,1,2,3,4,6}'::smallint[]),
       e.shift_start,
       e.shift_end,
       'Carried over from the employee record'
  from public.employees e
 where not exists (select 1 from public.employee_schedules s where s.employee_id = e.id);

create or replace function public.schedule_on(p_employee uuid, p_date date)
returns table (working_days smallint[], shift_start time, shift_end time, dated boolean)
language sql stable
set search_path to 'public', 'pg_temp'
as $$
  select s.working_days, s.shift_start, s.shift_end, true
    from public.employee_schedules s
   where s.employee_id = p_employee
     and p_date >= s.effective_from
     and (s.effective_to is null or p_date <= s.effective_to)
   order by s.effective_from desc
   limit 1
$$;

comment on function public.schedule_on(uuid, date) is
  'The schedule in force for an employee on a given date.';

-- Keep employees.expected_days / shift_start / shift_end mirroring the schedule
-- in force today, so anything still reading those columns stays right while the
-- callers are migrated.
create or replace function public.sync_employee_schedule_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  target uuid := coalesce(new.employee_id, old.employee_id);
begin
  update public.employees e
     set expected_days = s.working_days,
         shift_start   = s.shift_start,
         shift_end     = s.shift_end
    from (
      select working_days, shift_start, shift_end
        from public.employee_schedules
       where employee_id = target
         and effective_from <= current_date
         and (effective_to is null or effective_to >= current_date)
       order by effective_from desc
       limit 1
    ) s
   where e.id = target;
  return null;
end $$;

drop trigger if exists employee_schedules_sync on public.employee_schedules;
create trigger employee_schedules_sync
  after insert or update or delete on public.employee_schedules
  for each row execute function public.sync_employee_schedule_columns();

-- ── 4. Worked hours, once ────────────────────────────────────────────────────
-- A shift left open past this many hours was never clocked out. Its length is
-- unknown, not enormous: ten of the open shifts on the day this was written had
-- been running for more than a day, the oldest for six weeks.
create or replace function public.attendance_abandon_hours()
returns numeric language sql immutable parallel safe as $$ select 16::numeric $$;

comment on function public.attendance_abandon_hours() is
  'An open shift older than this is treated as a missed clock-out: hours unknown, needs a correction. Long enough to cover an overnight shift.';

create or replace view public.attendance_shifts
with (security_invoker = true) as
select
  a.id,
  a.user_id,
  e.id                                              as employee_id,
  a.employee_name,
  a.location,
  public.resolve_outlet(a.location)                 as outlet_code,
  (a.clock_in at time zone 'Asia/Kuwait')::date     as work_date,
  a.clock_in,
  a.clock_out,
  a.clock_out is null                               as is_open,
  a.clock_out is null
    and extract(epoch from (now() - a.clock_in)) / 3600.0 > public.attendance_abandon_hours()
                                                    as is_abandoned,
  a.clock_out is not null and a.clock_out <= a.clock_in
                                                    as is_invalid,
  case
    -- never clocked out: the length is not knowable, so do not invent one
    when a.clock_out is null
     and extract(epoch from (now() - a.clock_in)) / 3600.0 > public.attendance_abandon_hours()
      then null
    -- clocked out before clocking in: a broken record, not negative time
    when a.clock_out is not null and a.clock_out <= a.clock_in
      then null
    -- still on the floor: hours so far, never zero
    when a.clock_out is null
      then round((extract(epoch from (now() - a.clock_in)) / 3600.0)::numeric, 4)
    else round((extract(epoch from (a.clock_out - a.clock_in)) / 3600.0)::numeric, 4)
  end                                               as hours,
  a.is_late,
  a.justified,
  a.correction_reason,
  a.correction_reason is not null                   as was_corrected,
  a.notes,
  a.geo_flag,
  a.geo_source
from public.attendance_records a
left join public.employees e on e.user_id = a.user_id;

comment on view public.attendance_shifts is
  'One row per attendance record with its worked hours. hours is null when the record cannot answer the question (never clocked out, or clocked out before clocking in) - that is a correction to make, not a zero to report.';

create or replace view public.attendance_day_hours
with (security_invoker = true) as
select
  employee_id,
  user_id,
  employee_name,
  work_date,
  sum(hours)                                   as hours,      -- null-safe: sum ignores nulls
  count(*)                                     as shifts,
  count(*) filter (where hours is null)        as unusable_shifts,
  bool_or(is_open and not is_abandoned)        as on_the_floor,
  bool_or(is_abandoned)                        as has_abandoned,
  bool_or(is_late)                             as late,
  min(clock_in)                                as first_in,
  max(clock_out)                               as last_out,
  array_agg(distinct outlet_code) filter (where outlet_code is not null) as outlet_codes
from public.attendance_shifts
group by 1, 2, 3, 4;

comment on view public.attendance_day_hours is
  'One row per employee per Kuwait day. Split shifts are summed. unusable_shifts counts records that need a correction before the day''s total means anything.';

-- ── 5. Store open and close, shops only ──────────────────────────────────────
-- Aggregates only, so a salesperson can see the shop is open without being able
-- to read anybody else's attendance.
create or replace function public.store_day(p_outlet text, p_date date)
returns table (
  outlet_code text,
  work_date   date,
  opened_at   timestamptz,
  closed_at   timestamptz,
  is_open     boolean,
  staff_in    int,
  staff_total int
)
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select
    o.code,
    p_date,
    min(s.clock_in),
    case when bool_or(s.is_open and not s.is_abandoned) then null else max(s.clock_out) end,
    coalesce(bool_or(s.is_open and not s.is_abandoned), false),
    count(*) filter (where s.is_open and not s.is_abandoned)::int,
    count(distinct coalesce(s.employee_id::text, s.employee_name))::int
  from public.outlets o
  left join public.attendance_shifts s
         on s.outlet_code = o.code
        and s.work_date = p_date
 where o.code = public.resolve_outlet(p_outlet)
   and o.tracks_store_day
 group by o.code
$$;

comment on function public.store_day(text, date) is
  'When a shop opened and closed on a date, from attendance. Shops only - a digital channel has no opening time. Returns no row for an outlet that does not track store hours.';

-- ── 6. One sales identity ────────────────────────────────────────────────────
-- The roster name lived in two columns and only one of them was ever filled for
-- some people, which is how a salesperson got locked out of the DSR last week.
-- employees.dsr_staff_name wins: it is on the row that also carries the shop,
-- the schedule and the leave balance.

update public.employees e
   set dsr_staff_name = p.sales_name
  from public.profiles p
 where p.id = e.user_id
   and e.dsr_staff_name is null
   and p.sales_name is not null;

update public.profiles p
   set sales_name = e.dsr_staff_name
  from public.employees e
 where e.user_id = p.id
   and p.sales_name is null
   and e.dsr_staff_name is not null
   and not exists (select 1 from public.profiles q where q.sales_name = e.dsr_staff_name);

create or replace function public.get_my_sales_name()
returns text
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(
    (select e.dsr_staff_name
       from public.employees e
      where e.user_id = auth.uid()
        and e.dsr_staff_name is not null
      limit 1),
    (select p.sales_name from public.profiles p where p.id = auth.uid())
  )
$$;

comment on function public.get_my_sales_name() is
  'The DSR roster name for the signed-in user. employees.dsr_staff_name is the source of truth; profiles.sales_name is kept in step for callers not yet migrated.';

comment on column public.profiles.sales_name is
  'Deprecated mirror of employees.dsr_staff_name, kept while callers migrate. Write to the employee record instead.';

-- Keep the mirror in step from now on.
create or replace function public.sync_sales_name_to_profile()
returns trigger
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  was text := case when tg_op = 'UPDATE' then old.dsr_staff_name end;
begin
  if new.user_id is not null
     and new.dsr_staff_name is not null
     and new.dsr_staff_name is distinct from was
     and not exists (
       select 1 from public.profiles q
        where q.sales_name = new.dsr_staff_name and q.id <> new.user_id
     )
  then
    update public.profiles set sales_name = new.dsr_staff_name where id = new.user_id;
  end if;
  return null;
end $$;

drop trigger if exists employees_sync_sales_name on public.employees;
create trigger employees_sync_sales_name
  after insert or update of dsr_staff_name, user_id on public.employees
  for each row execute function public.sync_sales_name_to_profile();

grant select on public.outlets, public.employee_schedules,
               public.attendance_shifts, public.attendance_day_hours to authenticated;
grant execute on function public.resolve_outlet(text), public.outlet_key(text),
                          public.schedule_on(uuid, date), public.store_day(text, date),
                          public.attendance_abandon_hours() to authenticated;
