-- A two-stage workflow has to announce both stages.
--
-- req_new fired on arrival and req_decided on the final word, which was the
-- whole conversation while there was only one stage. Now there are two, and the
-- middle was silent: when the store manager gave the first approval the status
-- stayed Pending, so nothing fired and the owner learned that it was their turn
-- by going and looking. A withdrawal was silent too — an approver could act on a
-- request the employee had already taken back.
--
-- This matters more than it did last week, because the shop floor app now has a
-- notification centre of its own. Until today it had none: the store manager
-- was told nothing by either app, about anything.

insert into public.notification_settings (event_type, label, category, enabled, person_target, audience_roles, sort)
values
  ('req_stage',     'Request approved by a manager', 'Requests', true,  false, array['admin'],                 21),
  ('req_withdrawn', 'Request withdrawn',             'Requests', true,  false, array['admin','manager','hr'],  22)
on conflict (event_type) do update
  set label = excluded.label, category = excluded.category,
      audience_roles = excluded.audience_roles;

create or replace function public.trg_emp_req_notify()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $function$
declare
  who text := coalesce(
    (select full_name from employees where id = new.employee_id),
    (select full_name from profiles  where id = new.user_id),
    'An employee');
begin
  if tg_op = 'INSERT' then
    perform notify_event('req_new', 'New Request',
      who || ': ' || coalesce(new.request_type, 'request'),
      '#/inbox?focus=' || new.id, array['admin','manager','hr'], null, auth.uid(),
      'req_new:' || new.id);
    return null;
  end if;

  -- The employee taking it back, before anybody spends time on it.
  if new.status is distinct from old.status and new.status = 'Withdrawn' then
    perform notify_event('req_withdrawn', 'Request withdrawn',
      who || ' withdrew their ' || lower(coalesce(new.request_type, 'request')),
      '#/inbox?focus=' || new.id, array['admin','manager','hr'], null, auth.uid(),
      'req_withdrawn:' || new.id);
    return null;
  end if;

  -- The handover. The status has not moved, which is exactly why this is needed.
  if new.manager_status is distinct from old.manager_status
     and new.manager_status = 'Approved' and new.status = 'Pending' then
    perform notify_event('req_stage', 'Ready for your approval',
      who || '''s ' || lower(coalesce(new.request_type, 'request'))
        || ' was approved by the store manager',
      '#/inbox?focus=' || new.id, array['admin'], null, auth.uid(),
      'req_stage:' || new.id);
    return null;
  end if;

  -- The final word, to the person who asked.
  if new.status is distinct from old.status and new.status in ('Approved','Rejected') then
    perform notify_event('req_decided', 'Request ' || new.status,
      'Request ' || new.status || ' - ' || coalesce(new.request_type, 'request'),
      '#/me?req=rq-' || new.id, null, new.user_id, auth.uid(),
      'req_decided:' || new.id || ':' || new.status);
  end if;
  return null;
end $function$;

create or replace function public.trg_leave_notify()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $function$
declare
  who text := coalesce((select full_name from employees where id = new.employee_id), 'An employee');
  whose_uid uuid := (select user_id from employees where id = new.employee_id);
begin
  if tg_op = 'INSERT' and new.approval_status = 'Pending' then
    perform notify_event('leave_new', 'New Request',
      who || ' submitted a ' || coalesce(new.leave_type, 'leave') || ' request',
      '#/inbox?focus=' || new.id, array['admin','manager','hr'], null, auth.uid(),
      'leave_new:' || new.id);
    return null;
  end if;

  if tg_op = 'UPDATE' then
    if new.approval_status is distinct from old.approval_status
       and new.approval_status in ('Cancelled','Withdrawn') then
      perform notify_event('req_withdrawn', 'Request withdrawn',
        who || ' withdrew their ' || coalesce(new.leave_type, 'leave') || ' request',
        '#/inbox?focus=' || new.id, array['admin','manager','hr'], null, auth.uid(),
        'req_withdrawn:' || new.id);
      return null;
    end if;

    if new.manager_status is distinct from old.manager_status
       and new.manager_status = 'Approved' and new.approval_status = 'Pending' then
      perform notify_event('req_stage', 'Ready for your approval',
        who || '''s ' || coalesce(new.leave_type, 'leave')
          || ' request was approved by the store manager',
        '#/inbox?focus=' || new.id, array['admin'], null, auth.uid(),
        'req_stage:' || new.id);
      return null;
    end if;

    if new.approval_status is distinct from old.approval_status
       and new.approval_status in ('Approved','Rejected') then
      perform notify_event('leave_decided', 'Leave ' || new.approval_status,
        'Leave ' || new.approval_status || ' - ' || coalesce(new.leave_type, 'leave')
          || ' ' || new.leave_start,
        '#/me?req=lv-' || new.id, null, whose_uid, auth.uid(),
        'leave_decided:' || new.id || ':' || new.approval_status);
    end if;
  end if;
  return null;
end $function$;
