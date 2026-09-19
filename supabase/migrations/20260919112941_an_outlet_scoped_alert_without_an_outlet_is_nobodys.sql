-- Hussein was still being shown Eman's and Ali Akbar's requests. Both work at
-- head office.
--
-- audience_outlet was added a day ago, so every notification raised before that
-- carries null — and the read policy treated null as "company-wide". Scoping
-- therefore only applied to what happened after the column existed. Everything
-- older still reached every manager: four of Eman's requests, Ali Akbar's,
-- Meriam's and Taha's, all landing on the Avenues manager's phone.
--
-- Backfilling the history fixes what can be recovered, but not the rule. A
-- request always belongs to somebody with an outlet, so for those event types a
-- missing outlet is a defect, not a statement that everybody is concerned. Left
-- as "null means everybody", the same leak returns the next time a trigger
-- forgets to pass one — which is precisely how this one happened.
--
-- So event types that must carry an outlet now say so, and for those a manager
-- sees nothing untagged. Admins and HR are unaffected: they see the lot either
-- way, which is what makes it safe to be strict with managers.

alter table public.notification_settings
  add column if not exists outlet_scoped boolean not null default false;

comment on column public.notification_settings.outlet_scoped is
  'True when this event always concerns one outlet. A manager then sees it only when audience_outlet is one of theirs — an untagged row of this type reaches no manager at all, because it is a bug rather than a company-wide announcement.';

update public.notification_settings
   set outlet_scoped = true
 where event_type in ('req_new', 'leave_new', 'req_withdrawn', 'req_stage', 'req_reminder');

/* Recover the outlet from the request each notification points at. record_id
   holds it, put there by notify_event from the focus= in the url. Ten of the
   fourteen are recoverable; the rest point at requests that no longer exist,
   and the rule above is what keeps those from leaking. */
update public.notifications n
   set audience_outlet = v.outlet
  from public.v_requests v
 where v.id::text = n.record_id
   and n.audience_outlet is null
   and v.outlet is not null
   and n.event_type in ('req_new', 'leave_new', 'req_withdrawn', 'req_stage', 'req_reminder');

/* Whether a store manager should be shown this row. Kept as a function so the
   policy reads as the sentence it is. */
create or replace function public.notification_in_my_scope(p_event text, p_outlet text)
returns boolean
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select case
    -- only store managers are narrowed; admin and HR see everything
    when coalesce(get_my_role(), '') <> 'manager' then true
    -- an outlet-scoped event with no outlet reaches no manager: it is a defect
    when (select s.outlet_scoped from notification_settings s where s.event_type = p_event)
      then p_outlet in (select public.my_approval_locations())
    -- everything else keeps the old rule: untagged means company-wide
    else p_outlet is null or p_outlet in (select public.my_approval_locations())
  end
$$;

grant execute on function public.notification_in_my_scope(text, text) to authenticated;

drop policy if exists notif_read on public.notifications;
create policy notif_read on public.notifications
  for select using (
    auth.uid() = person_user_id
    or (audience_roles is not null
        and get_my_role() = any (audience_roles)
        and public.notification_in_my_scope(event_type, audience_outlet))
  );
