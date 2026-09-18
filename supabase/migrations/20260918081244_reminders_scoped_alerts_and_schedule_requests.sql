-- Reminders, outlet-scoped alerts, and asking for different hours.
--
-- Four gaps the workflow still had, in one migration because they touch the
-- same view and the same notification path.
--
-- 1. AN ALERT BELONGED TO EVERYBODY. `req_new` went to every admin, manager and
--    HR account, with no outlet filter — so Eman, who manages head office, was
--    told about Avenues corrections she has no business deciding. RLS already
--    stopped her seeing them in the queue; the notification was arriving
--    anyway, which is worse than useless: it is a nudge to go and look at
--    something you cannot act on. Notifications now carry the outlet they
--    concern, and the read policy narrows managers to their own scopes. Admins
--    and HR are unaffected, because they really do need all of it.
--
-- 2. NOBODY COULD CHASE. A request waiting on a store manager sat there until
--    somebody happened to notice. `remind_request` sends one nudge to whoever is
--    holding it up, refuses to send another for four hours, and records who
--    asked and when — so "Last reminder: today 09:15" is a fact rather than a
--    memory. A button and the nightly job call the same function, so they can
--    never disagree about what "recently reminded" means.
--
-- 3. NOBODY HAD TO REMEMBER TO CHASE. `remind_overdue_requests`, on a cron at
--    07:00 Kuwait, nudges anything past a day, once a day. The overdue
--    threshold is the same one the dashboard card counts, read from the same
--    view, so the number and the chase always agree.
--
-- 4. A SCHEDULE COULD ONLY BE CHANGED FROM A DESK. `set_schedule()` is open to
--    HR, managers and owners and to nobody else, so an employee wanting
--    different hours had to find somebody to type it in. Avenues is exactly the
--    case: the manager assigns mornings and nights by the day, which is why
--    those staff are recorded as "hours vary" in the first place. A Schedule
--    change request now goes through the same two stages as everything else,
--    and `apply_schedule_change` calls `set_schedule` on approval rather than
--    writing rows itself — approving one and not applying it would be the same
--    two-words-for-one-state failure attendance corrections used to have.
--
-- The view also gains the schedule in force on the date being asked about, so a
-- Schedule change renders "Hours vary → 14:00–22:00" instead of an arrow from
-- nothing, and the reminder history, so no screen counts nudges for itself.


-- 1. A notification can belong to an outlet -------------------------------
alter table public.notifications add column if not exists audience_outlet text;

comment on column public.notifications.audience_outlet is
  'The outlet this concerns. A manager only sees it when scoped to that outlet; admins and HR see it regardless. Null = company-wide.';

create or replace function public.notify_event(
  p_event text, p_title text, p_body text, p_url text, p_roles text[],
  p_person uuid, p_exclude uuid, p_dedupe text, p_outlet text default null)
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare
  s notification_settings; cfg notification_config;
  roles text[]; kh timestamp; h int;
  is_batch boolean := p_event like 'po_%';
  is_realtime boolean := p_event in ('att_in','att_out');
  in_hours boolean; v_send timestamptz; v_local timestamp; v_rec text;
  v_id uuid := gen_random_uuid(); batch_sec int;
begin
  if p_dedupe is not null and exists (
    select 1 from notifications where dedupe_key = p_dedupe
     and created_at > now() - interval '10 minutes') then return; end if;

  select * into s from notification_settings where event_type = p_event;
  if found and not s.enabled then return; end if;
  if found and s.audience_roles is not null and p_person is null
    then roles := s.audience_roles; else roles := p_roles; end if;

  select * into cfg from notification_config where id = 1;
  kh := now() at time zone 'Asia/Kuwait'; h := extract(hour from kh);
  in_hours := is_realtime or (not cfg.quiet_enabled) or (h >= cfg.working_start and h < cfg.working_end);
  batch_sec := case when is_batch and cfg.bulk_summary_enabled then cfg.batch_seconds else 0 end;

  if in_hours then
    v_send := now() + make_interval(secs => batch_sec);
  else
    if h < cfg.working_start then v_local := date_trunc('day', kh) + make_interval(hours => cfg.working_start);
    else v_local := date_trunc('day', kh) + interval '1 day' + make_interval(hours => cfg.working_start); end if;
    v_send := v_local at time zone 'Asia/Kuwait';
  end if;

  v_rec := coalesce((regexp_match(p_url,'focus=([^&]+)'))[1],
                    (regexp_match(p_url,'req=([^&]+)'))[1],
                    (regexp_match(p_url,'geo=([^&]+)'))[1]);
  p_url := p_url || (case when position('?' in p_url) > 0 then '&' else '?' end) || 'n=' || v_id::text;

  insert into notifications (id, event_type, title, body, url, audience_roles,
                             person_user_id, exclude_user, dedupe_key, send_after,
                             record_id, audience_outlet)
  values (v_id, p_event, p_title, p_body, p_url, roles, p_person, p_exclude,
          p_dedupe, v_send, v_rec, p_outlet);
