-- Instagram keys are expired; the owners asked to stop the "numbers stopped updating" alert until they fix it.
-- The syncs keep retrying on their own, so data resumes once the keys are replaced.
-- To turn the alert back on: update public.notification_settings set enabled = true where event_type = 'instagram_sync_failed';
update public.notification_settings set enabled = false where event_type = 'instagram_sync_failed';
update public.notifications set opened_at = coalesce(opened_at, now()) where event_type = 'instagram_sync_failed';
