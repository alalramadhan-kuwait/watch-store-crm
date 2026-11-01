-- shopify_products_finish: a last pass for names worded differently ("Su" = "Raketa Su - 0331",
-- "Modello Tre U3-AEG" = "Modello Tre U3-AEG Limited Edition - Chronograph"). Within the same brand,
-- every word of the shop title (brand words and in/and/the/of/x/with/edition/limited/watch/a/de/di/le/la
-- left out) must be in the Lightspeed name; the pair with the fewest extra words wins, and only when
-- it is the single best for both sides. Only products still unlinked after the other rules take part.
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
  tok as materialized (
    select lp.product_id, tk_name_key(lp.brand) bk, t.ord, t.w
      from lightspeed_products lp, regexp_split_to_table(lp.name, '[\s\-–—_/()]+') with ordinality t(w, ord)
     where coalesce(lp.ownership, 'unknown') <> 'service' and t.w <> ''),
  runs as materialized (
    select distinct a.product_id, a.bk,
           tk_name_key(string_agg(b.w, '') over (partition by a.product_id, a.ord order by b.ord)) k
      from tok a join tok b on b.product_id = a.product_id and b.ord between a.ord and a.ord + 3),
  sp as materialized (
    select shopify_id, tk_name_key(vendor) vk,
           tk_name_key(replace(lower(title), lower(coalesce(vendor, '')), '')) mk from shopify_products),
  sk as materialized (
    select shopify_id, s sku, tk_name_key(s) skey from shopify_products, unnest(skus) s),
  refs as materialized (
    select distinct shopify_id, tk_name_key(vendor) vk, tk_name_key(r) k
      from shopify_products, unnest(skus || coalesce(array[attributes->>'reference'], '{}')) r),
  cand as (
    select sk.shopify_id, ls.product_id, 1 pri from sk join ls on ls.sku = sk.sku
    union all
    select sk.shopify_id, ls.product_id, 2 from sk join ls on ls.nk = sk.skey where sk.skey <> ''
    union all
    select refs.shopify_id, runs.product_id, 3 from refs join runs on runs.k = refs.k
     where length(refs.k) >= 5 and refs.k ~ '[0-9]' and (refs.vk like runs.bk || '%' or runs.bk like refs.vk || '%')
    union all
    select sp.shopify_id, ls.product_id, 4 from sp join ls on sp.vk = ls.bk and sp.mk = ls.mk where sp.mk <> ''),
  best as (select distinct on (shopify_id) shopify_id, product_id from cand order by shopify_id, pri, product_id)
  update shopify_products t set lightspeed_product_id = best.product_id
    from shopify_products s left join best using (shopify_id)
   where t.shopify_id = s.shopify_id and t.lightspeed_product_id is distinct from best.product_id;

  with stop as (select unnest(array['in','and','the','of','x','with','edition','limited','watch','a','de','di','le','la']) w),
  lw as materialized (
    select lp.product_id, tk_name_key(lp.brand) bk,
           array(select distinct w from regexp_split_to_table(lower(translate(lp.name, '’''"', '')), '[^a-z0-9]+') w
                  where w <> '' and w not in (select w from stop)
                    and (position(w in tk_name_key(lp.brand)) = 0 or w ~ '[0-9]')) ws
      from lightspeed_products lp
     where coalesce(lp.ownership, 'unknown') <> 'service'
       and not exists (select 1 from shopify_products x where x.lightspeed_product_id = lp.product_id)),
  sw as materialized (
    select shopify_id, tk_name_key(vendor) vk,
           array(select distinct w from regexp_split_to_table(lower(translate(title, '’''"', '')), '[^a-z0-9]+') w
                  where w <> '' and w not in (select w from stop) and position(w in tk_name_key(vendor)) = 0) ws
      from shopify_products where lightspeed_product_id is null),
  pair as (
    select sw.shopify_id, lw.product_id, cardinality(array(select unnest(lw.ws) except select unnest(sw.ws))) extra
      from sw join lw on lw.bk <> '' and (sw.vk like lw.bk || '%' or lw.bk like sw.vk || '%')
                     and cardinality(sw.ws) > 0 and sw.ws <@ lw.ws),
  rs as (
    select *, rank() over (partition by shopify_id order by extra) r1, count(*) over (partition by shopify_id, extra) c1,
              rank() over (partition by product_id order by extra) r2, count(*) over (partition by product_id, extra) c2
      from pair)
  update shopify_products t set lightspeed_product_id = rs.product_id
    from rs where rs.shopify_id = t.shopify_id and r1 = 1 and c1 = 1 and r2 = 1 and c2 = 1;

  return jsonb_build_object('removed', removed,
    'products', (select count(*) from shopify_products),
    'linked', (select count(*) from shopify_products where lightspeed_product_id is not null),
    'with_dial_colour', (select count(*) from shopify_products where dial_color is not null),
    'linked_with_dial_colour', (select count(*) from shopify_products where dial_color is not null and lightspeed_product_id is not null));
end $$;