exception when others then return;
end $function$;

drop policy if exists notif_read on public.notifications;
create policy notif_read on public.notifications
  for select using (
    auth.uid() = person_user_id
    or (audience_roles is not null
        and get_my_role() = any (audience_roles)
        and (audience_outlet is null
             or get_my_role() <> 'manager'
             or audience_outlet in (select public.my_approval_locations())))
  );

-- 2. Reminders -------------------------------------------------------------
create table if not exists public.request_reminders (
  id           uuid primary key default gen_random_uuid(),
  source       text not null check (source in ('employee_requests','leave_records')),
  request_id   uuid not null,
  sent_by      uuid,
  sent_at      timestamptz not null default now(),
  automatic    boolean not null default false
);

create index if not exists request_reminders_request
  on public.request_reminders (source, request_id, sent_at desc);

alter table public.request_reminders enable row level security;

drop policy if exists rem_read on public.request_reminders;
create policy rem_read on public.request_reminders
  for select using (get_my_role() = any (array['admin','manager','hr']));

comment on table public.request_reminders is
  'Every nudge sent about a request, manual or automatic. The history is the point: it is what stops the same person being reminded four times in an hour, and what lets the owner see when they last asked.';

create or replace function public.remind_request(
  p_source text, p_request_id uuid, p_automatic boolean default false)
returns text language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r record;
  cooldown interval := case when p_automatic then interval '24 hours' else interval '4 hours' end;
  last_at timestamptz;
