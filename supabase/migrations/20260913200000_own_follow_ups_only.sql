-- A personal salesperson login may only act on its own follow-ups.
--
-- The UPDATE policy let any floor login change ANY open follow-up, no
-- ownership test at all. The DSR only shows a personal login its own, so the
-- restriction was the screen rather than the rule.
--
-- Ownership is matched on the roster name, exactly as the app does it: a
-- salesperson's follow-ups were logged under the shared shop account long
-- before they had a login of their own, so created_by alone would lock them
-- out of their own board.
--
-- The shared shop login (sales_name is null) is deliberately unchanged: it is
-- how the other salespeople work, its board shows every follow-up, and its
-- reach has to match what it is shown.

create or replace function public.get_my_sales_name()
  returns text
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select sales_name from public.profiles where id = auth.uid()
$$;

comment on function public.get_my_sales_name() is
  'DSR roster name of the calling login (profiles.sales_name); null on the shared shop login.';

drop policy if exists "Staff can update own unlocked cases" on public.cases;
create policy "Staff can update own unlocked cases"
  on public.cases for update to public
  using (
    get_my_role() = any (array['staff', 'sales'])
    and deleted = false
    and (
      (created_by = auth.uid() and day_locked = false)
      or (
        case_type = 'Follow-up' and status = 'Open'
        and (
          get_my_sales_name() is null          -- shared shop login: unchanged
          or staff = get_my_sales_name()       -- their own, by roster name
          or created_by = auth.uid()           -- or they logged it themselves
        )
      )
    )
  )
  with check (
    get_my_role() = any (array['staff', 'sales'])
    and deleted = false
    and (
      (created_by = auth.uid() and day_locked = false)
      -- no status test here: closing a follow-up as Won/Lost is an update that
      -- writes a new status, and it must still pass. Ownership is re-checked on
      -- the new row, so a personal login cannot hand a follow-up to someone else.
      or (
        case_type = 'Follow-up'
        and (
          get_my_sales_name() is null
          or staff = get_my_sales_name()
          or created_by = auth.uid()
        )
      )
    )
  );
