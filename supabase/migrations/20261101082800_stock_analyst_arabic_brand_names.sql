-- Ask Mohammed: brand names written in Arabic letters.
-- name_skeleton() reduces a name in Arabic or Latin letters to its consonant sounds
-- (كوليكيوم and Kollokium both give "klkm"), and find_products() now returns `did_you_mean`
-- brands when nothing matched, so a brand typed in Arabic is found instead of guessed.

create or replace function public.name_skeleton(p_text text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select regexp_replace(
    translate(
      replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        translate(lower(coalesce(p_text, '')), 'àáâãäåèéêëìíîïòóôõöùúûüýÿñç', 'aaaaaaeeeeiiiiooooouuuuyyns'),
        'تش', 'ش'), 'tch', 'ش'), 'ch', 'ش'), 'sh', 'ش'), 'ph', 'f'), 'th', 't'), 'ck', 'k'), 'kh', 'h'), 'gh', 'g'),
        'qu', 'k'), 'ce', 's'), 'ci', 's'), 'cy', 's'), 'x', 'ks'),
      -- consonants mapped to one sound each (ق and ج sit next to k and j: Gulf speech says ق as g),
      -- then vowels, long-vowel letters, hamza, ع, digits and punctuation dropped
      'كقجغسصثزظذشتطدضلرمنبفهحخcqgzpvaeiouywاأإآىيوةءئؤع''’`-_.,/()&+0123456789 ',
      'kkjjsstssscttddlrmnbfhhhkkjsbf'),
    '(.)\1+', '\1', 'g')
$$;

create or replace function public.text_edit_distance(a text, b text)
returns integer language plpgsql immutable parallel safe set search_path = '' as $$
declare m int := length(a); n int := length(b); prev int[]; cur int[]; i int; j int;
begin
  if m = 0 then return n; end if;
  if n = 0 then return m; end if;
  prev := array(select generate_series(0, n));
  for i in 1..m loop
    cur := array[i];
    for j in 1..n loop
      cur := cur || least(prev[j + 1] + 1, cur[j] + 1, prev[j] + case when substr(a, i, 1) = substr(b, j, 1) then 0 else 1 end);
    end loop;
    prev := cur;
  end loop;
  return prev[n + 1];
end $$;

revoke execute on function public.name_skeleton(text) from public, anon, authenticated;
revoke execute on function public.text_edit_distance(text, text) from public, anon, authenticated;
grant execute on function public.name_skeleton(text) to service_role;
grant execute on function public.text_edit_distance(text, text) to service_role;

create or replace function public.find_products(p_text text, p_limit integer default 10)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare words text[]; res jsonb;
begin
  perform stock_analyst_guard();
  words := array(select w from regexp_split_to_table(lower(trim(coalesce(p_text, ''))), '\s+') w where length(w) > 0);
  if array_length(words, 1) is null then return jsonb_build_object('matches', '[]'::jsonb, 'ambiguous', false); end if;
  with c as (
    select lp.product_id, lp.name, lp.brand, lp.product_type, lp.ownership, lp.sku,
           coalesce((select sum(greatest(stock_on_hand, 0)) from lightspeed_stock s where s.product_id = lp.product_id), 0) stock
      from lightspeed_products lp
     where coalesce(lp.ownership, 'unknown') <> 'service' and lp.has_inventory is not false
       and (select bool_and(lower(coalesce(lp.name, '') || ' ' || coalesce(lp.sku, '') || ' ' || coalesce(lp.brand, '')) like '%' || w || '%')
              from unnest(words) w)
  )
  select jsonb_build_object(
    'query', p_text,
    'matches', (select jsonb_agg(x) from (select product_id, name, brand, product_type, ownership, stock from c
                 order by (stock > 0) desc, name limit least(greatest(coalesce(p_limit, 10), 1), 30)) x),
    'total', (select count(*) from c),
    'types_matched', (select jsonb_agg(distinct coalesce(product_type, 'Type not set')) from c),
    'ambiguous', (select count(*) > 1 from c)
  ) into res;

  -- Nothing matched: offer the brands that sound like a word of the query (Arabic or Latin letters).
  if (res->>'total')::int = 0 then
    res := res || jsonb_build_object('did_you_mean', coalesce((
      with b as (select distinct brand from lightspeed_products where brand is not null and coalesce(ownership, 'unknown') <> 'service'),
      bw as (select brand, name_skeleton(w) s from b, regexp_split_to_table(brand, '\s+') w where length(name_skeleton(w)) >= 2
             union select brand, name_skeleton(brand) from b),
      q as (select w, name_skeleton(w) qs from unnest(words) w where length(name_skeleton(w)) >= 2),
      d as (select q.w word, bw.brand, min(text_edit_distance(q.qs, bw.s)) dist, max(length(q.qs)) qlen from q, bw group by q.w, bw.brand)
      select jsonb_agg(jsonb_build_object('word', word, 'brand', brand, 'sounds_alike', dist = 0) order by dist, brand)
        from (select * from d where dist = 0 or (dist = 1 and qlen >= 3) or (dist = 2 and qlen >= 6)
               order by dist, brand limit 5) x), '[]'::jsonb),
      'note', 'No product matched these words. did_you_mean lists brands whose name sounds like a word of the query; search again with the brand name in English.');
  end if;
  return res;
end $function$;
