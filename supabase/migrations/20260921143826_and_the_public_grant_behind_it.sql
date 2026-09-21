-- And the public grant behind it.
--
-- Four Stage C1/C2 functions were never revoked from PUBLIC, so revoking
-- from anon alone left anon able to call them through PUBLIC. Shut both.
revoke all on function public.customer_by_phone(text) from public, anon;
revoke all on function public.log_outlet_change(text, text, uuid) from public, anon;
revoke all on function public.log_whatsapp_handoff(uuid, text, text, uuid, uuid) from public, anon;
revoke all on function public.attributed_employee(uuid) from public, anon;
grant execute on function public.customer_by_phone(text) to authenticated;
grant execute on function public.log_outlet_change(text, text, uuid) to authenticated;
grant execute on function public.log_whatsapp_handoff(uuid, text, text, uuid, uuid) to authenticated;
grant execute on function public.attributed_employee(uuid) to authenticated;