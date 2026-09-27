-- Marketing Overview: what the ads push, next to what sells.
--
-- The new first page of Media & Marketing. The weekly scoreboard still comes
-- from growth_review(); marketing_overview() adds:
--
--   daily    the review week day by day: Meta spend (Meta's Los Angeles days)
--            beside online and WhatsApp sales (Kuwait days);
--   pushing  for 7, 30 or 90 days, ad spend split three ways, each beside the
--            matching sales:
--              brand    spend per brand vs that brand's sales in all shops;
--              where    where the ads sent people (website, Instagram
--                       profile, WhatsApp, Instagram DMs, app, store,
--                       awareness) vs sales by channel;
--              account  which Facebook page ran the ads;
--   needs    what waits for an owner: proposals to decide, client ads unpaid
--            or finished without a report.
--
-- A campaign's brand, in order: one set by hand (meta_campaign_brands), a
-- brand named in its ads' text, one named in the campaign name, else Unknown.
-- 96% of ads are written in Arabic and name the brand in Arabic letters
-- ("دبليو ام تي" for WMT), so marketing_brand_aliases holds those spellings;
-- it starts with the ones found in this account's ads (27 Sep) and can grow.
-- Text is compared letters and digits only, alef forms unified, so
-- "#WMTwatches" and "دبليو إم تي" both count.

create table if not exists public.marketing_brand_aliases (
  alias      text primary key,
  brand      text not null,
  created_at timestamptz not null default now()
);
alter table public.marketing_brand_aliases enable row level security;
create policy marketing_brand_aliases_read on public.marketing_brand_aliases
  for select to authenticated using (true);
create policy marketing_brand_aliases_write on public.marketing_brand_aliases
  for all to authenticated
  using ((select get_my_role()) = any (array['admin', 'manager', 'marketing']))
  with check ((select get_my_role()) = any (array['admin', 'manager', 'marketing']));

insert into public.marketing_brand_aliases (alias, brand) values
  ('دبليو ام تي', 'WMT'), ('دبليو إم تي', 'WMT'),
  ('دينيسون', 'Dennison'), ('بالتيك', 'Baltic'),
  ('ستيزن', 'Citizen'), ('سيتيزن', 'Citizen'),
  ('راكيتا', 'Raketa'), ('نيفادا', 'Nivada Grenchen'),
  ('يونيماتيك', 'Unimatic'), ('لومينوكس', 'Luminox'),
  ('وست اند', 'West End'), ('ويست اند', 'West End'),
  ('ديلقز', 'Delugs'), ('هوفمان', 'Hoffman'), ('وولف', 'Wolf'),
  ('انوما', 'Anoma'), ('ليبوا', 'Lebois & Co'), ('لوبوا', 'Lebois & Co'),
  ('بيرنز', 'Behrens'), ('جيرالد تشارلز', 'Gerald Charles'),
  ('تايم ذس', 'TimeThis'), ('كاسيو', 'Casio'), ('جي شوك', 'G-Shock'), ('بولوفا', 'Bulova')
on conflict (alias) do nothing;

/** Letters and digits only, lower case, alef forms unified: the form brand
 *  names and ad text are compared in. */
create or replace function public.marketing_norm(t text)
returns text
language sql
immutable
as $$
  select regexp_replace(lower(translate(coalesce(t, ''), 'أإآ', 'ااا')), '[^a-z0-9ء-ي]', '', 'g');
$$;

/** Every spelling a brand is recognised by, each with the brand's name as
 *  Lightspeed writes it. The shop's own name is left out: it is in every ad. */
create or replace function public.marketing_brand_dictionary()
returns table (key text, label text)
language sql
stable
set search_path = public, pg_temp
as $$
  with names as (
    select distinct on (marketing_norm(brand)) marketing_norm(brand) key, trim(brand) label
      from lightspeed_stock where brand is not null
     order by marketing_norm(brand), length(brand)
  )
  select key, label from names where length(key) >= 3 and key <> 'timekeeper'
  union
  select marketing_norm(a.alias), coalesce(n.label, a.brand)
    from marketing_brand_aliases a
    left join names n on n.key = marketing_norm(a.brand)
   where length(marketing_norm(a.alias)) >= 3;
$$;

create or replace function public.marketing_campaign_brands(p_campaigns text[])
returns table (campaign_id text, brand text, source text)
language sql
stable
set search_path = public, pg_temp
as $$
  with dict as (select * from marketing_brand_dictionary()),
  manual as (
    select distinct on (m.campaign_id) m.campaign_id,
           case when m.kind = 'whole_shop' then 'Whole shop'
                else coalesce((select d.label from dict d where d.key = marketing_norm(b.name) limit 1), b.name) end brand
      from meta_campaign_brands m
      left join brands b on b.id = m.brand_id
     where m.campaign_id = any(p_campaigns)
     order by m.campaign_id, m.set_at desc
  ), ad_text as (
    select a.campaign_id, marketing_norm(concat_ws(' ', a.creative->>'body', a.creative->>'title')) t
      from meta_ads a where a.campaign_id = any(p_campaigns)
  ), from_ads as (
    select distinct on (x.campaign_id) x.campaign_id, d.label brand
      from ad_text x join dict d on strpos(x.t, d.key) > 0
     order by x.campaign_id, length(d.key) desc
  ), from_name as (
    select distinct on (c.id) c.id campaign_id, d.label brand
      from meta_ad_campaigns c join dict d on strpos(marketing_norm(c.name), d.key) > 0
     where c.id = any(p_campaigns)
     order by c.id, length(d.key) desc
  )
  select c, coalesce(mn.brand, fa.brand, fn.brand, 'Unknown'),
         case when mn.brand is not null then 'set' when fa.brand is not null then 'ad text'
              when fn.brand is not null then 'name' end
    from unnest(p_campaigns) c
    left join manual mn on mn.campaign_id = c
    left join from_ads fa on fa.campaign_id = c
    left join from_name fn on fn.campaign_id = c;
$$;

create or replace function public.marketing_overview(p_end date default (current_date - 1), p_days int default 30)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_days int := greatest(1, least(coalesce(p_days, 30), 90));
  v_start date := p_end - (v_days - 1);
  v_out jsonb;
begin
  with spend as (
    select d.object_id campaign_id, sum(d.spend::numeric) usd
      from meta_insight_daily d
     where d.level = 'campaign' and d.day between v_start and p_end
     group by 1 having sum(d.spend::numeric) > 0
  ), camp as (
    select s.campaign_id, s.usd, c.objective, coalesce(cb.brand, 'Unknown') brand,
           (select mode() within group (order by a.creative->>'call_to_action_type')
              from meta_ads a where a.campaign_id = s.campaign_id) cta,
           (select mode() within group (order by split_part(a.creative->>'effective_object_story_id', '_', 1))
              from meta_ads a where a.campaign_id = s.campaign_id) page_id
      from spend s
      join meta_ad_campaigns c on c.id = s.campaign_id
      left join marketing_campaign_brands(array(select campaign_id from spend)) cb on cb.campaign_id = s.campaign_id
  ), placed as (
    select camp.*,
           case
             when objective in ('OUTCOME_APP_PROMOTION', 'APP_INSTALLS', 'MOBILE_APP_INSTALLS') then 'App'
             when cta = 'WHATSAPP_MESSAGE' then 'WhatsApp'
             when cta = 'INSTAGRAM_MESSAGE' then 'Instagram DMs'
             when objective = 'MESSAGES' then 'WhatsApp'
             when objective in ('STORE_VISITS', 'OUTCOME_STORE_TRAFFIC', 'LOCAL_AWARENESS') then 'Store'
             when cta = 'VIEW_INSTAGRAM_PROFILE' then 'Instagram profile'
             when cta in ('SHOP_NOW', 'LEARN_MORE', 'ORDER_NOW', 'SIGN_UP', 'CONTACT_US', 'BOOK_TRAVEL')
               or objective in ('OUTCOME_SALES', 'CONVERSIONS', 'PRODUCT_CATALOG_SALES', 'LINK_CLICKS', 'OUTCOME_TRAFFIC') then 'Website'
             else 'Awareness'
           end dest,
           case page_id
             when '146176512670059' then 'Time Keeper KW'
             when '854600564401572' then 'Time Keeper Shop Kuwait'
             when '107774659095242' then 'Time Gallery'
             when '101505995383472' then 'Time Keeper Shop'
             else 'Other page'
           end account
      from camp
  ), total as (select coalesce(sum(usd), 0) usd from placed),
  sales as (
    select s.id, s.scope_code, s.total_price_incl
      from lightspeed_sales s
     where s.sale_day between v_start and p_end
       and s.status not in ('VOIDED', 'SAVED') and s.return_for is null
  ), named as (
    select distinct on (product_id) product_id, brand from lightspeed_stock order by product_id, synced_at desc
  ), dict as (select * from marketing_brand_dictionary()),
  brand_sales as (
    select coalesce((select d.label from dict d where d.key = marketing_norm(coalesce(i.brand, n.brand)) limit 1),
                    nullif(trim(coalesce(i.brand, n.brand)), ''), 'No brand') brand,
           sum(i.price_total) kd
      from lightspeed_sale_items i
      join sales s on s.id = i.sale_id
      left join named n on n.product_id = i.product_id
     where coalesce(i.is_return, false) = false and coalesce(i.status, '') <> 'VOIDED'
     group by 1
  ), brand_sales_total as (select coalesce(sum(kd), 0) kd from brand_sales),
  brand_rows as (
    select coalesce(sp.brand, bs.brand) brand, coalesce(sp.usd, 0) usd, coalesce(bs.kd, 0) kd
      from (select brand, sum(usd) usd from placed group by 1) sp
      full join brand_sales bs on bs.brand = sp.brand
  ), channel_sales as (
    select scope_code, round(sum(total_price_incl), 3) kd, count(*) n from sales group by 1
  ), days as (
    select g::date as day from generate_series(p_end - 6, p_end, interval '1 day') g
  )
  select jsonb_build_object(
    'window', jsonb_build_object('start', v_start, 'end', p_end, 'days', v_days),
    'spend_usd', (select round(usd, 2) from total),
    'pushing', jsonb_build_object(
      'brand', (select coalesce(jsonb_agg(jsonb_build_object(
                  'brand', r.brand, 'spend_usd', round(r.usd, 2),
                  'spend_share', case when t.usd > 0 then round(r.usd / t.usd * 100, 1) end,
                  'sales_kd', round(r.kd, 3),
                  'sales_share', case when bt.kd > 0 then round(r.kd / bt.kd * 100, 1) end)
                  order by r.usd desc, r.kd desc), '[]'::jsonb)
                  from (select * from brand_rows where brand <> 'No brand' and (usd > 0 or kd > 0)
                         order by usd desc, kd desc limit 12) r, total t, brand_sales_total bt),
      'unknown_share', (select case when t.usd > 0 then round(coalesce(sum(p.usd) filter (where p.brand = 'Unknown'), 0) / t.usd * 100, 1) end
                          from total t left join placed p on true group by t.usd),
      'unknown_campaigns', (select count(*) from placed where brand = 'Unknown'),
      'where', (select coalesce(jsonb_agg(jsonb_build_object('dest', w.dest, 'spend_usd', round(w.usd, 2),
                  'spend_share', case when t.usd > 0 then round(w.usd / t.usd * 100, 1) end, 'campaigns', w.n)
                  order by w.usd desc), '[]'::jsonb)
                  from (select dest, sum(usd) usd, count(*) n from placed group by 1) w, total t),
      'account', (select coalesce(jsonb_agg(jsonb_build_object('account', a.account, 'spend_usd', round(a.usd, 2),
                  'spend_share', case when t.usd > 0 then round(a.usd / t.usd * 100, 1) end)
                  order by a.usd desc), '[]'::jsonb)
                  from (select account, sum(usd) usd from placed group by 1) a, total t),
      'channels', (select coalesce(jsonb_agg(jsonb_build_object('channel', scope_code, 'sales_kd', kd, 'sales', n,
                  'sales_share', round(kd / nullif((select sum(kd) from channel_sales), 0) * 100, 1))
                  order by kd desc), '[]'::jsonb) from channel_sales)
    ),
    'daily', (select jsonb_agg(jsonb_build_object(
                'day', d.day,
                'spend_usd', coalesce((select round(sum(x.spend::numeric), 2) from meta_insight_daily x
                                        where x.level = 'campaign' and x.day = d.day), 0),
                'online_kd', coalesce((select round(sum(s.total_price_incl), 3) from lightspeed_sales s
                                        where s.sale_day = d.day and s.scope_code = 'online'
                                          and s.status not in ('VOIDED', 'SAVED') and s.return_for is null), 0),
                'whatsapp_kd', coalesce((select round(sum(s.total_price_incl), 3) from lightspeed_sales s
                                        where s.sale_day = d.day and s.scope_code = 'whatsapp'
                                          and s.status not in ('VOIDED', 'SAVED') and s.return_for is null), 0))
                order by d.day) from days d),
    'last_spend_day', (select max(day) from meta_insight_daily where level = 'campaign' and spend::numeric > 0),
    'needs', jsonb_build_object(
      'proposals', (select count(*) from ad_proposals where status in ('proposed', 'failed')),
      'client_unpaid_kd', (select coalesce(sum(amount_charged), 0) from paid_ads
                            where coalesce(payment_status, '') <> 'Paid' and coalesce(status, '') <> 'Cancelled' and amount_charged > 0),
      'client_unpaid', (select count(*) from paid_ads
                         where coalesce(payment_status, '') <> 'Paid' and coalesce(status, '') <> 'Cancelled' and amount_charged > 0),
      'client_no_report', (select count(*) from paid_ads where status = 'Completed' and not coalesce(report_sent, false)))
  ) into v_out;
  return v_out;
end;
$$;

grant execute on function public.marketing_norm(text) to authenticated;
grant execute on function public.marketing_brand_dictionary() to authenticated;
grant execute on function public.marketing_campaign_brands(text[]) to authenticated;
grant execute on function public.marketing_overview(date, int) to authenticated;
