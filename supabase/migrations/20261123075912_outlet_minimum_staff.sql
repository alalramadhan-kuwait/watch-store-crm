-- How many people a shop needs on the floor while it is open. The Today page
-- marks a shop Short or Uncovered against this. Null for the office and the
-- digital channels, which are judged against their own rota instead.
alter table public.outlets add column if not exists min_staff smallint check (min_staff is null or min_staff >= 0);
comment on column public.outlets.min_staff is
  'People needed on the floor while the shop is open. Null for the office and digital channels.';
update public.outlets set min_staff = 2 where code = 'avenues' and min_staff is null;
update public.outlets set min_staff = 1 where code = 'time_gallery' and min_staff is null;
