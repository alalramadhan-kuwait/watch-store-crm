-- A temporary change for somebody who has no schedule at all left the record
-- variable unassigned, and reading it raised instead of simply having nothing
-- to restore. Plain variables say "nothing found" without blowing up.

create or replace function public.set_schedule(
  p_employee uuid,
  p_from     date,
  p_to       date       default null,
  p_days     smallint[] default null,
  p_start    time       default null,
  p_end      time       default null,
  p_note     text       default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  tail_days  smallint[];
  tail_start time;
  tail_end   time;
  tail_note  text;
  tail_to    date;
  tail_found boolean := false;
begin
  if get_my_role() is null or get_my_role() not in ('admin', 'manager', 'hr') then
    raise exception 'Only HR, a manager or an admin can change a work schedule';
  end if;
  if p_to is not null and p_to < p_from then
    raise exception 'The end of a schedule cannot come before its start';
  end if;
  if not exists (select 1 from public.employees where id = p_employee) then
    raise exception 'No such employee';
  end if;

  -- What is in force on the last day of a temporary change, so it can be put
  -- back the day after. Captured before anything is moved.
  if p_to is not null then
    select s.working_days, s.shift_start, s.shift_end, s.note, s.effective_to, true
      into tail_days, tail_start, tail_end, tail_note, tail_to, tail_found
      from public.employee_schedules s
     where s.employee_id = p_employee
       and s.effective_from <= p_to
       and (s.effective_to is null or s.effective_to >= p_to)
     order by s.effective_from desc
     limit 1;
  end if;

  -- A schedule that started earlier and runs into this one ends the day before.
  update public.employee_schedules
     set effective_to = p_from - 1
   where employee_id = p_employee
     and effective_from < p_from
     and (effective_to is null or effective_to >= p_from);

  -- Anything wholly inside the new range is replaced by it.
  delete from public.employee_schedules
   where employee_id = p_employee
     and effective_from >= p_from
     and (p_to is null or (effective_to is not null and effective_to <= p_to));

  if p_to is null then
    -- An open-ended change supersedes everything after it.
    delete from public.employee_schedules
     where employee_id = p_employee and effective_from >= p_from;
  else
    -- One that starts inside the range but carries on past it gives up its head.
    update public.employee_schedules
       set effective_from = p_to + 1
     where employee_id = p_employee
       and effective_from between p_from and p_to
       and (effective_to is null or effective_to > p_to);
  end if;

  insert into public.employee_schedules
    (employee_id, effective_from, effective_to, working_days, shift_start, shift_end, note, created_by)
  values
    (p_employee, p_from, p_to, coalesce(p_days, '{0,1,2,3,4,6}'::smallint[]),
     p_start, p_end, p_note, auth.uid());

  -- Put back what a temporary change interrupted. Nothing to restore when they
  -- had no schedule covering that date in the first place.
  if p_to is not null
     and tail_found
     and (tail_to is null or tail_to > p_to)
     and not exists (
       select 1 from public.employee_schedules
        where employee_id = p_employee and effective_from = p_to + 1
     )
  then
    insert into public.employee_schedules
      (employee_id, effective_from, effective_to, working_days, shift_start, shift_end, note, created_by)
    values
      (p_employee, p_to + 1, tail_to, tail_days, tail_start, tail_end, tail_note, auth.uid());
  end if;
end $$;

comment on function public.set_schedule(uuid, date, date, smallint[], time, time, text) is
  'Set an employee''s working days and hours from a date, optionally until one. Closes the schedule in force, opens the new one, and restores the previous one after a temporary change - in a single transaction, so nobody is ever left without a schedule.';

grant execute on function public.set_schedule(uuid, date, date, smallint[], time, time, text) to authenticated;
