-- The store manager's feed was everything addressed to "manager".
--
-- That is fifteen of the twenty-six event types, and the mix is badly wrong for
-- somebody standing in a shop. Counting what actually reached him: fifty-six
-- purchase-order notifications, seven account creations, seven geofence edits,
-- five project updates, three role changes, two settings changes — against
-- fifteen employee requests. Four fifths of his feed was work he cannot do from
-- a shop floor.
--
-- A notification he cannot act on is worse than no notification: it teaches him
-- the bell is noise, and the one that needed him is then the one he misses.
--
-- So the database now says which event types belong on the shop floor at all.
-- This is deliberately separate from audience_roles, which is unchanged: the
-- back office still shows Eman every purchase order, because at a desk that is
-- her job. What changes is only what reaches a phone in a shop.

alter table public.notification_settings
  add column if not exists shop_floor boolean not null default false;

comment on column public.notification_settings.shop_floor is
  'Whether this event type belongs in the DSR (shop floor) notification feed. False keeps it to the back office. Separate from audience_roles, which decides who may see it at all.';

/* What a store manager can actually act on, standing in a shop:
   a request from one of his people waiting on his approval; a reminder that one
   has waited too long; a request taken back so he stops working on it; a
   decision on his own request; a task assigned to him by name. */
update public.notification_settings
   set shop_floor = true
 where event_type in (
   'req_new',        -- needs his first approval
   'req_reminder',   -- it has been waiting; addressed to him by name
   'req_withdrawn',  -- stop: the employee took it back
   'leave_new',      -- needs his first approval
   'req_decided',    -- his own request was settled (person-addressed)
   'leave_decided',  -- his own leave was settled (person-addressed)
   'task_new'        -- assigned to him by name
 );

/* Everything else stays in the back office. Named rather than left to the
   default so the list is a decision on the record, not an accident. */
update public.notification_settings
   set shop_floor = false
 where event_type in (
   'po_new', 'po_pay', 'po_ship', 'po_status',      -- purchasing: not his to act on
   'consign_status',                                 -- back-office consignments
   'lp_new', 'lp_status',                            -- projects
   'acct_new', 'acct_del', 'acct_role',              -- account administration
   'emp_new', 'emp_portal_off',                      -- HR administration
   'geofence', 'settings_upd',                       -- configuration
   'att_in', 'att_out',                              -- already disabled, admin-only
   'req_stage'                                       -- tells the OWNER the manager approved
 );

/* repair_status and preorder_arrived are left off deliberately, and it is worth
   saying why rather than letting it look like an oversight. A repair that is
   ready, or a pre-order that has landed, plausibly IS shop-floor work — but
   repair_watches and waiting_list carry no outlet, only an assigned person, so
   there is no way to send either to the right shop. Broadcasting them to every
   manager is exactly what this migration exists to stop. The honest fix is to
   address them to assigned_to and staff_responsible by name, which means
   changing those triggers, and is its own piece of work. */

/* The shop floor reads this rather than hard-coding a list, so adding an event
   type in future is one row and not a release of both apps. */
create or replace function public.shop_floor_events()
returns setof text
language sql stable
set search_path to 'public', 'pg_temp'
as $$
  select event_type from public.notification_settings
   where shop_floor and enabled
$$;

grant execute on function public.shop_floor_events() to authenticated;
