-- The outlet column was added, and nothing filled it.
--
-- The previous migration gave notifications an `audience_outlet` and narrowed
-- the read policy so a manager only sees rows for outlets they are scoped to.
-- But the triggers that actually raise request notifications were still calling
-- the old eight-argument notify_event, so every row went out with a null
-- outlet — and a null outlet means company-wide. The scoping was in place and
-- completely inert: Eman would still have been told about Avenues corrections
-- she cannot act on, which is worse than useless, because it is a nudge to go
-- and look at something row-level security will not show her.
--
-- Both triggers now look up the employee's outlet and pass it. The employee
-- record is the authority for where somebody works, with a fall back through
-- the login for a request raised by an account that has no employee row linked.

create or replace function public.trg_emp_req_notify()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare
  who text := coalesce(
    (select full_name from employees where id = new.employee_id),
    (select full_name from profiles  where id = new.user_id),
    'An employee');
  site text := coalesce(
    (select location from employees where id = new.employee_id),
    (select e.location from employees e where e.user_id = new.user_id));
begin
  if tg_op = 'INSERT' then
    perform notify_event('req_new', 'New Request',
      who || ': ' || coalesce(new.request_type, 'request'),
      '#/inbox?focus=' || new.id, array['admin','manager','hr'], null, auth.uid(),
      'req_new:' || new.id, site);
    return null;
  end if;

  if new.status is distinct from old.status and new.status = 'Withdrawn' then
    perform notify_event('req_withdrawn', 'Request withdrawn',
      who || ' withdrew their ' || lower(coalesce(new.request_type, 'request')),
      '#/inbox?focus=' || new.id, array['admin','manager','hr'], null, auth.uid(),
      'req_withdrawn:' || new.id, site);
    return null;
  end if;

  if new.manager_status is distinct from old.manager_status
     and new.manager_status = 'Approved' and new.status = 'Pending' then
    perform notify_event('req_stage', 'Ready for your approval',
      who || '''s ' || lower(coalesce(new.request_type, 'request'))
        || ' was approved by the store manager',
      '#/inbox?focus=' || new.id, array['admin'], null, auth.uid(),
      'req_stage:' || new.id, site);
    return null;
  end if;

  if new.status is distinct from old.status and new.status in ('Approved','Rejected') then
    perform notify_event('req_decided', 'Request ' || new.status,
      'Request ' || new.status || ' - ' || coalesce(new.request_type, 'request'),
      '#/me?req=rq-' || new.id, null, new.user_id, auth.uid(),
      'req_decided:' || new.id || ':' || new.status, site);
  end if;
  return null;
end $function$;

create or replace function public.trg_leave_notify()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare
  who text := coalesce((select full_name from employees where id = new.employee_id), 'An employee');
  whose_uid uuid := (select user_id from employees where id = new.employee_id);
  site text := (select location from employees where id = new.employee_id);
begin
  if tg_op = 'INSERT' and new.approval_status = 'Pending' then
    perform notify_event('leave_new', 'New Request',
      who || ' submitted a ' || coalesce(new.leave_type, 'leave') || ' request',
      '#/inbox?focus=' || new.id, array['admin','manager','hr'], null, auth.uid(),
      'leave_new:' || new.id, site);
    return null;
  end if;

  if tg_op = 'UPDATE' then
    if new.approval_status is distinct from old.approval_status
       and new.approval_status in ('Cancelled','Withdrawn') then
      perform notify_event('req_withdrawn', 'Request withdrawn',
        who || ' withdrew their ' || coalesce(new.leave_type, 'leave') || ' request',
        '#/inbox?focus=' || new.id, array['admin','manager','hr'], null, auth.uid(),
        'req_withdrawn:' || new.id, site);
      return null;
    end if;

    if new.manager_status is distinct from old.manager_status
       and new.manager_status = 'Approved' and new.approval_status = 'Pending' then
      perform notify_event('req_stage', 'Ready for your approval',
        who || '''s ' || coalesce(new.leave_type, 'leave')
          || ' request was approved by the store manager',
        '#/inbox?focus=' || new.id, array['admin'], null, auth.uid(),
        'req_stage:' || new.id, site);
      return null;
    end if;

    if new.approval_status is distinct from old.approval_status
       and new.approval_status in ('Approved','Rejected') then
      perform notify_event('leave_decided', 'Leave ' || new.approval_status,
        'Leave ' || new.approval_status || ' - ' || coalesce(new.leave_type, 'leave')
          || ' ' || new.leave_start,
        '#/me?req=lv-' || new.id, null, whose_uid, auth.uid(),
        'leave_decided:' || new.id || ':' || new.approval_status, site);
    end if;
  end if;
  return null;
end $function$;
