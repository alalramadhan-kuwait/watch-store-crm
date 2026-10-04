-- Part 2 of the gaps found testing the DSR as a salesman (4 Oct 2026).
--  * A salesman could move his own clock-out (even into the future) and delete his own attendance
--    record. Now: a clock-out is set once (clamped to clock-in..now); only a manager changes or
--    deletes attendance afterwards.
--  * is_late was whatever the phone sent. For a non-manager it is now worked out here, with the
--    app's own rule (first clock-in of the Kuwait day, later than work start + grace).
--  * The manager PIN and shared staff PIN sat in `settings`, readable by every signed-in user and
--    used by neither app. They move to an admin-only table; nothing is lost.
--  * Any signed-in user could rename or deactivate every brand: changes are for admin/manager.
--  * A salesperson could re-assign his own visit to a colleague's name: locked for the sales role.
--  * Clock-ins nobody closed: a daily digest tells admin / HR / managers.
--
-- NOTE: no policy is dropped here. DROP POLICY hangs through the SQL tool this was applied with,
-- so the old permissive policies (own_all, brands_update, brands_insert) stay and RESTRICTIVE
-- policies narrow them: a restrictive policy must pass as well as one permissive policy.
-- Idempotent: every object is created only if it is missing.

-- Attendance: own_select / own_insert / own_update mirror what own_all allowed, minus delete.
do $$
begin
  if not exists (select 1 from pg_policy where polname = 'own_select' and polrelid = 'public.attendance_records'::regclass) then
    create policy own_select on public.attendance_records for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policy where polname = 'own_insert' and polrelid = 'public.attendance_records'::regclass) then
    create policy own_insert on public.attendance_records for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policy where polname = 'own_update' and polrelid = 'public.attendance_records'::regclass) then
    create policy own_update on public.attendance_records for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  -- own_all still lets a person delete their own rows; this restrictive policy closes that.
  if not exists (select 1 from pg_policy where polname = 'attendance_delete_managers_only' and polrelid = 'public.attendance_records'::regclass) then
    create policy attendance_delete_managers_only on public.attendance_records as restrictive for delete
      using (public.get_my_role() in ('admin', 'manager', 'hr'));
  end if;
end $$;

create or replace function public.attendance_integrity()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_role text; v_start text; v_grace int; v_mins int; v_first boolean;
begin
  if auth.uid() is null then return new; end if;
  v_role := coalesce(get_my_role(), '');
  if v_role in ('admin', 'manager', 'hr') then return new; end if;

  if tg_op = 'INSERT' then
    select coalesce(nullif(s.work_start_time::text, ''), '09:00'), coalesce(s.late_grace_minutes, 60)
      into v_start, v_grace from public.settings s limit 1;
    v_start := coalesce(v_start, '09:00'); v_grace := coalesce(v_grace, 60);
    v_first := not exists (
      select 1 from public.attendance_records r
       where r.user_id = new.user_id
         and (r.clock_in at time zone 'Asia/Kuwait')::date = (new.clock_in at time zone 'Asia/Kuwait')::date);
    v_mins := extract(hour from (new.clock_in at time zone 'Asia/Kuwait'))::int * 60
            + extract(minute from (new.clock_in at time zone 'Asia/Kuwait'))::int
            - (split_part(v_start, ':', 1)::int * 60 + split_part(v_start, ':', 2)::int + v_grace);
    new.is_late := v_first and v_mins > 0;
    return new;
  end if;

  if old.clock_out is not null and new.clock_out is distinct from old.clock_out then
    raise exception 'Only a manager can change a clock-out. Ask for an attendance correction from My Portal.'
      using errcode = 'check_violation';
  end if;
  if old.clock_out is null and new.clock_out is not null then
    new.clock_out := greatest(old.clock_in, least(new.clock_out, now()));
  end if;
  return new;
end;
$function$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'attendance_integrity' and tgrelid = 'public.attendance_records'::regclass) then
    create trigger attendance_integrity before insert or update on public.attendance_records
      for each row execute function public.attendance_integrity();
  end if;
end $$;

-- PINs: out of the table everybody can read, into one only an admin can.
create table if not exists public.app_pins (
  id int primary key default 1 check (id = 1),
  manager_pin text, staff_pin text, moved_at timestamptz not null default now());
alter table public.app_pins enable row level security;
do $$
begin
  if not exists (select 1 from pg_policy where polname = 'app_pins_admin' and polrelid = 'public.app_pins'::regclass) then
    create policy app_pins_admin on public.app_pins for all
      using (public.get_my_role() = 'admin') with check (public.get_my_role() = 'admin');
  end if;
end $$;
insert into public.app_pins (id, manager_pin, staff_pin)
  select 1, manager_pin, staff_pin from public.settings where manager_pin <> '' or staff_pin <> '' limit 1
  on conflict (id) do nothing;
update public.settings set manager_pin = '', staff_pin = ''
 where exists (select 1 from public.app_pins) and (manager_pin <> '' or staff_pin <> '');

-- Brands: add by anyone who logs visits, change only by admin / manager.
do $$
begin
  if not exists (select 1 from pg_policy where polname = 'brands_insert_visit_roles' and polrelid = 'public.brands'::regclass) then
    create policy brands_insert_visit_roles on public.brands as restrictive for insert
      with check (public.get_my_role() in ('admin', 'manager', 'sales', 'staff'));
  end if;
  if not exists (select 1 from pg_policy where polname = 'brands_update_managers_only' and polrelid = 'public.brands'::regclass) then
    create policy brands_update_managers_only on public.brands as restrictive for update
      using (public.get_my_role() in ('admin', 'manager')) with check (public.get_my_role() in ('admin', 'manager'));
  end if;
end $$;

-- A salesperson's visit keeps his own name.
create or replace function public.cases_keep_owner_name()
 returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is not null and coalesce(get_my_role(), '') = 'sales' and new.staff is distinct from old.staff then
    raise exception 'A visit stays under the name it was logged under. Ask a manager to change it.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'cases_keep_owner_name' and tgrelid = 'public.cases'::regclass) then
    create trigger cases_keep_owner_name before update on public.cases
      for each row execute function public.cases_keep_owner_name();
  end if;
end $$;

-- Clock-ins nobody closed: tell the people who can fix them, once a day.
create or replace function public.attendance_open_shifts_digest()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare n int; names text;
begin
  select count(*), string_agg(distinct employee_name, ', ')
    into n, names
    from public.attendance_records
   where clock_out is null
     and clock_in < now() - make_interval(secs => (public.attendance_abandon_hours() * 3600)::double precision);
  if coalesce(n, 0) = 0 then return 0; end if;
  perform public.notify_event('att_open_shifts',
    n || ' clock-in' || case when n > 1 then 's' else '' end || ' never closed',
    'Nobody clocked out: ' || names || '. Add a correction so their hours count.',
    '#/', array['admin', 'hr', 'manager'], null, null, 'att_open:' || public.kuwait_today()::text, null);
  return n;
end;
$function$;
revoke execute on function public.attendance_open_shifts_digest() from public, anon, authenticated;

select cron.schedule('attendance-open-shifts-digest', '30 6 * * *', $$select public.attendance_open_shifts_digest()$$);
