-- Sales are logged against a short roster name (cases.staff = 'Fadi'); HR and
-- attendance use the full legal name ('Fadi Hussain'). To show a salesperson's
-- hours beside their sales the two have to be joined, and the existing link —
-- profiles.sales_name — only exists for people who have a login. Three of the
-- five salespeople do not.
--
-- This column lives on the HR record, which every employee has, and says which
-- roster name that person sells under. profiles.sales_name keeps its own job:
-- what a LOGIN files its sales as, and whose follow-up board it narrows to.
alter table public.employees
  add column if not exists dsr_staff_name text;

comment on column public.employees.dsr_staff_name is
  'The settings.staff_roster name this person logs sales under (cases.staff). Joins HR/attendance to sales. null = not on the shop roster.';

create unique index if not exists employees_dsr_staff_name_key
  on public.employees (dsr_staff_name) where dsr_staff_name is not null;

-- Seed the five salespeople plus Eman, who is also on the roster. Each spelling
-- below was matched by hand against settings.staff_roster; none is ambiguous.
update public.employees set dsr_staff_name = 'Fadi'         where full_name = 'Fadi Hussain'   and dsr_staff_name is null;
update public.employees set dsr_staff_name = 'Hussein Deeb' where full_name = 'Hussain Dib'    and dsr_staff_name is null;
update public.employees set dsr_staff_name = 'Ahmad Khalaf' where full_name = 'Ahmed Khalaf'   and dsr_staff_name is null;
update public.employees set dsr_staff_name = 'Ahmad Ysari'  where full_name = 'Ahmed Yasari'   and dsr_staff_name is null;
update public.employees set dsr_staff_name = 'Raneen'       where full_name = 'Ranin Al Samad' and dsr_staff_name is null;
update public.employees set dsr_staff_name = 'Eman'         where full_name = 'Eman Salman'    and dsr_staff_name is null;
