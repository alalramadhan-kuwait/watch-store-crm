-- Faster row-level security, with the same rules.
--
-- 1. Reading Lightspeed sale lines checked each line against "is this sale in
--    the set of sales I may see", which built that whole set (every sale, with
--    the seller check run per row) on every read: about 1.9 s to show the items
--    of one day's sales. The line is now checked against its own sale only.
-- 2. The sellers' shop check on lightspeed_sales called get_my_role() once per
--    row; it is now worked out once per query.
-- 3. The policies the database advisor flags (auth_rls_initplan) called
--    auth.uid() / auth.role() / get_my_role() / get_my_sales_name() once per
--    row. Each call is now a sub-select, which Postgres evaluates once per
--    query. Nothing else in any expression changed.
--
-- Checked before applying, inside a rolled-back transaction: for admin, both
-- managers, a salesperson, the shared shop login, marketing and operations,
-- the visible row count of every affected table (and lightspeed_sales,
-- lightspeed_sale_items, cases) was identical before and after, 273 of 273.

alter policy ls_items_select on public.lightspeed_sale_items
  using (exists (select 1 from public.lightspeed_sales s where s.id = lightspeed_sale_items.sale_id));

alter policy ls_sales_shops_only_for_sellers on public.lightspeed_sales
  using ((coalesce((select public.get_my_role()), '') <> all (array['sales','staff']))
         or exists (select 1 from public.outlets o where o.code = lightspeed_sales.scope_code and o.kind = 'physical'));

alter policy own_conversations on public.ai_conversations
  using (((user_id = (select auth.uid())) AND stock_ai_allowed()));

alter policy own_feedback_change on public.ai_feedback
  using (((user_id = (select auth.uid())) AND stock_ai_allowed()))
  with check (((user_id = (select auth.uid())) AND stock_ai_allowed()));

alter policy own_feedback_read on public.ai_feedback
  using (((user_id = (select auth.uid())) AND stock_ai_allowed()));

alter policy own_feedback_write on public.ai_feedback
  with check (((user_id = (select auth.uid())) AND stock_ai_allowed() AND (EXISTS ( SELECT 1
   FROM (ai_messages m
     JOIN ai_conversations c ON ((c.id = m.conversation_id)))
  WHERE ((m.id = ai_feedback.message_id) AND (m.role = 'assistant'::text) AND (c.user_id = (select auth.uid())))))));

alter policy own_messages on public.ai_messages
  using ((stock_ai_allowed() AND (EXISTS ( SELECT 1
   FROM ai_conversations c
  WHERE ((c.id = ai_messages.conversation_id) AND (c.user_id = (select auth.uid())))))));

alter policy tasks_own_read on public.assigned_tasks
  using ((assignee_employee_id IN ( SELECT employees.id
   FROM employees
  WHERE (employees.user_id = (select auth.uid())))));

alter policy tasks_own_update on public.assigned_tasks
  using ((assignee_employee_id IN ( SELECT employees.id
   FROM employees
  WHERE (employees.user_id = (select auth.uid())))))
  with check (((status = ANY (ARRAY['Open'::text, 'Done'::text])) AND (assignee_employee_id IN ( SELECT employees.id
   FROM employees
  WHERE (employees.user_id = (select auth.uid()))))));

alter policy managers_read on public.attendance_records
  using ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = (select auth.uid())) AND (profiles.role = ANY (ARRAY['admin'::text, 'manager'::text, 'hr'::text]))))));

alter policy own_all on public.attendance_records
  using (((select auth.uid()) = user_id))
  with check (((select auth.uid()) = user_id));

alter policy own_insert on public.attendance_records
  with check (((select auth.uid()) = user_id));

alter policy own_select on public.attendance_records
  using (((select auth.uid()) = user_id));

alter policy own_update on public.attendance_records
  using (((select auth.uid()) = user_id))
  with check (((select auth.uid()) = user_id));

alter policy "Staff can update own unlocked cases" on public.cases
  using ((((select get_my_role()) = ANY (ARRAY['staff'::text, 'sales'::text])) AND (deleted = false) AND (((created_by = (select auth.uid())) AND (day_locked = false)) OR ((case_type = 'Follow-up'::text) AND (status = 'Open'::text) AND (((select get_my_role()) = 'staff'::text) OR (staff = (select get_my_sales_name())) OR (created_by = (select auth.uid())))))))
  with check ((((select get_my_role()) = ANY (ARRAY['staff'::text, 'sales'::text])) AND (deleted = false) AND (((created_by = (select auth.uid())) AND (day_locked = false)) OR ((case_type = 'Follow-up'::text) AND (((select get_my_role()) = 'staff'::text) OR (staff = (select get_my_sales_name())) OR (created_by = (select auth.uid())))))));

alter policy read_authed_ct on public.content_tasks
  using (((select auth.role()) = 'authenticated'::text));

alter policy own_req on public.employee_requests
  using ((user_id = (select auth.uid())));

alter policy own_req_amend on public.employee_requests
  using (((user_id = (select auth.uid())) AND (status = 'Pending'::text)))
  with check (((user_id = (select auth.uid())) AND (status = ANY (ARRAY['Pending'::text, 'Withdrawn'::text]))));

