-- The morning alert about clock-ins nobody closed used to open the home page and say only names. It now says how
-- many each person has and opens #/open-shifts, which lists the days, times and places and has a WhatsApp message
-- ready for each person.
create or replace function public.attendance_open_shifts_digest()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare n int; who text;
begin
  select sum(c)::int, string_agg(employee_name || ' ' || c, ' · ' order by c desc, employee_name)
    into n, who
    from (select employee_name, count(*) c
            from public.attendance_records
           where clock_out is null
             and clock_in < now() - make_interval(secs => (public.attendance_abandon_hours() * 3600)::double precision)
           group by employee_name) t;
  if coalesce(n, 0) = 0 then return 0; end if;
  perform public.notify_event('att_open_shifts',
    n || ' clock-in' || case when n > 1 then 's' else '' end || ' never closed',
    who || '. Tap to see the days and send each person their list.',
    '#/open-shifts', array['admin', 'hr', 'manager'], null, null, 'att_open:' || public.kuwait_today()::text, null);
  return n;
end;
$function$;
revoke execute on function public.attendance_open_shifts_digest() from public, anon, authenticated;

-- Alerts already sent point at the home page; send them to the list too (keeps their ?n= id).
update public.notifications
   set url = regexp_replace(url, '^#/(\?|$)', '#/open-shifts\1')
 where event_type = 'att_open_shifts' and url ~ '^#/(\?|$)';
