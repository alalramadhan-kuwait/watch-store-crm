-- Stock analyst: cache the per-product metrics so the Ask chat answers fast.
--
-- Every calculation the chat uses starts from stock_analyst_metrics(), which
-- reads a year of sales and all stock (about 1.5 s alone). Several at once
-- passed the API's 8 s statement limit in testing. Sales are counted through
-- yesterday and stock changes only with the morning sync, so the result for a
-- given day is the same all day: it is now computed once an hour and kept as
-- one row per day and stock location, read back in milliseconds.
--
-- A cached copy is used only when it was computed from the stock sync that is
-- in the table now (stock_synced_at = max(lightspeed_stock.synced_at)); after
-- a new sync, and for any day or outlet not cached, the live calculation runs
-- as before. Results are identical either way.
--
-- Additive: the original function is kept, renamed stock_analyst_metrics_live,
-- with its body and grants unchanged; stock_analyst_metrics becomes a wrapper
-- with the same signature. The refresh only inserts or replaces its own row;
-- nothing is deleted.

alter function public.stock_analyst_metrics(date, text) rename to stock_analyst_metrics_live;

create table public.stock_analyst_metrics_cache (
  as_of           date        not null,
  outlet_key      text        not null,           -- Lightspeed stock location, or 'all'
  stock_synced_at timestamptz,                    -- the stock sync the rows were computed from
  computed_at     timestamptz not null default now(),
  products        integer     not null,
  rows            jsonb       not null,           -- stock_analyst_metrics_live() as a JSON array
  primary key (as_of, outlet_key)
);
alter table public.stock_analyst_metrics_cache enable row level security;
revoke all on public.stock_analyst_metrics_cache from public, anon, authenticated;

create function public.stock_analyst_metrics(p_as_of date default null, p_outlet text default null)
returns table (
  product_id text, name text, brand text, supplier text, product_type text, ownership text,
  stock_basis text, on_hand numeric, negative_units numeric, by_outlet jsonb,
  cost numeric, price numeric, stock_cost_value numeric, stock_retail_value numeric, on_order numeric,
  u30 numeric, u90 numeric, u180 numeric, u365 numeric, rev90 numeric, rev180 numeric, rev365 numeric,
  first_sale date, last_sale date, last_receipt_order date, best_month_share numeric, product_created date,
  pace numeric, cover_months numeric, sell_through numeric, margin numeric, discount numeric,
  shelf_days integer, months_on_sale numeric, class text, class_basis text
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare d date := coalesce(p_as_of, (now() at time zone 'Asia/Kuwait')::date - 1);
        k text := coalesce(stock_outlet_name(p_outlet), 'all');
        synced timestamptz := (select max(synced_at) from lightspeed_stock);
        cached jsonb;
begin
  perform stock_analyst_guard();
  select c.rows into cached from stock_analyst_metrics_cache c
   where c.as_of = d and c.outlet_key = k and c.stock_synced_at = synced;
  if cached is null then
    return query select * from stock_analyst_metrics_live(d, p_outlet);
    return;
  end if;
  return query select * from jsonb_to_recordset(cached) as r (
    product_id text, name text, brand text, supplier text, product_type text, ownership text,
    stock_basis text, on_hand numeric, negative_units numeric, by_outlet jsonb,
    cost numeric, price numeric, stock_cost_value numeric, stock_retail_value numeric, on_order numeric,
    u30 numeric, u90 numeric, u180 numeric, u365 numeric, rev90 numeric, rev180 numeric, rev365 numeric,
    first_sale date, last_sale date, last_receipt_order date, best_month_share numeric, product_created date,
    pace numeric, cover_months numeric, sell_through numeric, margin numeric, discount numeric,
    shelf_days integer, months_on_sale numeric, class text, class_basis text);
end $$;

-- Recompute yesterday's metrics for the whole business and each stock location.
create function public.stock_analyst_refresh_cache() returns jsonb
language plpgsql security definer set search_path = public as $$
declare d date := (now() at time zone 'Asia/Kuwait')::date - 1;
        synced timestamptz := (select max(synced_at) from lightspeed_stock);
        o text; k text; done jsonb := '{}'; n int;
begin
  perform stock_analyst_guard();
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
end $$;

revoke all on function public.stock_analyst_metrics(date, text) from public, anon, authenticated;
revoke all on function public.stock_analyst_refresh_cache() from public, anon, authenticated;
grant execute on function public.stock_analyst_metrics(date, text) to service_role;
grant execute on function public.stock_analyst_refresh_cache() to service_role;

-- every hour at :50; the 05:50 UTC run picks up the 05:00 stock sync
select cron.schedule('stock-analyst-cache', '50 * * * *', $$select public.stock_analyst_refresh_cache()$$);
