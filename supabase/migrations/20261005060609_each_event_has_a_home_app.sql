-- Where an event's push goes is a decision about the event, not about the reader's job title. Name it.
alter table public.notification_settings add column if not exists home_app text not null default 'timekeeper';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'notification_settings_home_app_check') then
    alter table public.notification_settings add constraint notification_settings_home_app_check check (home_app in ('timekeeper', 'dsr'));
  end if;
end $$;

-- The shop app (DSR): what happens on the shop floor and to the people who work it.
update public.notification_settings set home_app = 'dsr'
 where event_type in ('req_new', 'leave_new', 'req_withdrawn', 'req_reminder', 'leave_decided', 'req_decided',
                      'occasion_due', 'wa_target', 'wa_nudge', 'manual_sale_unmatched');
-- Everything else (purchase orders, projects, tasks, accounts, settings, attendance, marketing) stays with the
-- back office app (Time Keeper).

create or replace function public.push_targets(p_users uuid[], p_event text)
 returns table(endpoint text, p256dh text, auth text)
 language sql stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  with ev as (
    select coalesce((select s.home_app from public.notification_settings s where s.event_type = p_event), 'timekeeper') as home,
           coalesce((select s.shop_floor from public.notification_settings s where s.event_type = p_event), false) as shop_floor
  ),
  u as (
    select s.user_id, s.app, s.endpoint, s.p256dh, s.auth
      from public.push_subscriptions s
     where s.user_id = any(p_users)
  )
  -- one app per event: the event's home, or the other app only when the person has no phone in the home
  -- app and the other app can show the event (the back office app shows everything, the shop app only shop-floor events)
  select u.endpoint, u.p256dh, u.auth
    from u cross join ev
   where u.app = ev.home
      or (not exists (select 1 from u h where h.user_id = u.user_id and h.app = ev.home)
          and (u.app = 'timekeeper' or ev.shop_floor));
$function$;
revoke execute on function public.push_targets(uuid[], text) from public, anon, authenticated;
grant execute on function public.push_targets(uuid[], text) to service_role;
