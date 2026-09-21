-- A birthday reminds one person, a week before and on the day.
--
-- Stage C5. occasion_reminders_due (C1) already knows whose occasion falls
-- in 7 days or today and who should hear about it — the responsible
-- salesperson, else whoever served them last, else the shop's manager. This
-- turns that answer into a notification once a day, through the same
-- notify_event the rest of the system uses, so it queues, respects quiet
-- hours and reaches the bell in both apps like everything else.
--
-- Once per person per occasion per lead day: notify_event's own dedupe only
-- looks back ten minutes, so the check here is against the whole table.
-- The link opens the customer's page with the matching template ready.

create or replace function public.raise_occasion_reminders(p_lead_days integer[] default array[7, 0])
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0; who uuid; roles text[]; title text; body text; url text; key text; outlet text; nm text; tpl text;
begin
  for r in select * from public.occasion_reminders_due(p_lead_days) loop
    key := format('occasion_due:%s:%s:%s:%s', r.customer_id, r.kind, r.occasion_date, r.days_until);
    if exists (select 1 from public.notifications x where x.dedupe_key = key) then continue; end if;

    select coalesce(nullif(trim(c.display_name), ''), c.contact) into nm from public.customers c where c.id = r.customer_id;
    select o.dsr_names[1] into outlet
      from public.customer_outlets co join public.outlets o on o.code = co.outlet_code
     where co.customer_id = r.customer_id order by co.last_at desc nulls last limit 1;

    who := null; roles := null;
    if r.employee_id is not null then
      select e.user_id into who from public.employees e where e.id = r.employee_id;
    elsif r.manager_user_id is not null then
      who := r.manager_user_id;
    else
      roles := array['admin'];
    end if;
    if who is null and roles is null then continue; end if;

    tpl := case when r.kind = 'birthday' then 'birthday' when r.kind = 'anniversary' then 'anniversary' else 'general_followup' end;
    title := case when r.days_until = 0 then format('%s today: %s', r.label, nm)
                  else format('%s in %s days: %s', r.label, r.days_until, nm) end;
    body := case when r.days_until = 0 then 'Today is the day. Open their page to send a message.'
                 else 'A week to go. Open their page to send a message or plan something.' end;
    url := format('#/crm?customer=%s&wa=%s', r.customer_id, tpl);

    perform public.notify_event('occasion_due', title, body, url, roles, who, null, key, outlet);
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.raise_occasion_reminders(integer[]) from public;

-- 06:00 Kuwait, after the nightly relationship rebuild at 03:30.
select cron.unschedule(jobid) from cron.job where jobname = 'occasion-reminders';
select cron.schedule('occasion-reminders', '0 3 * * *', $$ select public.raise_occasion_reminders() $$);