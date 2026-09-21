-- The door is shut to anyone not signed in.
--
-- Supabase grants EXECUTE on every new function to anon, authenticated and
-- service_role by default, so "revoke from public" alone leaves the
-- anonymous role able to call the Stage C definer functions. Each of them
-- checks who is calling, but a stranger with the publishable key should not
-- be able to ask at all — least of all whether a phone number is known.
-- raise_occasion_reminders is the cron's alone. The four pure helpers get a
-- fixed search_path like everything else.

revoke execute on function public.customer_by_phone(text) from anon;
revoke execute on function public.lightspeed_today(text) from anon;
revoke execute on function public.roster_employees() from anon;
revoke execute on function public.customer_known_by(uuid) from anon;
revoke execute on function public.customer_list() from anon;
revoke execute on function public.customer_profile(uuid) from anon;
revoke execute on function public.log_outlet_change(text, text, uuid) from anon;
revoke execute on function public.log_whatsapp_handoff(uuid, text, text, uuid, uuid) from anon;
revoke execute on function public.attributed_employee(uuid) from anon;
revoke execute on function public.occasion_reminders_due(integer[]) from anon;
revoke execute on function public.occasion_recipients(uuid) from anon;
revoke execute on function public.upcoming_occasions(integer) from anon;
revoke execute on function public.raise_occasion_reminders(integer[]) from anon, authenticated;

alter function public.lightspeed_sale_counts() set search_path = public, pg_temp;
alter function public.render_template(text, jsonb) set search_path = public, pg_temp;
alter function public.message_for(text, text, jsonb) set search_path = public, pg_temp;
alter function public.next_occurrence(integer, integer, date) set search_path = public, pg_temp;