-- The sales sync looks for sale lines still missing their product name
-- (name is null, product_id set), newest first. With no index it scanned and
-- sorted all ~30,000 lines every run (~0.8 s, every 10 minutes). Almost every
-- line has a name, so a partial index over only the unnamed ones stays tiny
-- and answers that question directly.
create index if not exists lightspeed_sale_items_unnamed_idx
  on public.lightspeed_sale_items (synced_at desc)
  where name is null and product_id is not null;
