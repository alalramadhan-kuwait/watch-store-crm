-- DSR Customers: find the customers who bought a brand, or asked about it, and WhatsApp them.
-- Everything runs under the caller's own rules (security invoker), exactly like customer_list():
-- a salesperson reaches only the customers, visits and credited sales they may already see,
-- a manager their shops, the owner everyone. Nothing is written except one new message template.

-- The name matchers are pure functions; the brand lists below call them as the signed-in user.
grant execute on function public.name_skeleton(text) to authenticated;
grant execute on function public.tk_name_key(text) to authenticated;

-- One row per brand a customer bought (Lightspeed sale lines) or asked about (a follow-up or a
-- lost sale logged with a brand). A brand typed on a visit is read as the Lightspeed brand it
-- names ("Deluges" = Delugs, "WMT Watches" = WMT, "Dvo" = DVO - Italia); one that names none
-- keeps its own spelling. "Other"/"Others" is not a brand.
create or replace function public.customer_brand_rows()
returns table(customer_id uuid, brand text, source text, qty numeric, kd numeric, at timestamptz, model text)
language sql stable security invoker set search_path = public, pg_temp as $$
  with bought as (
    select c.id customer_id, trim(i.brand) brand, 'bought'::text source, i.quantity::numeric qty,
           i.price_total::numeric kd, s.sale_date::timestamptz at, i.name model
      from public.customers c
      join public.lightspeed_customers lc on lc.phone_e164 = c.phone_e164
      join public.lightspeed_sales s on s.customer_id = lc.id
                                    and s.status = any(public.lightspeed_sale_counts()) and s.return_for is null
      join public.lightspeed_sale_items i on i.sale_id = s.id and not coalesce(i.is_return, false)
     where nullif(trim(i.brand), '') is not null),
  canon as (select distinct brand, public.name_skeleton(brand) sk, public.tk_name_key(brand) k from bought),
  asked as (
    select cs.customer_id, trim(cs.brand) raw, cs.interaction_at at, nullif(trim(cs.product), '') model
      from public.cases cs
     where not cs.deleted and cs.customer_id is not null and cs.case_type in ('Follow-up', 'Lost Sale')
       and nullif(trim(cs.brand), '') is not null and lower(trim(cs.brand)) not in ('other', 'others'))
  select customer_id, brand, source, qty, kd, at, model from bought
  union all
  select a.customer_id,
         coalesce((select cb.brand from canon cb
                    where cb.sk = public.name_skeleton(a.raw)
                       or (length(public.tk_name_key(a.raw)) >= 3
                           and (cb.k like public.tk_name_key(a.raw) || '%' or public.tk_name_key(a.raw) like cb.k || '%'))
                    order by (cb.sk = public.name_skeleton(a.raw)) desc, length(cb.brand) limit 1), a.raw),
         'asked', null, null, a.at, a.model
    from asked a
$$;

-- The brand picker: per brand, how many of the caller's customers bought it and asked about it,
-- what they spent on it, and the brand's sound (name_skeleton) so an Arabic search finds it.
create or replace function public.customer_brand_counts()
returns table(brand text, bought bigint, asked bigint, kd numeric, skeleton text)
language sql stable security invoker set search_path = public, pg_temp as $$
  select r.brand,
         count(distinct r.customer_id) filter (where r.source = 'bought'),
         count(distinct r.customer_id) filter (where r.source = 'asked'),
         coalesce(sum(r.kd) filter (where r.source = 'bought'), 0),
         public.name_skeleton(r.brand)
    from public.customer_brand_rows() r
   group by r.brand
   order by 2 desc, 3 desc, 1
$$;

-- The customers for one brand: pieces and KD bought, the last purchase, up to three model
-- names, the last time they asked about it, and the last WhatsApp the caller may see being
-- opened for them (so a list worked through today does not message anyone twice).
-- Ordered by customer id so it can be read a page at a time.
create or replace function public.brand_customers(p_brand text)
returns table(customer_id uuid, pieces numeric, kd numeric, last_bought timestamptz, models text[],
              asked_at timestamptz, last_whatsapp timestamptz)
language sql stable security invoker set search_path = public, pg_temp as $$
  select r.customer_id,
         coalesce(sum(r.qty) filter (where r.source = 'bought'), 0),
         coalesce(sum(r.kd) filter (where r.source = 'bought'), 0),
         max(r.at) filter (where r.source = 'bought'),
         (array_agg(distinct r.model) filter (where r.source = 'bought' and r.model is not null))[1:3],
         max(r.at) filter (where r.source = 'asked'),
         (select max(h.created_at) from public.whatsapp_handoffs h where h.customer_id = r.customer_id)
    from public.customer_brand_rows() r
   where r.brand = p_brand
   group by r.customer_id
   order by r.customer_id
$$;

revoke execute on function public.customer_brand_rows() from public, anon;
revoke execute on function public.customer_brand_counts() from public, anon;
revoke execute on function public.brand_customers(text) from public, anon;
grant execute on function public.customer_brand_rows() to authenticated, service_role;
grant execute on function public.customer_brand_counts() to authenticated, service_role;
grant execute on function public.brand_customers(text) to authenticated, service_role;

-- The message a salesperson sends a brand's customers; {{product}} carries the brand's name.
-- Admins can reword it like any other template.
insert into public.message_templates (key, lang, title, body, active) values
  ('brand_news', 'en', 'New from the brand',
   'Hello {{first_name}}, this is {{salesperson}} from Time Keeper {{store}}. We have new pieces from {{product}} and I thought of you. Shall I send you some photos?', true),
  ('brand_news', 'ar', 'جديد الماركة',
   'السلام عليكم {{first_name}}، معك {{salesperson}} من تايم كيبر {{store}}. وصلنا جديد {{product}} وتذكرتك. تحب أرسل لك الصور؟', true)
on conflict (key, lang) do nothing;
