-- Part 1 of the gaps found testing the DSR as a salesman (4 Oct 2026).
-- Anyone holding the public (anon) key could run functions that send notifications, create
-- tasks, burn case numbers or read the roster: functions created later had inherited EXECUTE
-- for PUBLIC. They are now closed to anon, and new functions are closed by default.
-- admin_soft_delete_case / admin_update_case also failed OPEN for a stranger: get_my_role() is
-- NULL for someone not signed in, and NULL <> 'admin' is not true, so the guard never fired.
do $$
declare f text;
begin
  for f in
    select p.oid::regprocedure::text
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prosecdef
       and p.proname in (
         'admin_soft_delete_case','admin_update_case','apply_schedule_change','lp_close_task','lp_generate_tasks',
         'lp_upsert_task','mark_notification_opened','next_case_id','notify_event','remind_overdue_requests',
         'remind_request','send_po_daily','set_schedule','set_weekly_contact_target','set_weekly_target',
         'lightspeed_reconcile_log','roster_arabic_names','store_day','store_day_sales','team_week_contacts',
         'team_week_sales','follow_up_sale_matches','case_contact_for_edit','attendance_on_day','workflow_guard')
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  -- cron / edge-function work only: no reason for a signed-in user to call these directly
  for f in
    select p.oid::regprocedure::text from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('send_po_daily','remind_overdue_requests','lp_generate_tasks','lightspeed_reconcile_log')
  loop
    execute format('revoke execute on function %s from authenticated', f);
  end loop;
end $$;

alter default privileges in schema public revoke execute on functions from public, anon;

do $$
declare f text; def text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname in ('admin_soft_delete_case','admin_update_case')
  loop
    def := pg_get_functiondef(f::regprocedure);
    def := replace(def, 'get_my_role() <>', 'coalesce(get_my_role(), '''') <>');
    execute def;
  end loop;
end $$;
