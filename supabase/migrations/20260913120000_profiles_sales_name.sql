-- The DSR roster name this login records sales under (cases.staff).
-- Must equal an entry of settings.staff_roster; null = shared login / not a
-- salesperson (the DSR then shows its staff dropdown as before).
-- The HR name stays in profiles.full_name / employees.full_name, so history
-- logged as "Fadi" stays continuous when the person's login is "Fadi Hussain".
alter table public.profiles add column if not exists sales_name text;

comment on column public.profiles.sales_name is
  'DSR staff-roster name this login logs sales under (cases.staff). Must match settings.staff_roster. null = uses the dropdown.';

-- one login per roster name
create unique index if not exists profiles_sales_name_key
  on public.profiles (sales_name) where sales_name is not null;
