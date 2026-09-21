-- The view answers a stranger with nothing, not an error.
--
-- cases_visible asks who the caller is before it decides anything. With no
-- session at all — the anon key, a health probe — those helpers return null
-- and the policy returns no rows, which is the right answer. They had been
-- withheld from anon, so the question itself failed with "permission denied"
-- instead. Nothing is revealed either way; this only makes the empty answer
-- a clean one.
grant execute on function public.my_employee_id(), public.my_scope_codes() to anon;
