-- The shop could set when the working day starts but not when it ends: 17:00
-- was written into the code. Leaving early was therefore judged against a time
-- nobody could change, which is how a manager who works 08:30 to 15:30 came to
-- be "leaving early" thirteen days out of fourteen.
--
-- This is only the fallback. Somebody with shift times on their own dated
-- schedule is judged against those; this covers everyone who has none.

alter table public.settings add column if not exists work_end_time time default '17:00';
alter table public.settings add column if not exists late_grace_minutes int default 60;

comment on column public.settings.work_start_time is
  'Default start of the working day, for anyone with no shift on their own schedule.';
comment on column public.settings.work_end_time is
  'Default end of the working day, for anyone with no shift on their own schedule. Leaving before it counts as leaving early.';
comment on column public.settings.late_grace_minutes is
  'How long after the shift starts still counts as on time.';

update public.settings set work_end_time = '17:00' where work_end_time is null;
update public.settings set late_grace_minutes = 60 where late_grace_minutes is null;
