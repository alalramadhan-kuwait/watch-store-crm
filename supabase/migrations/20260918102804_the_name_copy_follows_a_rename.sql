-- The attendance name copy has to follow a rename, not just an insert.
--
-- 20260918075345_one_name_and_everything_the_inbox_needs.sql unified Hussein
-- Deeb's spelling on employees and profiles, then did
--
--   update public.attendance_records set employee_name = employee_name ...
--
-- believing attendance_set_canonical_name would recompute the copy. That
-- trigger is BEFORE INSERT only, so the no-op update was exactly that: his two
-- records kept saying 'Hussain Dib' while HR said 'Hussein Deeb'.
--
-- That matters because the DSR joins attendance to the shop roster on the name
-- string and drops what it cannot match, silently. The manager's attendance --
-- including the shift he was clocked into at the time -- vanished from the app.
--
-- Two fixes: re-stamp the rows the rename left behind, and widen the trigger so
-- a copy can never drift from the record it copies again.

begin;

-- ---------------------------------------------------------------------------
-- 1. The trigger covers UPDATE as well as INSERT
-- ---------------------------------------------------------------------------

drop trigger if exists attendance_set_canonical_name on public.attendance_records;

create trigger attendance_set_canonical_name
  before insert or update on public.attendance_records
  for each row execute function attendance_canonical_name();

-- ---------------------------------------------------------------------------
-- 2. Re-stamp every row a rename has already orphaned
-- ---------------------------------------------------------------------------

/* Matched on user_id, which is the real link and was correct on these rows all
   along -- the name is only a copy. Restricted to rows that actually disagree so
   this is a no-op on a second run and touches nothing it does not have to. */
update public.attendance_records a
   set employee_name = e.full_name
  from public.employees e
 where e.user_id = a.user_id
   and a.user_id is not null
   and nullif(trim(e.full_name), '') is not null
   and lower(trim(a.employee_name)) is distinct from lower(trim(e.full_name));

commit;
