-- Ads and Client Ads (27 Sep).
--
-- Meta Campaigns and Campaign Proposals become one page, Ads (/ads, tabs
-- Campaigns and Proposals); Paid Ads Tracker becomes Client Ads
-- (/client-ads): jobs companies pay Time Keeper for — posts and event
-- coverage on its Instagram accounts, not Meta campaigns.
--
--   1. A client job can name the Instagram post that delivered it, so its
--      reach, views, saves and shares come from Instagram instead of being
--      typed, and the report to the client can be copied in one tap.
--      report_sent_at records when that was done.
--   2. Anyone with a hand-picked page list keeps the same pages under their
--      new addresses.
--   3. Notifications open the new pages. The weekly one also reads in whole
--      KD ("Spent 94 KD", not "0.068 KD").

alter table public.paid_ads
  add column if not exists instagram_media_id text,
  add column if not exists report_sent_at timestamptz;

update public.profiles p
   set page_access = (
     select coalesce(array_agg(distinct x order by x), '{}')
       from unnest(p.page_access) as u(v)
       cross join lateral (select case u.v
                                    when '/meta-campaigns' then '/ads'
                                    when '/campaign-proposals' then '/ads'
                                    when '/paid-ads' then '/client-ads'
                                    when '/growth-review' then '/marketing'
                                    else u.v end as x) m)
 where p.page_access && array['/meta-campaigns', '/campaign-proposals', '/paid-ads', '/growth-review'];

create or replace function public.trg_ad_proposal_notify()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if tg_op = 'INSERT' then
    perform notify_event('ad_proposal', 'New campaign proposal',
      new.product || ' · ' || new.daily_budget_kd || ' KD/day for ' || new.days || ' days',
      '#/ads?tab=proposals&focus=' || new.id, array['admin'], null, new.created_by,
      'ad_proposal:' || new.id);
  elsif new.status is distinct from old.status and new.status in ('rejected', 'created', 'failed', 'active') and new.created_by is not null then
    perform notify_event('ad_decided',
      case new.status when 'rejected' then 'Proposal rejected'
                      when 'created' then 'Proposal approved — built on Meta, paused'
                      when 'failed' then 'Proposal approved — Meta refused it'
                      else 'Campaign switched on' end,
      new.product || coalesce(' · ' || new.decision_note, ''),
      '#/ads?tab=proposals&focus=' || new.id, null, new.created_by, null,
      'ad_decided:' || new.id || ':' || new.status);
  end if;
  return new;
end;
$function$;

create or replace function public.send_growth_review()
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare r jsonb := growth_review(); m jsonb := r->'meta';
begin
  perform notify_event('growth_review', 'Weekly marketing overview',
    'Ad spend ' || round(coalesce((m->>'spend_kd')::numeric, 0)) || ' KD · sales from ads '
      || round(coalesce((m->>'value_kd')::numeric, 0)) || ' KD'
      || coalesce(' · return ' || (m->>'roas') || 'x', '')
      || ' · ' || jsonb_array_length(r->'weak') || ' campaign(s) to fix',
    '#/marketing', array['admin','marketing'], null, null, 'growth_review:' || (r->'window'->>'end'));
end;
$function$;
