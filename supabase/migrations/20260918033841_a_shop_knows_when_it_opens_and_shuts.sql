-- When each shop opens and shuts.
--
-- It belongs on the outlet, not on every person who works there: the Avenues
-- manager assigns mornings or nights by the day, so no fixed pair of hours is
-- right for any individual, but the shop's own hours are the same for everyone.
-- Used to close a shift nobody clocked out of at the latest time that person
-- could still have been there.
--
-- One closing time per outlet. Avenues stays open to 23:00 at weekends; that is
-- not modelled, and the only cost is that leaving at 22:00 on a Friday is not
-- flagged early, which is not a number anybody is chasing.

alter table public.outlets add column if not exists opens_at  time;
alter table public.outlets add column if not exists closes_at time;

comment on column public.outlets.opens_at is
  'When this shop opens. Null for a digital channel and for the office.';
comment on column public.outlets.closes_at is
  'When this shop shuts — the latest somebody could still have been on the floor. Null for a digital channel and for the office.';

update public.outlets set opens_at = time '10:00', closes_at = time '22:00'
 where code in ('avenues', 'time_gallery');
