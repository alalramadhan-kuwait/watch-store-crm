-- Both apps have always sent 'Cancelled' when someone withdraws a leave
-- request, and the RLS policy own_update_leave explicitly permits it — but the
-- check constraint never listed it, so every cancel failed with a constraint
-- error and the request stayed pending. Found while testing two-step approval.
alter table public.leave_records drop constraint if exists leave_records_approval_status_check;
alter table public.leave_records add constraint leave_records_approval_status_check
  check (approval_status = any (array['Pending', 'Approved', 'Rejected', 'Cancelled']));
