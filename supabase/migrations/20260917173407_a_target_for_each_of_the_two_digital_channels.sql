-- The "Time Keeper" register had one monthly target because it looked like one
-- shop. It is two channels, so it needs two targets.
--
-- The existing figure moves to Online rather than being split down the middle:
-- Online is the register's catch-all and carries about three quarters of its
-- takings, so leaving the number where the bulk of the money is keeps the
-- dashboard honest until somebody sets a real pair. WhatsApp starts with no
-- target, which shows no target line rather than a percentage of a guess.

alter table public.settings add column if not exists sales_target_online   numeric;
alter table public.settings add column if not exists sales_target_whatsapp numeric;

comment on column public.settings.sales_target_online is
  'Monthly target in KD for the Time Keeper Online channel.';
comment on column public.settings.sales_target_whatsapp is
  'Monthly target in KD for the Time Keeper WhatsApp channel (Eman''s sales on the Time Keeper register).';
comment on column public.settings.sales_target_timekeeper is
  'Deprecated: the old single target for the whole Time Keeper register, before it was split into Online and WhatsApp. Kept so nothing that still reads it breaks.';

update public.settings
   set sales_target_online = sales_target_timekeeper
 where sales_target_online is null
   and sales_target_timekeeper is not null;
