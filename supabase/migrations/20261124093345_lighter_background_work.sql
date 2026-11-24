-- After the 23 Nov stall: take recurring weight off the database.
--
-- 1. The stock assistant's cache was rebuilt every hour (about 15 s of work each
--    time) although the stock it is built from changes about once a day. It now
--    rebuilds only when yesterday's figures are missing, the stock was synced again
--    since the last build, or the last build is over six hours old.
create or replace function public.stock_analyst_refresh_cache()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare d date := (now() at time zone 'Asia/Kuwait')::date - 1;
        synced timestamptz := (select max(synced_at) from lightspeed_stock);
        o text; k text; done jsonb := '{}'; n int;
        last record;
begin
  perform stock_analyst_guard();
  select stock_synced_at, computed_at into last
    from stock_analyst_metrics_cache where as_of = d and outlet_key = 'all';
  if found and last.stock_synced_at is not distinct from synced and last.computed_at > now() - interval '6 hours' then
    return jsonb_build_object('as_of', d, 'stock_synced_at', synced, 'skipped', 'nothing changed since ' || last.computed_at);
  end if;
  foreach o in array array['', 'avenues', 'time_gallery', 'hq'] loop
    k := coalesce(stock_outlet_name(nullif(o, '')), 'all');
    insert into stock_analyst_metrics_cache (as_of, outlet_key, stock_synced_at, computed_at, products, rows)
    select d, k, synced, now(), count(*), coalesce(jsonb_agg(to_jsonb(m)), '[]')
      from stock_analyst_metrics_live(d, nullif(o, '')) m
    on conflict (as_of, outlet_key) do update
      set stock_synced_at = excluded.stock_synced_at, computed_at = excluded.computed_at,
          products = excluded.products, rows = excluded.rows
    returning products into n;
    done := done || jsonb_build_object(k, n);
  end loop;
  return jsonb_build_object('as_of', d, 'stock_synced_at', synced, 'products', done);
end $function$;

-- 2. The background-job run log was never cleared (265,000 rows, 114 MB since July,
--    mostly the 30-second notification job). A nightly job keeps one week; its first
--    run clears the backlog.
select cron.schedule('cron-history-purge', '40 0 * * *',
  $$delete from cron.job_run_details where start_time < now() - interval '7 days'$$);
