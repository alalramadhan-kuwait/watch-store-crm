-- shopify-sync products every morning, after lightspeed-products-sync (05:35 UTC) so the links use
-- that day's Lightspeed names; 06:20 picks up an export that was not ready in time (it reuses an
-- export from the last three hours). The sync key is read at run time, not stored in the job.
select cron.unschedule(jobname) from cron.job where jobname in ('shopify-products-sync', 'shopify-products-sync-retry');
select cron.schedule('shopify-products-sync', '50 5 * * *', $job$
  select net.http_post(
    url := 'https://ttshgrujnycapugrmyxs.supabase.co/functions/v1/shopify-sync',
    headers := jsonb_build_object('x-sync-key', (select sync_key from public.lightspeed_auth where id = 1), 'Content-Type', 'application/json'),
    body := '{"action":"products"}'::jsonb,
    timeout_milliseconds := 150000)
$job$);
select cron.schedule('shopify-products-sync-retry', '20 6 * * *', $job$
  select net.http_post(
    url := 'https://ttshgrujnycapugrmyxs.supabase.co/functions/v1/shopify-sync',
    headers := jsonb_build_object('x-sync-key', (select sync_key from public.lightspeed_auth where id = 1), 'Content-Type', 'application/json'),
    body := '{"action":"products"}'::jsonb,
    timeout_milliseconds := 150000)
$job$);
