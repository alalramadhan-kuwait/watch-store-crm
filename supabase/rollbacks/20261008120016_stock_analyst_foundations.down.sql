-- Not a migration: run only on a decision to undo 20261008120016_stock_analyst_foundations.
-- Rollback for the stock analyst Phase 1 migration (stock_analyst_foundations).
-- Removes only what that migration added; nothing that existed before it is touched.
-- It deletes the snapshots, product types, budget ledger and chat history collected
-- since, so run it only on a decision to undo Phase 1.
-- Also redeploy lightspeed-products-sync as a 410 stub (functions cannot be deleted
-- through the tools; the dashboard can).
select cron.unschedule(jobid) from cron.job
 where jobname in ('lightspeed-products-sync', 'stock-snapshot', 'stock-snapshot-retry');

drop table if exists public.ai_feedback, public.ai_messages, public.ai_conversations,
  public.ai_usage_ledger, public.ai_settings, public.stock_ai_access,
  public.lightspeed_stock_snapshots, public.stock_analyst_runs, public.lightspeed_products;

drop function if exists public.ai_budget_settle(bigint, numeric, integer, integer, integer, integer, boolean);
drop function if exists public.ai_budget_reserve(text, text, text, numeric, uuid, uuid);
drop function if exists public.ai_budget_status();
drop function if exists public.stock_ai_allowed();
drop function if exists public.take_stock_snapshot();
drop function if exists public.stock_ownership(text);