alter policy own_req_insert on public.employee_requests
  with check (((user_id = (select auth.uid())) AND (status = 'Pending'::text)));

alter policy sched_read on public.employee_schedules
  using ((((select get_my_role()) = ANY (ARRAY['admin'::text, 'manager'::text, 'hr'::text])) OR (employee_id IN ( SELECT employees.id
   FROM employees
  WHERE (employees.user_id = (select auth.uid()))))));

alter policy own_read_emp on public.employees
  using (((user_id = (select auth.uid())) OR (lower(TRIM(BOTH FROM full_name)) = ( SELECT lower(TRIM(BOTH FROM profiles.full_name)) AS lower
   FROM profiles
  WHERE (profiles.id = (select auth.uid()))))));

alter policy follow_up_sale_checks_insert on public.follow_up_sale_checks
  with check ((answered_by = (select auth.uid())));

alter policy follow_up_sale_checks_read on public.follow_up_sale_checks
  using (((answered_by = (select auth.uid())) OR ((select get_my_role()) = ANY (ARRAY['admin'::text, 'manager'::text]))));

alter policy follow_up_sale_checks_update on public.follow_up_sale_checks
  using ((answered_by = (select auth.uid())))
  with check ((answered_by = (select auth.uid())));

alter policy read_authed_geo on public.geofences
  using (((select auth.role()) = 'authenticated'::text));

alter policy read_authed_influencers on public.influencer_campaigns
  using (((select auth.role()) = 'authenticated'::text));

alter policy read_authed_infc on public.influencer_collaborations
  using (((select auth.role()) = 'authenticated'::text));

alter policy read_authed_infs on public.influencer_follower_snapshots
  using (((select auth.role()) = 'authenticated'::text));

alter policy read_authed_inf on public.influencers
  using (((select auth.role()) = 'authenticated'::text));

alter policy read_authed_igd on public.instagram_daily
  using (((select auth.role()) = 'authenticated'::text));

alter policy read_authed_igm on public.instagram_media
  using (((select auth.role()) = 'authenticated'::text));

alter policy read_authed_igposts on public.instagram_posts
  using (((select auth.role()) = 'authenticated'::text));

alter policy read_authed_igl on public.instagram_sync_log
  using (((select auth.role()) = 'authenticated'::text));

alter policy own_insert_leave on public.leave_records
  with check (((approval_status = 'Pending'::text) AND (employee_id IN ( SELECT employees.id
   FROM employees
  WHERE (employees.user_id = (select auth.uid()))))));

alter policy own_read_leave on public.leave_records
  using ((employee_id IN ( SELECT employees.id
   FROM employees
  WHERE ((employees.user_id = (select auth.uid())) OR (lower(TRIM(BOTH FROM employees.full_name)) = ( SELECT lower(TRIM(BOTH FROM profiles.full_name)) AS lower
           FROM profiles
          WHERE (profiles.id = (select auth.uid()))))))));

alter policy own_update_leave on public.leave_records
  using (((approval_status = ANY (ARRAY['Pending'::text, 'Approved'::text])) AND (employee_id IN ( SELECT employees.id
   FROM employees
  WHERE (employees.user_id = (select auth.uid()))))))
  with check (((approval_status = ANY (ARRAY['Pending'::text, 'Cancelled'::text])) AND (employee_id IN ( SELECT employees.id
   FROM employees
  WHERE (employees.user_id = (select auth.uid()))))));

alter policy read_authed_sales on public.lightspeed_product_sales
  using (((select auth.role()) = 'authenticated'::text));

alter policy read_authed_sales_daily on public.lightspeed_sales_daily
  using (((select auth.role()) = 'authenticated'::text));

alter policy read_authed on public.lightspeed_stock
  using (((select auth.role()) = 'authenticated'::text));

alter policy read_authed_hist on public.lightspeed_stock_value_history
  using (((select auth.role()) = 'authenticated'::text));

alter policy read_authed_log on public.lightspeed_sync_log
  using (((select auth.role()) = 'authenticated'::text));

alter policy nr_own on public.notification_reads
  using (((select auth.uid()) = user_id))
  with check (((select auth.uid()) = user_id));

alter policy notif_read on public.notifications
  using ((((select auth.uid()) = person_user_id) OR ((audience_roles IS NOT NULL) AND ((select get_my_role()) = ANY (audience_roles)) AND notification_in_my_scope(event_type, audience_outlet))));

alter policy read_authed_ads on public.paid_ads
  using (((select auth.role()) = 'authenticated'::text));

alter policy "Users can update their own profile" on public.profiles
  using ((id = (select auth.uid())));

alter policy read_authed_po_items on public.purchase_order_items
  using (((select auth.role()) = 'authenticated'::text));

alter policy push_sub_own on public.push_subscriptions
  using (((select auth.uid()) = user_id))
  with check (((select auth.uid()) = user_id));

alter policy read_authed_repairs on public.repair_watches
  using (((select auth.role()) = 'authenticated'::text));

alter policy own_insert_activity on public.user_activity
  with check ((user_id = (select auth.uid())));
