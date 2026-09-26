-- Two follow-ups to the growth review.
--
-- 1. Most online and WhatsApp sale lines arrive from Lightspeed without a
--    product name (98 of 102 in the week to 20 Sep), so the best product came
--    out as one nameless 8,989 KD line. The name and brand are filled in from
--    the stock list by product id, and a line still without one says which
--    product it was rather than nothing.
-- 2. Ad-level figures get a run of their own at 05:55: the ad list and the ad
--    figures together ran out of room twice on 26 Sep.

create or replace function public.growth_review(p_end date default (current_date - 1))
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_start date := p_end - 6;
  v_prev_start date := p_end - 13;
  v_prev_end date := p_end - 7;
  v_rate numeric := (select kwd_per_usd from meta_ads_config where id = 1);
  v_out jsonb;
begin
  with camp as (
    select d.object_id as campaign_id, c.name, c.objective,
           sum(d.spend::numeric) spend, sum(d.impressions::numeric) impressions, sum(d.clicks::numeric) clicks,
           sum(meta_action(d.actions, 'omni_purchase')) purchases,
           sum(meta_action(d.action_values, 'omni_purchase')) value,
           sum(meta_action(d.actions, 'onsite_conversion.messaging_conversation_started_7d')) conversations,
           max(d.frequency::numeric) max_daily_frequency
      from meta_insight_daily d
      join meta_ad_campaigns c on c.id = d.object_id
     where d.level = 'campaign' and d.day between v_start and p_end
     group by 1, 2, 3
    having sum(d.spend::numeric) > 0
  ), judged as (
    select camp.*,
           case when impressions > 0 then round(clicks / impressions * 100, 2) end ctr,
           case when spend > 0 and value > 0 then round(value / spend, 2) end roas,
           case when purchases > 0 then round(spend / purchases, 2) end cpa,
           case
             when objective in ('OUTCOME_SALES', 'CONVERSIONS', 'PRODUCT_CATALOG_SALES') then
               case when purchases >= 2 and value / nullif(spend, 0) >= 3 then 'Scale'
                    when spend >= 50 and value / nullif(spend, 0) < 1 and purchases > 0 then 'Stop'
                    when spend >= 15 and purchases = 0 and coalesce(clicks / nullif(impressions, 0), 0) < 0.01 then 'Stop'
                    when spend >= 15 and purchases = 0 then 'Improve'
                    else 'Hold' end
             when objective = 'MESSAGES' or conversations > 0 then
               case when conversations = 0 and spend >= 15 then 'Stop'
                    when conversations > 0 and spend / conversations <= 3 then 'Scale'
                    when conversations > 0 and spend / conversations <= 8 then 'Hold'
                    else 'Improve' end
             else
               case when spend >= 30 and coalesce(clicks / nullif(impressions, 0), 0) < 0.005 then 'Stop'
                    when coalesce(clicks / nullif(impressions, 0), 0) >= 0.01 then 'Hold'
                    else 'Improve' end
           end verdict
      from camp
  ), totals as (
    select coalesce(sum(spend), 0) spend, coalesce(sum(purchases), 0) purchases, coalesce(sum(value), 0) value,
           coalesce(sum(clicks), 0) clicks, coalesce(sum(impressions), 0) impressions
      from camp
  ), prev as (
    select coalesce(sum(d.spend::numeric), 0) spend,
           coalesce(sum(meta_action(d.actions, 'omni_purchase')), 0) purchases,
           coalesce(sum(meta_action(d.action_values, 'omni_purchase')), 0) value
      from meta_insight_daily d
     where d.level = 'campaign' and d.day between v_prev_start and v_prev_end
  ), ads as (
    select d.object_id ad_id, a.name, a.campaign_id, a.creative,
           sum(d.spend::numeric) spend, sum(d.impressions::numeric) impressions, sum(d.clicks::numeric) clicks,
           sum(meta_action(d.actions, 'omni_purchase')) purchases,
           sum(meta_action(d.action_values, 'omni_purchase')) value
      from meta_insight_daily d
      left join meta_ads a on a.id = d.object_id
     where d.level = 'ad' and d.day between v_start and p_end
     group by 1, 2, 3, 4
    having sum(d.spend::numeric) >= 5
  ), shop as (
    select s.scope_code, count(*) sales, round(sum(s.total_price_incl), 3) kd
      from lightspeed_sales s
     where s.sale_day between v_start and p_end
       and s.status not in ('VOIDED', 'SAVED') and s.return_for is null
     group by 1
  ), named as (
    select distinct on (product_id) product_id, name, brand from lightspeed_stock order by product_id, synced_at desc
  ), products as (
    select coalesce(i.name, n.name, 'Product ' || left(i.product_id, 8)) as name,
           coalesce(i.brand, n.brand) as brand,
           sum(i.quantity) units, round(sum(i.price_total), 3) kd
      from lightspeed_sale_items i
      join lightspeed_sales s on s.id = i.sale_id
      left join named n on n.product_id = i.product_id
     where s.sale_day between v_start and p_end
       and s.scope_code in ('online', 'whatsapp')
       and s.status not in ('VOIDED', 'SAVED') and coalesce(i.is_return, false) = false
       and coalesce(i.status, '') <> 'VOIDED'
     group by 1, 2
  )
  select jsonb_build_object(
    'window', jsonb_build_object('start', v_start, 'end', p_end, 'previous_start', v_prev_start, 'previous_end', v_prev_end),
    'kwd_per_usd', v_rate,
    'meta', (select jsonb_build_object(
        'spend_usd', round(t.spend, 2), 'spend_kd', round(t.spend * v_rate, 3),
        'purchases', t.purchases, 'value_usd', round(t.value, 2), 'value_kd', round(t.value * v_rate, 3),
        'roas', case when t.spend > 0 and t.value > 0 then round(t.value / t.spend, 2) end,
        'cpa_usd', case when t.purchases > 0 then round(t.spend / t.purchases, 2) end,
        'ctr', case when t.impressions > 0 then round(t.clicks / t.impressions * 100, 2) end,
        'previous', (select jsonb_build_object('spend_usd', round(p.spend, 2), 'purchases', p.purchases, 'value_usd', round(p.value, 2)) from prev p))
      from totals t),
    'shop', jsonb_build_object(
        'online', (select jsonb_build_object('sales', sales, 'kd', kd) from shop where scope_code = 'online'),
        'whatsapp', (select jsonb_build_object('sales', sales, 'kd', kd) from shop where scope_code = 'whatsapp'),
        'all_kd', (select round(sum(kd), 3) from shop)),
    'best_products', (select coalesce(jsonb_agg(p order by p.kd desc), '[]'::jsonb) from (select * from products order by kd desc limit 5) p),
    'best_creatives', (select coalesce(jsonb_agg(x order by x.value desc, x.purchases desc, x.ctr desc nulls last), '[]'::jsonb) from (
        select ad_id, name, campaign_id, round(spend, 2) spend_usd, purchases, round(value, 2) value,
               case when impressions > 0 then round(clicks / impressions * 100, 2) end ctr,
               creative->>'instagram_permalink_url' permalink, creative->>'thumbnail_url' thumbnail,
               left(creative->>'body', 140) body
          from ads order by value desc, purchases desc, (clicks / nullif(impressions, 0)) desc nulls last limit 5) x),
    'campaigns', (select coalesce(jsonb_agg(jsonb_build_object(
        'campaign_id', campaign_id, 'name', name, 'objective', objective,
        'spend_usd', round(spend, 2), 'purchases', purchases, 'value_usd', round(value, 2),
        'conversations', conversations, 'ctr', ctr, 'roas', roas, 'cpa_usd', cpa,
        'max_daily_frequency', max_daily_frequency, 'verdict', verdict)
        order by array_position(array['Stop','Improve','Scale','Hold'], verdict), spend desc), '[]'::jsonb) from judged),
    'weak', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'spend_usd', round(spend, 2), 'verdict', verdict) order by spend desc), '[]'::jsonb)
               from judged where verdict in ('Stop', 'Improve')),
    'tracking', (select jsonb_build_object('checked_at', tracking_checked_at) from meta_ads_config where id = 1),
    'rules', jsonb_build_object(
        'sales', 'Scale: 2+ purchases and return 3x or more. Stop: 15+ USD, no purchase, CTR under 1% (or return under 1x on 50+ USD). Improve: 15+ USD, no purchase, CTR 1%+. Otherwise Hold.',
        'messages', 'Scale at 3 USD or less per conversation, Hold up to 8, Improve above. Stop: 15+ USD and no conversation.',
        'other', 'Never Scale on clicks alone. Hold at CTR 1%+, Improve below, Stop at 30+ USD with CTR under 0.5%.')
  ) into v_out;
  return v_out;
end;
$$;

select cron.schedule('meta-ads-ad-figures-sync', '55 5 * * *', $cron$
  select net.http_post(
    url := 'https://ttshgrujnycapugrmyxs.supabase.co/functions/v1/meta-ads-sync',
    headers := jsonb_build_object('Content-Type','application/json','x-sync-key',(select sync_key from lightspeed_auth where id=1)),
    body := '{"mode":"ad_figures","days":14}'::jsonb, timeout_milliseconds := 300000);
$cron$);
