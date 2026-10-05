-- Which app a phone subscription belongs to. Both apps write to this table; before, a push was sent to
-- every subscription of the user, so anyone with both installed got every alert twice.
alter table public.push_subscriptions
  add column if not exists app text not null default 'timekeeper';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'push_subscriptions_app_check') then
    alter table public.push_subscriptions add constraint push_subscriptions_app_check check (app in ('timekeeper', 'dsr'));
  end if;
end $$;
-- The only subscription made from the shop app so far (DSR 3.1.0 went live 4 Oct 09:17 UTC).
update public.push_subscriptions set app = 'dsr' where created_at >= '2026-10-04 09:17:00+00';

-- Events that were reaching people but were missing from the catalogue, so the shop app's feed
-- (which lists only catalogued shop-floor events) never showed them and nothing said where they belong.
insert into public.notification_settings (event_type, label, category, enabled, person_target, audience_roles, sort, shop_floor, outlet_scoped)
values
  ('wa_target', 'Weekly contact target nudge', 'CRM', true, true, null, 62, true, false),
  ('wa_nudge', 'WhatsApp nudge to a salesman', 'CRM', true, true, null, 63, true, false),
  ('manual_sale_unmatched', 'Manual sale never rung on the till', 'Sales', true, false, null, 90, true, false),
  ('att_open_shifts', 'Clock-ins nobody closed', 'Attendance', true, false, null, 72, false, false)
on conflict (event_type) do nothing;

-- (push_targets() is defined in the next migration, each_event_has_a_home_app.)
