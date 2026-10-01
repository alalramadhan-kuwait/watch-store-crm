-- The owner's starting point for the weekly WhatsApp target is 5 customers (1 Oct 2026),
-- down from the 20 seeded in 20261001133704. Only the four salespeople have one.
update public.weekly_contact_targets set target_customers = 5, updated_at = now();
