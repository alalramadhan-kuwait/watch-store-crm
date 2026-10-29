-- Owner-only financial reports database (monthly accountant reports).
create table public.fin_owners (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.fin_owners enable row level security;
create policy fin_owners_self_read on public.fin_owners for select to authenticated using (user_id = (select auth.uid()));

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.fin_owners where user_id = auth.uid());
$$;
revoke all on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated;

create table public.fin_reports (
  period date primary key,
  file_name text,
  commentary jsonb not null default '[]',
  issues jsonb not null default '[]',
  top_products jsonb not null default '[]',
  top_customers jsonb not null default '[]',
  top_suppliers jsonb not null default '[]',
  imported_at timestamptz not null default now()
);

create table public.fin_lines (
  id bigserial primary key,
  period date not null,
  report_period date not null references public.fin_reports(period) on delete cascade,
  statement text not null,
  outlet text not null default 'Total',
  section text,
  account text not null,
  kind text not null default 'actual',
  amount numeric not null,
  sort int
);
create index fin_lines_period_idx on public.fin_lines (period, statement);

alter table public.fin_reports enable row level security;
alter table public.fin_lines enable row level security;
create policy fin_reports_owner on public.fin_reports for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy fin_lines_owner on public.fin_lines for all to authenticated using (public.is_owner()) with check (public.is_owner());
revoke all on public.fin_reports, public.fin_lines, public.fin_owners from anon;

-- fin_owners was filled with the three owner accounts directly in the database (replaced by stock_ai_access in the next migration).
