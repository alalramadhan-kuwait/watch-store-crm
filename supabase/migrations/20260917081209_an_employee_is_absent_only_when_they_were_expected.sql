-- Absent means "did not come when they were due", not "is not here".
--
-- Nothing in the database knew when anybody was due. The attendance calendar
-- guessed it: a day counted as a working day if SOMEBODY ELSE clocked in on it,
-- so a person on their day off was marked absent whenever a colleague worked,
-- and a whole shop taking the same day off was marked as a day nobody had to
-- work. Good enough for a monthly count; useless for "who is missing right now",
-- which is the question a manager opens the app to ask.
--
-- The shops work Saturday to Thursday and close Friday, so that is the default
-- and every current employee is correct without anyone editing anything.
alter table public.employees
  add column if not exists expected_days smallint[] not null default '{0,1,2,3,4,6}',
  add column if not exists shift_start   time,
  add column if not exists shift_end     time;

comment on column public.employees.expected_days is
  'Weekdays this person is due at work, Postgres dow numbering (0=Sunday … 6=Saturday). Default is Sat–Thu with Friday off. Empty array = never expected, which is how to park somebody without deactivating them.';
comment on column public.employees.shift_start is
  'When their day is due to start, if it differs from settings.work_start_time. Null = the shop default.';
comment on column public.employees.shift_end is
  'When their day is due to end. Null = the shop default (17:00).';

-- A day number outside 0..6 would silently never match, so it is refused.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'employees_expected_days_are_weekdays') then
    alter table public.employees
      add constraint employees_expected_days_are_weekdays check (
        expected_days <@ array[0,1,2,3,4,5,6]::smallint[]
      );
  end if;
end $$;
