-- Salesmen (roles 'sales' and 'staff') work the shops. Online and WhatsApp sales are not
-- theirs to read: not the company totals, and not the individual sales.
-- Admin, manager, operations and marketing are unaffected.

-- 1. The rows themselves. A RESTRICTIVE policy narrows the permissive select policy
--    (it never widens it), and lightspeed_sale_items follows through its own policy.
create policy ls_sales_shops_only_for_sellers on public.lightspeed_sales
  as restrictive for select to authenticated
  using (
    coalesce(public.get_my_role(), '') not in ('sales', 'staff')
    or exists (select 1 from public.outlets o where o.code = lightspeed_sales.scope_code and o.kind = 'physical')
  );

-- 2. The shop figures on Today / Home. store_day_sales is SECURITY DEFINER, so RLS does not
--    apply inside it: the digital channels are left out of its base for everyone but
--    admin and manager, which also empties the 'channels' list for a salesman.
-- 3. lightspeed_today (invoker) only lists channels for admin and manager.
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.store_day_sales(text,date,date)'::regprocedure);
  n := replace(d, E'and o.sells\n',
       E'and o.sells\n       and (o.kind = ''physical'' or me.role in (''admin'', ''manager''))\n');
  if n = d then raise exception 'store_day_sales: pattern not found'; end if;
  execute n;

  d := pg_get_functiondef('public.lightspeed_today(text)'::regprocedure);
  n := replace(d, 'case when coalesce(p_outlet, '''') <> '''' then ',
       'case when coalesce(p_outlet, '''') <> '''' or coalesce(public.get_my_role(), '''') not in (''admin'', ''manager'') then ');
  if n = d then raise exception 'lightspeed_today: pattern not found'; end if;
  execute n;
end $$;
