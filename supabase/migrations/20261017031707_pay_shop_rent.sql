-- Monthly rent per shop, for the owners. Kept like salaries: one row per change,
-- never edited, the newest row on or before a date is the rent then.
-- Lives in the pay schema, which only the database owner can read, so staff
-- logins never see it.
create table pay.rents (
  id bigint generated always as identity primary key,
  scope_code text not null references public.outlets(code),
  effective_from date not null,
  monthly_rent numeric(12,3) not null check (monthly_rent >= 0),
  paid_every_months int not null default 1 check (paid_every_months between 1 and 12),
  note text,
  set_by_name text,
  at timestamptz not null default now()
);
create index rents_scope_from on pay.rents (scope_code, effective_from desc);
create trigger rents_keep_history before update or delete on pay.rents
  for each row execute function pay.forbid_change();
