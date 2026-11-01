-- find_products: a piece whose dial colour the shop does not record no longer matches a colour,
-- and colour_not_recorded lists the in-stock pieces of that kind whose colour is unknown.
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
     where (select coalesce(bool_and(coalesce(colour = k, false) or hay like '%' || replace(k, '-', ' ') || '%'), true) from unnest(colours) k))
  select jsonb_build_object(
    'query', p_text,
    'colours', to_jsonb(colours),
    'matches', (select jsonb_agg(x) from (select product_id, name, brand, product_type, ownership, stock, dial_color,
                 case_material, strap_material, movement, case_diameter_mm, shop_url from c
                 order by (stock > 0) desc, name limit lim) x),
    'total', (select count(*) from c),
    'types_matched', (select jsonb_agg(distinct coalesce(product_type, 'Type not set')) from c),
    'ambiguous', (select count(*) > 1 from c),
    -- asked for a colour: in-stock pieces the other words match whose colour the shop does not record
    'colour_not_recorded', case when array_length(colours, 1) is not null then
      (select jsonb_agg(x) from (select product_id, name, brand, stock from base
         where colour is null and stock > 0 and not exists (select 1 from c where c.product_id = base.product_id)
         order by name limit lim) x) end,
    -- the colour found nothing: what the other words match, with the colour of each
    'same_without_colour', case when array_length(colours, 1) is not null and array_length(plain, 1) is not null
                                 and not exists (select 1 from c) then
      (select jsonb_agg(x) from (select product_id, name, brand, stock, dial_color, shop_url from base
         order by (stock > 0) desc, name limit lim) x) end
  ) into res;

  if jsonb_typeof(res->'colour_not_recorded') is distinct from 'array' then res := res - 'colour_not_recorded'; end if;
  if jsonb_typeof(res->'same_without_colour') = 'array' then
    res := (res - 'colour_not_recorded') || jsonb_build_object('colour_note', 'No product matched that colour. same_without_colour lists the products the other words match, with the dial colour the online shop gives (null when the shop does not record it).');
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
