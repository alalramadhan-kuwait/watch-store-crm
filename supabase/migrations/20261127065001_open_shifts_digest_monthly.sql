-- The owner asked for the "clock-ins never closed" alert once a month instead of every morning.
-- On the 1st (09:30 Kuwait) it summarises the month that just ended. Older open records stay in
-- attendance_records untouched; the Clock-ins not closed page shows them month by month.
create or replace function public.attendance_open_shifts_digest()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare n int; who text; m_start date; m_end date; label text;
begin
  m_end   := date_trunc('month', public.kuwait_today())::date;          -- 1st of this month
  m_start := (m_end - interval '1 month')::date;                        -- 1st of last month
  label   := to_char(m_start, 'FMMonth YYYY');
  select sum(c)::int, string_agg(employee_name || ' ' || c, ' · ' order by c desc, employee_name)
    into n, who
    from (select employee_name, count(*) c
            from public.attendance_records
           where clock_out is null
             and (clock_in at time zone 'Asia/Kuwait')::date >= m_start
             and (clock_in at time zone 'Asia/Kuwait')::date <  m_end
           group by employee_name) t;
  if coalesce(n, 0) = 0 then return 0; end if;
  perform public.notify_event('att_open_shifts',
    label || ': ' || n || ' clock-in' || case when n > 1 then 's' else '' end || ' never closed',
    who || '. Tap to see the days and close them.',
    '#/open-shifts?month=' || to_char(m_start, 'YYYY-MM'), array['admin', 'hr', 'manager'], null, null,
    'att_open:' || to_char(m_start, 'YYYY-MM'), null);
  return n;
end;
$function$;

select cron.schedule('attendance-open-shifts-digest', '30 6 1 * *', $$select public.attendance_open_shifts_digest()$$);
