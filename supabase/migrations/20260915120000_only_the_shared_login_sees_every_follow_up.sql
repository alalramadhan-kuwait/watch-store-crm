-- A salesperson's reach over follow-ups must not depend on a field being filled in.
--
-- The rule read "if this login has no DSR name, let it act on any open
-- follow-up", which was written for the one shared shop account. It is a
-- description of the shared account by accident, not on purpose: any personal
-- login whose sales_name has not been set yet matches it too.
--
-- That is not hypothetical. Two salespeople were given logins with the DSR name
-- left blank, and both could see and act on the whole shop's pipeline — the
-- screen offered them a colleague filter, and the database would have allowed
-- the write.
--
-- The escape now names the shared account by its role instead. Owners and
-- managers are untouched: they have their own full-update policies.

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
          get_my_role() = 'staff'               -- the shared shop account, by role
          or staff = get_my_sales_name()        -- their own, by roster name
          or created_by = auth.uid()            -- or they logged it themselves
        )
      )
    )
  )
  with check (
    get_my_role() = any (array['staff', 'sales'])
    and deleted = false
    and (
      (created_by = auth.uid() and day_locked = false)
      -- no status test here: closing a follow-up as Won/Lost writes a new
      -- status and must still pass. Ownership is re-checked on the new row, so
      -- a personal login cannot hand a follow-up to someone else.
      or (
        case_type = 'Follow-up'
        and (
          get_my_role() = 'staff'
          or staff = get_my_sales_name()
          or created_by = auth.uid()
        )
      )
    )
  );

comment on function public.get_my_sales_name() is
  'DSR roster name of the calling login (profiles.sales_name). Null on the shared shop login, and on a personal login whose DSR name has not been set — which is why the follow-up policy tests the role for the shared account rather than testing this for null.';
