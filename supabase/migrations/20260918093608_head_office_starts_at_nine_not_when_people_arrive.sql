-- Head office starts at 09:00. The hour of grace is why people walk in at ten.
--
-- The HQ schedules were set from the clock-in record — their own notes said so:
-- "Set from the clock-in record: typical 10:0x to 18:0x". That is behaviour,
-- not policy, and recording behaviour as policy made the app forgive the very
-- thing it was derived from. A 10:00 start plus the company's hour of grace
-- meant nobody at head office was late until 11:00, so fourteen of Ali Akbar's
-- eighteen mornings scored as on time.
--
-- The rule is that head office works from nine and the grace hour is what makes
-- arriving by ten acceptable. Anything after 10:00 is late — and that falls out
-- of a 09:00 start with the ordinary hour on top, not out of a special zero
-- grace on one person, which was treating the symptom and would have left three
-- colleagues on the wrong deadline.
--
-- Finishing times are left alone. Those were observed too, but when somebody
-- leaves is not in dispute, and 18:00 is what these people actually work to.

update public.employee_schedules s
   set shift_start = time '09:00',
       grace_minutes = null,          -- the company hour, like everybody else
       note = 'Head office: works from 09:00, on time until 10:00 with the standard hour of grace'
  from public.employees e
 where e.id = s.employee_id
   and e.location = 'Timekeeper HQ'
   and s.effective_to is null
   and s.shift_start is not null;
