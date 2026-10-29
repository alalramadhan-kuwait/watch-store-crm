-- One owner list: financials follow stock_ai_access (the owners, as Ask Mohammed / Marketing do).
create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.stock_ai_access where user_id = auth.uid());
$$;
drop table public.fin_owners;
