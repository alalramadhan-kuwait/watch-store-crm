-- An attendance correction says which day and which times.
--
-- Asking for one was a paragraph in a box: "I forgot to clock out yesterday —
-- I left at 5:30". It went to the manager's Inbox, where Approve set a status
-- and nothing else. To actually fix the record the manager then had to read the
-- paragraph, open HR → Attendance, find the day, and retype the times by hand.
--
-- Three things go wrong with that. The employee can describe a time without
-- ever being asked for one, so half the requests do not contain the answer. The
-- manager retypes from prose, which is where a 5:30 becomes a 5:00. And
-- "Approved" means a manager agreed, not that anything changed — an approved
-- request and an applied one look identical, so a correction can be agreed to
-- and then quietly never made.
--
-- The request now carries the day, the proposed clock-in and clock-out, and the
-- record it is about. Approving applies it. Nothing is guessed: a time the
-- employee did not give stays null, and null means "leave that one alone".

alter table public.employee_requests
  add column if not exists attendance_date      date,
  add column if not exists proposed_clock_in    timestamptz,
  add column if not exists proposed_clock_out   timestamptz,
  -- The record being corrected. Null when the day has no record at all — a
  -- shift nobody clocked in for is exactly the case worth asking about, and it
  -- is the one a foreign key to an existing row cannot express.
  add column if not exists attendance_record_id uuid
    references public.attendance_records(id) on delete set null,
  -- When the approval actually reached the attendance record, and who carried
  -- it. Without these, "Approved" and "done" are the same word for two
  -- different states.
  add column if not exists applied_at           timestamptz,
  add column if not exists applied_by           uuid references public.profiles(id) on delete set null;

comment on column public.employee_requests.attendance_date is
  'The working day being corrected, Kuwait time. Any past day: a missed clock-out is often noticed a week later.';
comment on column public.employee_requests.proposed_clock_in is
  'The time the employee says they arrived. Null = do not change the clock-in.';
comment on column public.employee_requests.proposed_clock_out is
  'The time the employee says they left. Null = do not change the clock-out.';
comment on column public.employee_requests.applied_at is
  'When an approval was written onto the attendance record. Null on an approved request means the record was NOT changed.';

-- A correction that proposes nothing is a complaint, not a correction. The
-- other request type carries no times at all, so the rule only binds its own.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'employee_requests_correction_has_a_time') then
    alter table public.employee_requests
      add constraint employee_requests_correction_has_a_time check (
        request_type <> 'Attendance correction'
        or attendance_date is null                       -- an older free-text request
        or proposed_clock_in is not null
        or proposed_clock_out is not null
      );
  end if;
end $$;

-- The proposed times must belong to the day being corrected, give or take the
-- night either side: a shift that ends after midnight is real, a clock-out
-- three weeks from the clock-in is a typo nobody would catch by eye.
do $$
begin
  if not exists (select 1 where exists (select 1 from pg_constraint where conname = 'employee_requests_times_near_the_day')) then
    alter table public.employee_requests
      add constraint employee_requests_times_near_the_day check (
        attendance_date is null
        or (
          (proposed_clock_in is null
             or proposed_clock_in between attendance_date::timestamptz - interval '1 day'
                                      and attendance_date::timestamptz + interval '2 days')
          and (proposed_clock_out is null
             or proposed_clock_out between attendance_date::timestamptz - interval '1 day'
                                       and attendance_date::timestamptz + interval '2 days')
        )
      );
  end if;
end $$;