begin
  if not p_automatic and coalesce(get_my_role(),'') not in ('admin','hr','manager') then
    raise exception 'Only an approver can send a reminder';
  end if;

  select * into r from v_requests where source = p_source and id = p_request_id;
  if not found then return 'That request no longer exists.'; end if;
  if r.stage_owner = 'nobody' then return 'That request is already settled.'; end if;

  select max(sent_at) into last_at from request_reminders
   where source = p_source and request_id = p_request_id;
  if last_at is not null and now() - last_at < cooldown then
    return 'A reminder went out ' || to_char(now() - last_at, 'HH24"h" MI"m"') || ' ago. Give it a little longer.';
  end if;

  perform notify_event(
    'req_reminder', 'Still waiting on you',
    coalesce(r.employee_name,'An employee') || '''s ' || lower(r.kind)
      || ' has been waiting ' || round(r.hours_pending)::text || ' hours',
    '#/inbox?focus=' || r.id,
    null,
    case when r.stage_owner = 'manager' then r.first_approver_id else null end,
    null,
    'req_reminder:' || r.id || ':' || to_char(now(), 'YYYYMMDDHH24'),
    r.outlet);

  insert into request_reminders (source, request_id, sent_by, automatic)
  values (p_source, p_request_id, case when p_automatic then null else auth.uid() end, p_automatic);
  return null;
end $function$;

grant execute on function public.remind_request(text, uuid, boolean) to authenticated;

insert into public.notification_settings (event_type, label, category, enabled, person_target, audience_roles, sort)
values ('req_reminder', 'Reminder about a waiting request', 'Requests', true, true, null, 23)
on conflict (event_type) do update set label = excluded.label, category = excluded.category;

create or replace function public.remind_overdue_requests()
returns int language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare r record; n int := 0;
begin
  for r in
    select source, id from v_requests
     where stage_owner <> 'nobody' and is_overdue
  loop
    if remind_request(r.source, r.id, true) is null then n := n + 1; end if;
  end loop;
  return n;
end $function$;

-- One nudge a day for anything past a day, at 07:00 Kuwait (04:00 UTC).
select cron.schedule('remind-overdue-requests', '0 4 * * *',
  $$select public.remind_overdue_requests()$$);

-- 3. Applying an approved schedule change ----------------------------------
create or replace function public.apply_schedule_change(p_request_id uuid)
returns text language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare r public.employee_requests;
begin
  if coalesce(get_my_role(),'') not in ('admin','hr','manager') then
    raise exception 'Only an approver can apply a schedule change';
  end if;
  select * into r from employee_requests where id = p_request_id;
  if not found then return 'That request no longer exists.'; end if;
  if r.request_type <> 'Schedule change' then return null; end if;
  if r.employee_id is null then return 'This request is not linked to an employee record.'; end if;
  if r.proposed_from is null then return 'This request has no start date.'; end if;

  perform set_schedule(
    r.employee_id, r.proposed_from, r.proposed_until,
    r.proposed_days, r.proposed_shift_start, r.proposed_shift_end,
    'From an approved schedule change request');
  return null;
end $function$;

grant execute on function public.apply_schedule_change(uuid) to authenticated;

-- 4. The view gains the schedule in force and the reminder history ---------
drop view if exists public.v_requests;

create view public.v_requests
with (security_invoker = true) as
select
  q.source, q.id, q.kind,
  q.employee_id, q.employee_name, q.employee_user_id, q.outlet,
  q.details,
  case when position(': ' in q.details) > 0
       then left(q.details, position(': ' in q.details) - 1)
       else q.details end                                   as reason,
  q.attendance_date, q.attendance_record_id,
  q.proposed_clock_in, q.proposed_clock_out,
  q.proposed_from, q.proposed_until, q.proposed_days,
  q.proposed_shift_start, q.proposed_shift_end,
  cur.clock_in                                              as current_clock_in,
  cur.clock_out                                             as current_clock_out,
  coalesce(cur.shifts, 0)                                   as current_shifts,
  sch.shift_start                                           as current_shift_start,
  sch.shift_end                                             as current_shift_end,
  sch.working_days                                          as current_working_days,
  case when q.kind <> 'Attendance correction' then false else coalesce(
    (q.proposed_clock_in is null
      or to_char(q.proposed_clock_in  at time zone 'Asia/Kuwait', 'HH24:MI')
       = to_char(cur.clock_in         at time zone 'Asia/Kuwait', 'HH24:MI'))
    and
    (q.proposed_clock_out is null
      or to_char(q.proposed_clock_out at time zone 'Asia/Kuwait', 'HH24:MI')
       = to_char(cur.clock_out        at time zone 'Asia/Kuwait', 'HH24:MI')),
    false) end                                              as changes_nothing,
  q.status, q.manager_status,
  public.stage_owner(q.status, q.manager_status)            as stage_owner,
  round(extract(epoch from (now() - q.submitted_at)) / 3600.0, 1) as hours_pending,
  (public.stage_owner(q.status, q.manager_status) <> 'nobody'
   and now() - q.submitted_at > interval '24 hours')        as is_overdue,
  rem.last_at                                               as last_reminder_at,
  coalesce(rem.n, 0)                                        as reminder_count,
  q.submitted_at,
  q.on_behalf_by,   ob.full_name                            as on_behalf_name,
  fa.manager_id                                             as first_approver_id,
  fa.full_name                                              as first_approver_name,
  q.manager_remarks,
  q.manager_decided_by, md.full_name                        as manager_decided_name,
  q.manager_decided_at,
  q.final_decided_by,   fd.full_name                        as final_decided_name,
  q.final_decided_at,
  q.withdrawn_at,
  q.override_by,        ov.full_name                        as override_name,
  q.override_at, q.override_reason, q.override_stage
from (
  select
    'employee_requests'::text as source, r.id, r.request_type as kind,
    r.employee_id, e.full_name as employee_name, r.user_id as employee_user_id,
    e.location as outlet, r.details,
    r.attendance_date, r.attendance_record_id,
    r.proposed_clock_in, r.proposed_clock_out,
    r.proposed_from, r.proposed_until, r.proposed_days,
    r.proposed_shift_start, r.proposed_shift_end,
    r.status, coalesce(r.manager_status, 'Not required') as manager_status,
    r.created_at as submitted_at, r.on_behalf_by, r.manager_remarks,
    r.manager_decided_by, r.manager_decided_at,
    r.final_decided_by, r.final_decided_at, r.withdrawn_at,
    r.override_by, r.override_at, r.override_reason, r.override_stage
  from public.employee_requests r
  left join public.employees e on e.id = r.employee_id
  union all
  select
    'leave_records', l.id, 'Leave',
    l.employee_id, e.full_name, e.user_id, e.location,
    coalesce(l.leave_type, 'Leave') || ' - ' || l.leave_start || ' to ' || l.leave_end
      || coalesce(' - ' || l.notes, ''),
    null, null, null, null,
    l.leave_start, l.leave_end, null, null, null,
    l.approval_status, coalesce(l.manager_status, 'Not required'),
    l.created_at, l.on_behalf_by, null,
    l.manager_decided_by, l.manager_decided_at,
    l.final_decided_by, l.final_decided_at, l.withdrawn_at,
    l.override_by, l.override_at, l.override_reason, l.override_stage
  from public.leave_records l
  left join public.employees e on e.id = l.employee_id
) q
left join lateral public.attendance_on_day(q.employee_user_id, q.attendance_date) cur on true
left join lateral public.schedule_on(q.employee_id, coalesce(q.proposed_from, current_date)) sch on true
left join lateral (
  select max(sent_at) as last_at, count(*)::int as n
    from public.request_reminders rr
   where rr.source = q.source and rr.request_id = q.id
) rem on true
left join lateral (
  select ms.manager_id, pr.full_name
    from public.manager_scopes ms
    join public.profiles pr on pr.id = ms.manager_id
   where ms.location = q.outlet
   limit 1
) fa on true
left join public.profiles ob on ob.id = q.on_behalf_by
left join public.profiles md on md.id = q.manager_decided_by
left join public.profiles fd on fd.id = q.final_decided_by
left join public.profiles ov on ov.id = q.override_by;

comment on view public.v_requests is
  'Every request of every type, with everything either inbox needs already resolved. Neither app computes a stage, a name, a comparison or a reminder state of its own.';

grant select on public.v_requests to authenticated;
