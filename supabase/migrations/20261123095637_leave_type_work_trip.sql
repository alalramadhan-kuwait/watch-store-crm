-- Away on company business (an expo, a supplier visit). Recorded with leave so
-- attendance, the scoreboard and the Today page all count it as away rather than
-- absent; only Annual counts against the leave balance, so it costs no holiday.
alter table public.leave_records drop constraint if exists leave_type_check;
alter table public.leave_records add constraint leave_type_check
  check (leave_type = any (array['Annual'::text, 'Sick'::text, 'WFH'::text, 'Work trip'::text]));
