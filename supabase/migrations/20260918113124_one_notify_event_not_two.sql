-- Clocking in was refused with "function notify_event(...) is not unique".
--
-- Adding the outlet argument was written as CREATE OR REPLACE with a defaulted
-- ninth parameter. A different signature is not a replacement: Postgres kept the
-- old eight-argument function and added a second nine-argument one beside it.
-- Because the ninth has a default, an eight-argument call matched both, and
-- Postgres will not guess — so every trigger still calling the old shape failed,
-- including the one that fires on clock-in.
--
-- That is an outage, not a cosmetic fault: the shop floor could not clock in,
-- and the error surfaced in the employee's own portal. The nine-argument
-- version does everything the old one did, with the outlet defaulting to null,
-- so the duplicate goes.
--
-- The lesson, for the next time a function grows an argument: CREATE OR REPLACE
-- only replaces when the signature matches. Adding a parameter, even a defaulted
-- one, creates an overload — and a defaulted overload is ambiguous with the
-- original for every existing caller.

drop function if exists public.notify_event(text, text, text, text, text[], uuid, uuid, text);
