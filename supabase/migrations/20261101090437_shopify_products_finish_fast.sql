-- shopify_products_finish: link through plain equality joins on precomputed keys (one row per
-- shop SKU), so it runs in well under the 8 s limit on the full shop; same rules and order as before.
create or replace function public.shopify_products_finish(p_started timestamptz)
returns jsonb language plpgsql security invoker set search_path = 'public' as $$
declare removed int;
begin
  delete from shopify_products where synced_at < p_started;
  get diagnostics removed = row_count;
  with ls as materialized (
    select product_id, sku, tk_name_key(brand) bk, tk_name_key(name) nk,
           tk_name_key(replace(lower(name), lower(coalesce(brand, '')), '')) mk
      from lightspeed_products where coalesce(ownership, 'unknown') <> 'service'),
  sp as materialized (
    select shopify_id, tk_name_key(vendor) vk,
           tk_name_key(replace(lower(title), lower(coalesce(vendor, '')), '')) mk from shopify_products),
  sk as materialized (
    select shopify_id, s sku, tk_name_key(s) skey from shopify_products, unnest(skus) s),
  cand as (
    select sk.shopify_id, ls.product_id, 1 pri from sk join ls on ls.sku = sk.sku
    union all
    select sk.shopify_id, ls.product_id, 2 from sk join ls on ls.nk = sk.skey where sk.skey <> ''
    union all
    select sp.shopify_id, ls.product_id, 3 from sp join ls on sp.vk = ls.bk and sp.mk = ls.mk where sp.mk <> ''),
  best as (select distinct on (shopify_id) shopify_id, product_id from cand order by shopify_id, pri, product_id)
  update shopify_products t set lightspeed_product_id = best.product_id
    from shopify_products s left join best using (shopify_id)
   where t.shopify_id = s.shopify_id and t.lightspeed_product_id is distinct from best.product_id;
  return jsonb_build_object('removed', removed,
    'products', (select count(*) from shopify_products),
    'linked', (select count(*) from shopify_products where lightspeed_product_id is not null),
    'with_dial_colour', (select count(*) from shopify_products where dial_color is not null),
    'linked_with_dial_colour', (select count(*) from shopify_products where dial_color is not null and lightspeed_product_id is not null));
end $$;
