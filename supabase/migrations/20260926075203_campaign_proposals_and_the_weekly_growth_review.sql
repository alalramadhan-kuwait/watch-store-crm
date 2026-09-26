-- Campaign proposals with an owner's approval, and the weekly growth review.
--
-- Every new campaign starts as a proposal that states what the growth skill
-- asks for before any money moves: product, objective, audience, creative,
-- budget, reason and the success measure. An owner (admin) approves or
-- rejects it. Approval builds the campaign on Meta PAUSED — campaign, ad set
-- and ad — through meta-campaign-manage; nothing spends until an owner presses
-- Activate, and a budget change is the owner's too. Every step is written to
-- ad_proposal_events.
--
-- growth_review() answers the weekly questions from stored figures: spend,
-- Meta's purchases and value, return on spend, cost per purchase, the real
-- online and WhatsApp sales beside them, the best product and creative, the
-- weak campaigns, and a Scale / Hold / Improve / Stop call for each campaign.

create table if not exists public.ad_proposals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users(id),
  status text not null default 'proposed'
    check (status in ('proposed', 'withdrawn', 'rejected', 'approved', 'failed', 'created', 'active', 'paused')),

  product text not null,
  brand text,
  landing_url text,
  objective text not null
    check (objective in ('OUTCOME_SALES', 'MESSAGES', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT', 'OUTCOME_AWARENESS')),
  audience text not null,
  countries text[] not null default array['KW'],
  age_min integer not null default 25 check (age_min between 18 and 65),
  age_max integer not null default 55 check (age_max between 18 and 65 and age_max >= age_min),
  creative text not null,
  instagram_account text,
  instagram_media_id text,
  daily_budget_kd numeric not null check (daily_budget_kd > 0),
  days integer not null default 7 check (days between 1 and 90),
  reason text not null,
  success_kpi text not null,
  kpi_target text,

  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  decision_note text,
  meta_campaign_id text,
  meta_adset_id text,
  meta_ad_id text,
  meta_error text,
  activated_by uuid references auth.users(id),
  activated_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists ad_proposals_status on public.ad_proposals (status, created_at desc);

create table if not exists public.ad_proposal_events (
  id bigint generated always as identity primary key,
  proposal_id uuid not null references public.ad_proposals(id) on delete cascade,
  at timestamptz not null default now(),
  by_user uuid references auth.users(id),
  action text not null,
  detail jsonb
);
create index if not exists ad_proposal_events_proposal on public.ad_proposal_events (proposal_id, at);

alter table public.ad_proposals enable row level security;
alter table public.ad_proposal_events enable row level security;

-- Owners, managers and marketing see proposals and may propose. A proposal is
-- edited, or withdrawn, only by whoever made it and only before a decision.
-- Decisions, and everything that touches Meta, go through
-- meta-campaign-manage with the service role, which checks for an owner.
create policy ad_proposals_read on public.ad_proposals for select to authenticated
  using ((select get_my_role()) = any (array['admin','manager','marketing']));
create policy ad_proposals_propose on public.ad_proposals for insert to authenticated
  with check ((select get_my_role()) = any (array['admin','manager','marketing'])
              and created_by = (select auth.uid()) and status = 'proposed'
              and decided_by is null and meta_campaign_id is null and activated_by is null);
create policy ad_proposals_edit_own on public.ad_proposals for update to authenticated
  using (created_by = (select auth.uid()) and status = 'proposed')
  with check (created_by = (select auth.uid()) and status in ('proposed', 'withdrawn')
              and decided_by is null and meta_campaign_id is null and activated_by is null);
create policy ad_proposal_events_read on public.ad_proposal_events for select to authenticated
  using ((select get_my_role()) = any (array['admin','manager','marketing']));

revoke all on public.ad_proposals, public.ad_proposal_events from anon;

-- Owners hear about a new proposal; whoever proposed hears the decision.
insert into public.notification_settings (event_type, label, category, enabled, person_target, audience_roles, sort, shop_floor, outlet_scoped)
values ('ad_proposal', 'New campaign proposal → owners', 'Marketing', true, false, array['admin'], 80, false, false),
       ('ad_decided', 'Campaign proposal decided → proposer', 'Marketing', true, true, null, 81, false, false),
       ('growth_review', 'Weekly growth review', 'Marketing', true, false, array['admin','marketing'], 82, false, false)
on conflict (event_type) do nothing;

create or replace function public.trg_ad_proposal_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    perform notify_event('ad_proposal', 'New campaign proposal',
      new.product || ' · ' || new.daily_budget_kd || ' KD/day for ' || new.days || ' days',
      '#/campaign-proposals?focus=' || new.id, array['admin'], null, new.created_by,
      'ad_proposal:' || new.id);
  elsif new.status is distinct from old.status and new.status in ('rejected', 'created', 'failed', 'active') and new.created_by is not null then
    perform notify_event('ad_decided',
      case new.status when 'rejected' then 'Proposal rejected'
                      when 'created' then 'Proposal approved — built on Meta, paused'
                      when 'failed' then 'Proposal approved — Meta refused it'
                      else 'Campaign switched on' end,
      new.product || coalesce(' · ' || new.decision_note, ''),
      '#/campaign-proposals?focus=' || new.id, null, new.created_by, null,
      'ad_decided:' || new.id || ':' || new.status);
  end if;
  return new;
end;
$$;
revoke all on function public.trg_ad_proposal_notify() from public, anon, authenticated;

drop trigger if exists ad_proposal_notify on public.ad_proposals;
create trigger ad_proposal_notify after insert or update of status on public.ad_proposals
  for each row execute function public.trg_ad_proposal_notify();

-- ── the weekly review ────────────────────────────────────────────────────

/* One action's value out of Meta's action list, as a number for summing. */
create or replace function public.meta_action(list jsonb, action text)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(sum((a->>'value')::numeric), 0)
    from jsonb_array_elements(coalesce(list, '[]'::jsonb)) a
   where a->>'action_type' = action
$$;

/*
 * The week ending p_end (default yesterday), beside the week before.
 *
 * Meta's days are the ad account's (Los Angeles); Lightspeed's are Kuwait's.
 * The two weeks therefore overlap by all but eleven hours, which is close
 * enough for a weekly call and is said on the page.
 *
 * The call for each campaign is a rule, not a judgement, and the rules are
 * returned with the answer so the page can show them:
 *   sales campaigns   — Scale: 2+ purchases and return of 3x or more
 *                       Stop:  15+ USD spent, no purchase, CTR under 1%
 *                              (or return under 1x on 50+ USD)
 *                       Improve: 15+ USD spent, no purchase, CTR 1% or more
 *                       Hold: anything else (including too little spend to tell)
 *   message campaigns — Scale at 3 USD or less per conversation, Hold up to 8,
 *                       Improve above; Stop at 15+ USD and no conversation
 *   other objectives  — never Scale on clicks alone: Hold at CTR 1%+,
 *                       Improve below, Stop at 30+ USD with CTR under 0.5%
 */
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
  ), products as (
    select i.name, i.brand, sum(i.quantity) units, round(sum(i.price_total), 3) kd
      from lightspeed_sale_items i
      join lightspeed_sales s on s.id = i.sale_id
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
revoke all on function public.growth_review(date) from public, anon;
grant execute on function public.growth_review(date) to authenticated;

-- Sunday 09:00 Kuwait: the week's headline to owners and marketing.
create or replace function public.send_growth_review()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare r jsonb := growth_review(); m jsonb := r->'meta';
begin
  perform notify_event('growth_review', 'Weekly growth review',
    'Spent ' || coalesce(m->>'spend_kd', '0') || ' KD · Meta sales ' || coalesce(m->>'value_kd', '0') || ' KD'
      || coalesce(' · return ' || (m->>'roas') || 'x', '')
      || ' · ' || jsonb_array_length(r->'weak') || ' campaign(s) to fix',
    '#/growth-review', array['admin','marketing'], null, null, 'growth_review:' || (r->'window'->>'end'));
end;
$$;
revoke all on function public.send_growth_review() from public, anon, authenticated;

select cron.schedule('growth-review-weekly', '0 6 * * 0', $cron$select public.send_growth_review();$cron$);

-- The Meta sync's two new runs: ad sets at 05:40, ads at 05:50 (UTC).
select cron.schedule('meta-ads-detail-sync', '40 5 * * *', $cron$
  select net.http_post(
    url := 'https://ttshgrujnycapugrmyxs.supabase.co/functions/v1/meta-ads-sync',
    headers := jsonb_build_object('Content-Type','application/json','x-sync-key',(select sync_key from lightspeed_auth where id=1)),
    body := '{"mode":"detail","days":14}'::jsonb, timeout_milliseconds := 300000);
$cron$);
select cron.schedule('meta-ads-ad-sync', '50 5 * * *', $cron$
  select net.http_post(
    url := 'https://ttshgrujnycapugrmyxs.supabase.co/functions/v1/meta-ads-sync',
    headers := jsonb_build_object('Content-Type','application/json','x-sync-key',(select sync_key from lightspeed_auth where id=1)),
    body := '{"mode":"ads","days":14}'::jsonb, timeout_milliseconds := 300000);
$cron$);
