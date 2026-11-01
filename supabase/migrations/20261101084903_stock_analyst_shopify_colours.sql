-- Ask Mohammed: dial colour and other watch details from the online shop.
-- Lightspeed names rarely say the colour; the Shopify product pages do (the dial colour,
-- case and strap material behind the shop's filters). shopify-sync copies them into
-- shopify_products, shopify_products_finish() ties each one to its Lightspeed product by
-- brand and model name (or SKU), and find_products() searches and returns them, so
-- "Kollokium البيضة" looks for a white dial. Read-only towards Shopify.

create table if not exists public.shopify_products (
  shopify_id text primary key,                 -- gid://shopify/Product/…
  handle text not null,
  title text not null,
  vendor text,
  status text,                                 -- ACTIVE, DRAFT, ARCHIVED
  product_type text,
  tags text[] not null default '{}',
  skus text[] not null default '{}',
  price numeric(12, 3),
  dial_color text,
  case_material text,
  strap_material text,
  movement text,
  case_shape text,
  crystal text,
  series text,
  case_diameter_mm numeric,
  water_resistance_m integer,
  attributes jsonb not null default '{}',      -- every watch.* field, references read as their labels
  lightspeed_product_id text,
  shopify_updated_at timestamptz,
  synced_at timestamptz not null default now()
);
create index if not exists shopify_products_lightspeed_idx on public.shopify_products (lightspeed_product_id);
alter table public.shopify_products enable row level security;
revoke all on public.shopify_products from anon, authenticated;
comment on table public.shopify_products is
  'The online shop''s products with their watch details (dial colour, materials), copied by shopify-sync. Read-only copy; linked to lightspeed_products by shopify_products_finish().';

-- A name reduced to letters and digits, for matching the shop to Lightspeed
-- ('Projekt 01 - variant "H"' and 'Projekt 01 Variant H' give the same key).
create or replace function public.tk_name_key(p_text text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select regexp_replace(translate(lower(coalesce(p_text, '')), 'àáâãäåèéêëìíîïòóôõöùúûüýÿñç', 'aaaaaaeeeeiiiiooooouuuuyyns'),
                        '[^a-z0-9]', '', 'g')
$$;

-- A colour word in English or Arabic (with or without ال, masculine or feminine, Kuwaiti
-- spellings) as the shop's colour code (white, black, mother-of-pearl…); null when it is not one.
create or replace function public.colour_word(p_word text)
returns text language sql immutable parallel safe set search_path = '' as $$
  with n as (select regexp_replace(translate(lower(coalesce(p_word, '')), 'أإآةىء', 'اااهي'), '^(وال|بال|لل|ال)', '') w)
  select case
    when w in ('white', 'ابيض', 'بيضا', 'بيضه', 'بيض') then 'white'
    when w in ('black', 'اسود', 'سودا', 'سوده', 'سود') then 'black'
    when w in ('blue', 'navy', 'ازرق', 'زرقا', 'زرقه', 'زرق', 'كحلي', 'كحليه') then 'blue'
    when w in ('green', 'olive', 'اخضر', 'خضرا', 'خضره', 'خضر', 'زيتي', 'زيتيه') then 'green'
    when w in ('red', 'burgundy', 'احمر', 'حمرا', 'حمره', 'حمر', 'عنابي', 'عنابيه') then 'red'
    when w in ('grey', 'gray', 'رمادي', 'رماديه', 'رصاصي', 'رصاصيه') then 'grey'
    when w in ('silver', 'فضي', 'فضيه') then 'silver'
    when w in ('gold', 'golden', 'ذهبي', 'ذهبيه') then 'gold'
    when w in ('yellow', 'اصفر', 'صفرا', 'صفره', 'صفر') then 'yellow'
    when w in ('orange', 'برتقالي', 'برتقاليه') then 'orange'
    when w in ('purple', 'violet', 'بنفسجي', 'بنفسجيه', 'موف') then 'purple'
    when w in ('brown', 'بني', 'بنيه') then 'brown'
    when w in ('pink', 'وردي', 'ورديه', 'زهري', 'زهريه') then 'pink'
    when w in ('turquoise', 'tiffany', 'تركواز', 'تركوازي', 'فيروزي', 'فيروزيه', 'تيفاني') then 'turquoise'
    when w in ('salmon', 'سلموني', 'سلمونيه') then 'salmon'
    when w in ('sand', 'beige', 'رملي', 'رمليه', 'بيج') then 'sand'
    when w in ('mother-of-pearl', 'mop', 'pearl', 'صدف', 'صدفي', 'صدفيه') then 'mother-of-pearl'
    when w in ('multicolour', 'multicolor', 'rainbow', 'ملون', 'ملونه', 'الوان') then 'multicolour'
    when w in ('transparent', 'شفاف', 'شفافه') then 'transparent'
  end from n
$$;

-- The shop's colour label as a colour code ('Mother of pearl' -> 'mother-of-pearl').
create or replace function public.colour_code(p_label text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select nullif(trim(both '-' from regexp_replace(lower(coalesce(p_label, '')), '[^a-z]+', '-', 'g')), '')
$$;

-- shopify-sync writes a page of products at a time (rows shaped like the table).
create or replace function public.shopify_products_upsert(p_rows jsonb)
returns integer language sql security invoker set search_path = 'public' as $$
  with r as (
    insert into shopify_products as t (shopify_id, handle, title, vendor, status, product_type, tags, skus, price,
           dial_color, case_material, strap_material, movement, case_shape, crystal, series, case_diameter_mm,
           water_resistance_m, attributes, shopify_updated_at, synced_at)
    select x.shopify_id, x.handle, x.title, x.vendor, x.status, x.product_type, coalesce(x.tags, '{}'), coalesce(x.skus, '{}'),
           x.price, x.dial_color, x.case_material, x.strap_material, x.movement, x.case_shape, x.crystal, x.series,
           x.case_diameter_mm, x.water_resistance_m, coalesce(x.attributes, '{}'), x.shopify_updated_at, now()
      from jsonb_to_recordset(p_rows) x(shopify_id text, handle text, title text, vendor text, status text, product_type text,
           tags text[], skus text[], price numeric, dial_color text, case_material text, strap_material text, movement text,
           case_shape text, crystal text, series text, case_diameter_mm numeric, water_resistance_m integer,
           attributes jsonb, shopify_updated_at timestamptz)
    on conflict (shopify_id) do update set handle = excluded.handle, title = excluded.title, vendor = excluded.vendor,
           status = excluded.status, product_type = excluded.product_type, tags = excluded.tags, skus = excluded.skus,
           price = excluded.price, dial_color = excluded.dial_color, case_material = excluded.case_material,
           strap_material = excluded.strap_material, movement = excluded.movement, case_shape = excluded.case_shape,
           crystal = excluded.crystal, series = excluded.series, case_diameter_mm = excluded.case_diameter_mm,
           water_resistance_m = excluded.water_resistance_m, attributes = excluded.attributes,
           shopify_updated_at = excluded.shopify_updated_at, synced_at = now()
    returning 1)
  select count(*)::int from r
$$;

-- After a full read: drop products the shop no longer has, then link each product to Lightspeed.
-- A Lightspeed SKU on a shop variant wins; otherwise the same brand and the same model name.
create or replace function public.shopify_products_finish(p_started timestamptz)
returns jsonb language plpgsql security invoker set search_path = 'public' as $$
declare removed int;
begin
  delete from shopify_products where synced_at < p_started;
  get diagnostics removed = row_count;
  with ls as (
    select product_id, sku, tk_name_key(brand) bk, tk_name_key(name) nk,
           tk_name_key(replace(lower(name), lower(coalesce(brand, '')), '')) mk
      from lightspeed_products where coalesce(ownership, 'unknown') <> 'service'),
  sp as (
    select shopify_id, skus, tk_name_key(vendor) vk,
           tk_name_key(replace(lower(title), lower(coalesce(vendor, '')), '')) mk from shopify_products),
  cand as (
    select sp.shopify_id, ls.product_id, 1 pri from sp join ls on ls.sku = any(sp.skus)
    union all
    select sp.shopify_id, ls.product_id, 2 from sp join ls on ls.nk <> '' and ls.nk = any(array(select tk_name_key(s) from unnest(sp.skus) s))
    union all
    select sp.shopify_id, ls.product_id, 3 from sp join ls on sp.vk = ls.bk and sp.mk = ls.mk and sp.mk <> ''),
  best as (select distinct on (shopify_id) shopify_id, product_id from cand order by shopify_id, pri, product_id)
  update shopify_products t set lightspeed_product_id = b.product_id
    from (select s.shopify_id, best.product_id from shopify_products s left join best using (shopify_id)) b
   where t.shopify_id = b.shopify_id and t.lightspeed_product_id is distinct from b.product_id;
  return jsonb_build_object('removed', removed,
    'products', (select count(*) from shopify_products),
    'linked', (select count(*) from shopify_products where lightspeed_product_id is not null),
    'with_dial_colour', (select count(*) from shopify_products where dial_color is not null),
    'linked_with_dial_colour', (select count(*) from shopify_products where dial_color is not null and lightspeed_product_id is not null));
end $$;

revoke execute on function public.tk_name_key(text) from public, anon, authenticated;
revoke execute on function public.colour_word(text) from public, anon, authenticated;
revoke execute on function public.colour_code(text) from public, anon, authenticated;
revoke execute on function public.shopify_products_upsert(jsonb) from public, anon, authenticated;
revoke execute on function public.shopify_products_finish(timestamptz) from public, anon, authenticated;
grant execute on function public.tk_name_key(text) to service_role;
grant execute on function public.colour_word(text) to service_role;
grant execute on function public.colour_code(text) to service_role;
grant execute on function public.shopify_products_upsert(jsonb) to service_role;
grant execute on function public.shopify_products_finish(timestamptz) to service_role;

-- find_products: also searches the shop's watch details, reads colour words (English or Arabic)
-- as the dial colour, and returns each match's details from the shop. When a colour finds
-- nothing, same_without_colour lists what the other words match, with their colours.
create or replace function public.find_products(p_text text, p_limit integer default 10)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare words text[]; plain text[]; colours text[]; res jsonb; lim int := least(greatest(coalesce(p_limit, 10), 1), 30);
begin
  perform stock_analyst_guard();
  words := array(select w from regexp_split_to_table(lower(trim(coalesce(p_text, ''))), '\s+') w where length(w) > 0);
  if array_length(words, 1) is null then return jsonb_build_object('matches', '[]'::jsonb, 'ambiguous', false); end if;
  colours := array(select distinct colour_word(w) from unnest(words) w where colour_word(w) is not null);
  plain := array(select w from unnest(words) w where colour_word(w) is null);

  with base as materialized (
    select lp.product_id, lp.name, lp.brand, lp.product_type, lp.ownership,
           coalesce((select sum(greatest(stock_on_hand, 0)) from lightspeed_stock s where s.product_id = lp.product_id), 0) stock,
           sp.dial_color, sp.case_material, sp.strap_material, sp.movement, sp.case_diameter_mm,
           case when sp.status = 'ACTIVE' then 'https://time-keeper.com/products/' || sp.handle end shop_url,
           lower(concat_ws(' ', lp.name, lp.sku, lp.brand, sp.dial_color, sp.case_material, sp.strap_material, sp.movement, sp.series)) hay,
           colour_code(sp.dial_color) colour
      from lightspeed_products lp
      left join lateral (select * from shopify_products s where s.lightspeed_product_id = lp.product_id
                          order by (s.status = 'ACTIVE') desc, (s.dial_color is not null) desc, s.shopify_id limit 1) sp on true
     where coalesce(lp.ownership, 'unknown') <> 'service' and lp.has_inventory is not false
       and (select coalesce(bool_and(lower(concat_ws(' ', lp.name, lp.sku, lp.brand, sp.dial_color, sp.case_material, sp.strap_material,
                                                     sp.movement, sp.series)) like '%' || w || '%'), true) from unnest(plain) w)),
  c as (
    select * from base
     -- a colour matches the shop's dial colour, or the colour named in the product's own name or materials
     where (select coalesce(bool_and(colour = k or hay like '%' || replace(k, '-', ' ') || '%'), true) from unnest(colours) k))
  select jsonb_build_object(
    'query', p_text,
    'colours', to_jsonb(colours),
    'matches', (select jsonb_agg(x) from (select product_id, name, brand, product_type, ownership, stock, dial_color,
                 case_material, strap_material, movement, case_diameter_mm, shop_url from c
                 order by (stock > 0) desc, name limit lim) x),
    'total', (select count(*) from c),
    'types_matched', (select jsonb_agg(distinct coalesce(product_type, 'Type not set')) from c),
    'ambiguous', (select count(*) > 1 from c),
    -- the colour found nothing: what the other words match, with the colour of each
    'same_without_colour', case when array_length(colours, 1) is not null and array_length(plain, 1) is not null
                                 and not exists (select 1 from c) then
      (select jsonb_agg(x) from (select product_id, name, brand, stock, dial_color, shop_url from base
         order by (stock > 0) desc, name limit lim) x) end
  ) into res;

  if jsonb_typeof(res->'same_without_colour') = 'array' then
    res := res || jsonb_build_object('colour_note', 'No product matched that colour. same_without_colour lists the products the other words match, with the dial colour the online shop gives (null when the shop does not record it).');
  else
    res := res - 'same_without_colour';
  end if;

  -- Nothing matched: offer the brands that sound like a word of the query (Arabic or Latin letters).
  if (res->>'total')::int = 0 and not res ? 'same_without_colour' then
    res := res || jsonb_build_object('did_you_mean', coalesce((
      with b as (select distinct brand from lightspeed_products where brand is not null and coalesce(ownership, 'unknown') <> 'service'),
      bw as (select brand, name_skeleton(w) s from b, regexp_split_to_table(brand, '\s+') w where length(name_skeleton(w)) >= 2
             union select brand, name_skeleton(brand) from b),
      q as (select w, name_skeleton(w) qs from unnest(plain) w where length(name_skeleton(w)) >= 2),
      d as (select q.w word, bw.brand, min(text_edit_distance(q.qs, bw.s)) dist, max(length(q.qs)) qlen from q, bw group by q.w, bw.brand)
      select jsonb_agg(jsonb_build_object('word', word, 'brand', brand, 'sounds_alike', dist = 0) order by dist, brand)
        from (select * from d where dist = 0 or (dist = 1 and qlen >= 3) or (dist = 2 and qlen >= 6)
               order by dist, brand limit 5) x), '[]'::jsonb),
      'note', 'No product matched these words. did_you_mean lists brands whose name sounds like a word of the query; search again with the brand name in English.');
  end if;
  return res;
end $function$;
