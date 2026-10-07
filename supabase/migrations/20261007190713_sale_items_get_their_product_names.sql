-- The sales sync named each sold line from lightspeed_stock, but read that table in one request, and the API
-- returns at most 1,000 rows; the stock snapshot has ~9,500. So most lines were stored with no name, sku or brand
-- and the day report printed "Item". Fill every empty line whose product is in the stock snapshot. Lines whose
-- product is not in the snapshot (retired products, services) are named by the sync from Lightspeed, a few
-- products per run.
update public.lightspeed_sale_items i
   set name  = coalesce(i.name, st.name),
       sku   = coalesce(i.sku, st.sku),
       brand = coalesce(i.brand, st.brand)
  from (select distinct on (product_id) product_id, name, sku, brand
          from public.lightspeed_stock
         where name is not null
         order by product_id, synced_at desc) st
 where st.product_id = i.product_id
   and i.name is null;
