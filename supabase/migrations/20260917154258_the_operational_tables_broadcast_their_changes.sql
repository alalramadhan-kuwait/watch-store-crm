-- Realtime only reaches a client if the table is in the supabase_realtime
-- publication, and nothing was. The shop floor has been subscribing to `cases`
-- and `day_closes` for months and quietly receiving nothing: Today's Log and
-- the follow-up board looked live and were not, refreshing only when somebody
-- navigated back to them.
--
-- Only what changes during a working day is published. Historical reports, old
-- payroll periods and settings are not: a payroll export does not become more
-- correct for arriving a second sooner, and every published table is traffic on
-- a phone on mall wifi.
--
-- Row-level security still applies to realtime, so a salesperson receives their
-- own attendance changes and not anybody else's.

do $$
declare t text;
begin
  foreach t in array array[
    'cases',                -- today's entries, already subscribed to
    'day_closes',           -- the day being closed, already subscribed to
    'attendance_records',   -- who is on the floor right now
    'employee_requests',    -- a correction waiting to be approved
    'leave_records'         -- leave approved or refused while somebody is looking
  ]
  loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
