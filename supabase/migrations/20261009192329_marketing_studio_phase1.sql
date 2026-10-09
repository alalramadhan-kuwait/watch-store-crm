-- Marketing Studio, phase 1: campaign records and the team's workflow.
--
-- An owner turns a marketing need into a campaign; the marketing team works it
-- in the Inbox they already use; every step is logged. Nothing here changes an
-- existing permission, table, column, role, page list or notification audience:
-- the new tables carry their own rules, every write goes through the campaign
-- functions below, and the only rows written into existing tables are an
-- ordinary Inbox task per campaign and notifications through notify_event.
--
-- Nothing here publishes, spends or writes to Lightspeed. No function makes a
-- network call; Lightspeed, ad and Instagram tables are only read, and only
-- for the owners' campaign form.
--
-- Execution (who did what, when, on time or not) is recorded here. Campaign
-- performance (before-and-after results) is phase 3 and has its own table,
-- created here empty so the rules are in place from the start.

-- ── Objectives and their measuring windows ──────────────────────────────────
create table public.marketing_objective_settings (
  objective text primary key
    check (objective in ('slow_stock', 'new_arrivals', 'best_seller', 'brand_awareness')),
  label text not null,
  -- the units a target may be counted in, for this objective
  target_units text[] not null,
  default_window_days int not null default 21 check (default_window_days >= 7),
  min_window_days int not null default 14 check (min_window_days >= 7),
  -- any departure from the standard 21 / 14 days is written down here
  exception_note text,
  updated_at timestamptz not null default now(),
  check (default_window_days >= min_window_days),
  check ((default_window_days = 21 and min_window_days = 14) or exception_note is not null)
);
insert into public.marketing_objective_settings (objective, label, target_units) values
  ('slow_stock',      'Slow-stock clearance',  array['units']),
  ('new_arrivals',    'New arrivals',          array['units', 'products_first_sale']),
  ('best_seller',     'Best-seller promotion', array['units', 'retail_revenue_kd']),
  ('brand_awareness', 'Brand awareness',       array['reach', 'saves', 'profile_visits']);

-- ── Campaigns ───────────────────────────────────────────────────────────────
create table public.marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid not null,
  -- the owner responsible: approves, closes, and gets the approval notifications
  campaign_owner uuid not null,
  title text not null check (char_length(btrim(title)) between 3 and 120),
  objective text not null references public.marketing_objective_settings (objective),
  target_value numeric not null check (target_value > 0),
  target_unit text not null,
  window_days int not null check (window_days >= 7),
  brand text,
  -- [{product_id, name, sku, brand, arrived_on, arrival_basis}]: never a cost
  products jsonb not null default '[]'::jsonb check (jsonb_typeof(products) = 'array'),
  channels text[] not null check (cardinality(channels) >= 1 and channels <@ array['instagram_post',
    'instagram_reel', 'instagram_story', 'whatsapp_broadcast', 'in_store_display', 'paid_boost']),
  offer text not null default 'none' check (offer in ('none', 'gift', 'discount', 'bundle')),
  offer_pct numeric check (offer_pct is null or (offer_pct > 0 and offer_pct <= 90)),
  content_kind text check (content_kind in ('product_photo', 'lifestyle_photo', 'video', 'wrist_shot', 'carousel')),
  priority text not null default 'Normal' check (priority in ('Low', 'Normal', 'High', 'Urgent')),
  deadline date not null,
  -- recorded only; nothing acts on it
  budget_cap_kd numeric check (budget_cap_kd is null or budget_cap_kd >= 0),
  brief text check (brief is null or char_length(brief) <= 2000),
  stage text not null default 'assigned'
    check (stage in ('assigned', 'working', 'in_review', 'approved', 'posted', 'done', 'cancelled')),
  approval_status text not null default 'not_submitted'
    check (approval_status in ('not_submitted', 'awaiting', 'changes_requested', 'approved')),
  assignee_employee_id uuid references public.employees (id),
  assignee_role text check (assignee_role = 'marketing'),
  task_id uuid references public.assigned_tasks (id),
  source_mission_key text,
  -- a paid boost is proposed by hand on the Ads page; this only links to it
  ad_proposal_id uuid,
  -- execution timestamps
  assigned_at timestamptz not null default now(),
  picked_up_at timestamptz,
  first_submitted_at timestamptz,
  last_submitted_at timestamptz,
  approved_at timestamptz,
  published_at timestamptz,          -- when it actually went out, as the team confirms it
  published_confirmed_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  revision_rounds int not null default 0,
  post_links text[] not null default '{}',
  lesson text check (lesson is null or char_length(lesson) <= 500),
  shared_note text check (shared_note is null or char_length(shared_note) <= 1000),
  updated_at timestamptz not null default now(),
  check (assignee_employee_id is not null or assignee_role is not null),
  check (objective = 'brand_awareness' or jsonb_array_length(products) >= 1),
  check (objective <> 'brand_awareness' or brand is not null),
  check (published_at is null or approved_at is null or published_at >= approved_at - interval '1 day')
);
create index marketing_campaigns_stage_idx on public.marketing_campaigns (stage, deadline);
create index marketing_campaigns_task_idx on public.marketing_campaigns (task_id);

-- ── History: append-only ────────────────────────────────────────────────────
create table public.marketing_campaign_events (
  id bigint generated always as identity primary key,
  campaign_id uuid not null references public.marketing_campaigns (id),
  at timestamptz not null default now(),
  actor uuid,
  actor_name text,
  action text not null check (action in ('created', 'assigned', 'picked_up', 'file_added', 'comment',
    'submitted', 'changes_requested', 'approved', 'published', 'completed', 'cancelled', 'handed_over',
    'deadline_moved', 'reminded')),
  from_stage text,
  to_stage text,
  approval_status text,
  note text check (note is null or char_length(note) <= 2000),
  detail jsonb not null default '{}'::jsonb
);
create index marketing_campaign_events_campaign_idx on public.marketing_campaign_events (campaign_id, id);

-- ── Draft and final files ───────────────────────────────────────────────────
create table public.marketing_campaign_files (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.marketing_campaigns (id),
  version int not null check (version >= 1),
  kind text not null check (kind in ('draft', 'reference')),
  storage_path text,
  file_name text,
  mime text,
  size_bytes bigint check (size_bytes is null or size_bytes <= 26214400),
  caption_text text check (caption_text is null or char_length(caption_text) <= 2200),
  uploaded_by uuid not null,
  uploaded_at timestamptz not null default now(),
  -- the decision on this version; approval belongs to a version
  decision text not null default 'none' check (decision in ('none', 'under_review', 'approved', 'changes_requested')),
  decided_by uuid,
  decided_at timestamptz,
  unique (campaign_id, version),
  check (storage_path is not null or caption_text is not null)
);

-- ── Results (phase 3 fills this; owners only) ───────────────────────────────
create table public.marketing_campaign_results (
  campaign_id uuid primary key references public.marketing_campaigns (id),
  computed_at timestamptz not null default now(),
  windows jsonb not null,
  figures jsonb not null,
  readable boolean not null,
  flags text[] not null default '{}',
  owner_figures jsonb
);

-- History and results are never edited or deleted.
create function public.mkt_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'Campaign history is append-only';
end $$;
create trigger marketing_campaign_events_append_only before update or delete on public.marketing_campaign_events
  for each row execute function public.mkt_append_only();
create trigger marketing_campaign_results_append_only before update or delete on public.marketing_campaign_results
  for each row execute function public.mkt_append_only();

-- ── Who is who ──────────────────────────────────────────────────────────────
create function public.mkt_is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from stock_ai_access where user_id = auth.uid())
$$;

create function public.mkt_my_employee_ids() returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(id), '{}') from employees where user_id = auth.uid()
$$;

-- Owners see every campaign; the named assignee sees theirs; the marketing
-- role sees campaigns given to the team. Nobody else sees any.
create function public.mkt_can_see(p_campaign uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select mkt_is_owner() or exists (
    select 1 from marketing_campaigns c
     where c.id = p_campaign
       and (c.assignee_employee_id = any (mkt_my_employee_ids())
            or (c.assignee_role is not null and c.assignee_role = get_my_role())))
$$;

alter table public.marketing_objective_settings enable row level security;
alter table public.marketing_campaigns enable row level security;
alter table public.marketing_campaign_events enable row level security;
alter table public.marketing_campaign_files enable row level security;
alter table public.marketing_campaign_results enable row level security;

-- Read rules only: every write goes through the campaign functions.
create policy mkt_settings_read on public.marketing_objective_settings for select
  using (mkt_is_owner() or get_my_role() = 'marketing');
create policy mkt_campaigns_read on public.marketing_campaigns for select using (mkt_can_see(id));
create policy mkt_events_read on public.marketing_campaign_events for select using (mkt_can_see(campaign_id));
create policy mkt_files_read on public.marketing_campaign_files for select using (mkt_can_see(campaign_id));
create policy mkt_results_read on public.marketing_campaign_results for select using (mkt_is_owner());

-- Read access is granted explicitly, so the row rules above decide what each person sees.
grant select on public.marketing_objective_settings, public.marketing_campaigns, public.marketing_campaign_events,
  public.marketing_campaign_files, public.marketing_campaign_results to authenticated;
revoke insert, update, delete on public.marketing_objective_settings, public.marketing_campaigns,
  public.marketing_campaign_events, public.marketing_campaign_files, public.marketing_campaign_results
  from anon, authenticated;
revoke all on public.marketing_objective_settings, public.marketing_campaigns, public.marketing_campaign_events,
  public.marketing_campaign_files, public.marketing_campaign_results from anon;

-- ── Draft files: a private store of its own ─────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('campaign-files', 'campaign-files', false, 26214400,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'video/mp4', 'video/quicktime', 'application/pdf']);

-- Paths are '<campaign id>/<file>'. Read: anyone who can see the campaign.
-- Upload: the campaign's assignee, its team or an owner, until it is closed;
-- campaign_act decides which uploads count as drafts.
-- No update or delete: a new version is a new file.
create function public.mkt_path_campaign(p_name text) returns uuid
language plpgsql immutable as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end $$;

create function public.mkt_can_upload(p_campaign uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from marketing_campaigns c
     where c.id = p_campaign and c.stage not in ('done', 'cancelled')
       and (mkt_is_owner() or c.assignee_employee_id = any (mkt_my_employee_ids())
            or (c.assignee_role is not null and c.assignee_role = get_my_role())))
$$;

create policy campaign_files_read on storage.objects for select to authenticated
  using (bucket_id = 'campaign-files' and mkt_can_see(mkt_path_campaign(name)));
create policy campaign_files_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'campaign-files' and mkt_can_upload(mkt_path_campaign(name)));

-- ── Notifications: six new event types, switchable in Settings ─────────────
insert into public.notification_settings
  (event_type, label, category, enabled, person_target, audience_roles, sort, shop_floor, outlet_scoped, home_app) values
  ('campaign_review',         'Campaign draft sent for review → campaign owner', 'Marketing', true, true, null, 82, false, false, 'timekeeper'),
  ('campaign_changes',        'Campaign changes requested → assignee',           'Marketing', true, true, null, 83, false, false, 'timekeeper'),
  ('campaign_approved',       'Campaign draft approved → assignee',              'Marketing', true, true, null, 84, false, false, 'timekeeper'),
  ('campaign_published',      'Campaign published → campaign owner',             'Marketing', true, true, null, 85, false, false, 'timekeeper'),
  ('campaign_overdue',        'Campaign draft overdue → assignee',               'Marketing', true, true, null, 86, false, false, 'timekeeper'),
  ('campaign_review_waiting', 'Campaign review waiting 24h → campaign owner',    'Marketing', true, true, null, 87, false, false, 'timekeeper');

-- ── Internal helpers ────────────────────────────────────────────────────────
create function public.mkt_kuwait_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Kuwait')::date $$;

create function public.mkt_name(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select full_name from profiles where id = p_user), 'Someone')
$$;

-- The user behind the person a campaign is with, for notifications.
create function public.mkt_assignee_user(c public.marketing_campaigns) returns uuid
language sql stable security definer set search_path = public as $$
  select user_id from employees where id = c.assignee_employee_id
$$;

create function public.mkt_log(p_campaign uuid, p_action text, p_from text, p_to text, p_approval text,
                               p_note text, p_detail jsonb default '{}'::jsonb) returns void
language sql security definer set search_path = public as $$
  insert into marketing_campaign_events (campaign_id, actor, actor_name, action, from_stage, to_stage, approval_status, note, detail)
  values (p_campaign, auth.uid(), mkt_name(auth.uid()), p_action, p_from, p_to, p_approval, nullif(btrim(p_note), ''), coalesce(p_detail, '{}'::jsonb))
$$;

-- The Inbox task follows the campaign: open while there is work, closed at the end.
create function public.mkt_sync_task(c public.marketing_campaigns) returns void
language sql security definer set search_path = public as $$
  update assigned_tasks
     set status = case when c.stage = 'done' then 'Done' when c.stage = 'cancelled' then 'Cancelled' else 'Open' end,
         due_date = c.deadline,
         assignee_employee_id = c.assignee_employee_id,
         updated_at = now()
   where id = c.task_id
$$;

-- Where a product first arrived, by the best evidence there is:
--   lightspeed_receiving  Lightspeed's own receiving time on a purchase order that received it
--   first_detected        when our sync first saw it received (it arrived no later than this)
--   estimated_from_creation  the product's creation date in Lightspeed: an estimate only
create function public.mkt_product_arrival(p_product text, p_created timestamptz)
returns table (arrived_on date, arrival_basis text)
language sql stable security definer set search_path = public, world as $$
  with ls as (
    select min(po.ls_received_at) at time zone 'Asia/Kuwait' t
      from purchase_order_items i join purchase_orders po on po.id = i.po_id
     where i.ls_product_id = p_product and i.received_qty > 0 and po.ls_received_at is not null
  ), seen as (
    select min(coalesce(e.source_received_at, e.detected_at)) at time zone 'Asia/Kuwait' t
      from world.receipt_events e where e.ls_product_id = p_product and coalesce(e.new_received, 0) > 0
  )
  select case when (select t from ls) is not null then (select t from ls)::date
              when (select t from seen) is not null then (select t from seen)::date
              else (p_created at time zone 'Asia/Kuwait')::date end,
         case when (select t from ls) is not null then 'lightspeed_receiving'
              when (select t from seen) is not null then 'first_detected'
              when p_created is not null then 'estimated_from_creation' end
$$;

-- Products as the owners' form offers them: names, retail price, units in
-- stock, class, arrival. Never a cost.
create function public.mkt_products(p_brand text default null, p_search text default null, p_ids text[] default null)
returns table (product_id text, name text, brand text, retail_price numeric, on_hand numeric, units_90d numeric,
               class text, ownership text, arrived_on date, arrival_basis text)
language sql stable security definer set search_path = public as $$
  select r ->> 'product_id', r ->> 'name', r ->> 'brand', (r ->> 'price')::numeric, (r ->> 'on_hand')::numeric,
         (r ->> 'u90')::numeric, r ->> 'class', r ->> 'ownership', a.arrived_on, a.arrival_basis
    from (select rows from stock_analyst_metrics_cache where outlet_key = 'all' order by as_of desc, computed_at desc limit 1) m,
         jsonb_array_elements(m.rows) r,
         lateral mkt_product_arrival(r ->> 'product_id', (r ->> 'product_created')::timestamptz) a
   where (p_ids is null or r ->> 'product_id' = any (p_ids))
     and (p_brand is null or r ->> 'brand' = p_brand)
     and (p_search is null or r ->> 'name' ilike '%' || p_search || '%' or r ->> 'brand' ilike '%' || p_search || '%')
$$;

-- Does a product fit the objective? Null when it does, else the reason.
create function public.mkt_product_misfit(p_objective text, p_on_hand numeric, p_class text, p_ownership text,
                                          p_arrived date) returns text
language sql stable as $$
  select case
    when p_objective = 'slow_stock' and coalesce(p_ownership, '') <> 'owned' then 'only owned stock can be cleared'
    when p_objective = 'slow_stock' and coalesce(p_class, '') not in ('slow', 'dead') then 'not classed slow or dead'
    when p_objective in ('slow_stock', 'new_arrivals', 'best_seller') and coalesce(p_on_hand, 0) <= 0 then 'not in stock'
    when p_objective = 'new_arrivals' and (p_arrived is null or p_arrived < mkt_kuwait_today() - 60) then 'arrived more than 60 days ago'
    when p_objective = 'best_seller' and coalesce(p_class, '') not in ('fast', 'healthy') then 'not selling as a best seller'
  end
$$;

-- ── The rules: who may do what, from which stage ────────────────────────────
-- One place decides; campaign_act enforces it and campaign_detail lists it, so
-- the buttons a person sees are exactly the actions they may take.
create function public.mkt_allowed(c public.marketing_campaigns, p_action text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  is_owner boolean := mkt_is_owner();
  is_campaign_owner boolean := c.campaign_owner = auth.uid() and is_owner;
  is_assignee boolean := c.assignee_employee_id is not null and c.assignee_employee_id = any (mkt_my_employee_ids());
  is_team boolean := c.assignee_role is not null and c.assignee_role = get_my_role() and cardinality(mkt_my_employee_ids()) > 0;
  open_stage boolean := c.stage not in ('done', 'cancelled');
begin
  return case p_action
    when 'pick_up'           then c.stage = 'assigned' and (is_assignee or (is_team and c.assignee_employee_id is null))
    when 'add_draft'         then c.stage = 'working' and is_assignee
    when 'add_reference'     then open_stage and (is_owner or is_assignee)
    when 'comment'           then mkt_can_see(c.id)
    when 'submit'            then c.stage = 'working' and is_assignee and exists (
                                    select 1 from marketing_campaign_files f
                                     where f.campaign_id = c.id and f.kind = 'draft' and f.decision = 'none')
    when 'approve'           then c.stage = 'in_review' and is_campaign_owner
    when 'request_changes'   then c.stage = 'in_review' and is_campaign_owner
    when 'confirm_published' then c.stage = 'approved' and is_assignee
    when 'complete'          then c.stage = 'posted' and is_campaign_owner
    when 'cancel'            then open_stage and is_campaign_owner
    when 'hand_over'         then open_stage and is_campaign_owner
    when 'move_deadline'     then c.stage in ('assigned', 'working', 'in_review') and is_campaign_owner
    else false
  end;
end $$;

create function public.mkt_next_actions(c public.marketing_campaigns) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(a order by o), '{}') from unnest(array['pick_up', 'add_draft', 'submit', 'approve',
    'request_changes', 'confirm_published', 'complete', 'add_reference', 'comment', 'move_deadline', 'hand_over',
    'cancel']) with ordinality t(a, o) where mkt_allowed(c, a)
$$;

-- ── The owners' campaign form ───────────────────────────────────────────────
create function public.campaign_form_options(p_objective text default null, p_brand text default null,
                                             p_search text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not mkt_is_owner() then raise exception 'Only the owners can create campaigns'; end if;
  return jsonb_build_object(
    'objectives', (select jsonb_agg(to_jsonb(s) - 'updated_at' order by s.objective) from marketing_objective_settings s),
    'owners', (select jsonb_agg(jsonb_build_object('user_id', a.user_id, 'name', mkt_name(a.user_id)) order by mkt_name(a.user_id))
                 from stock_ai_access a),
    -- the marketing team: accounts with the marketing role, linked to an employee record
    'team', (select coalesce(jsonb_agg(jsonb_build_object(
                'employee_id', e.id, 'name', coalesce(p.full_name, e.full_name), 'job_title', e.job_title,
                'open_campaigns', (select count(*) from marketing_campaigns c
                                    where c.assignee_employee_id = e.id and c.stage not in ('done', 'cancelled')),
                'next_deadline', (select min(c.deadline) from marketing_campaigns c
                                   where c.assignee_employee_id = e.id and c.stage in ('assigned', 'working'))
              ) order by coalesce(p.full_name, e.full_name)), '[]')
               from employees e join profiles p on p.id = e.user_id where p.role = 'marketing'),
    'brands', (select coalesce(jsonb_agg(b order by b), '[]') from (
                 select distinct r ->> 'brand' b
                   from (select rows from stock_analyst_metrics_cache where outlet_key = 'all' order by as_of desc, computed_at desc limit 1) m,
                        jsonb_array_elements(m.rows) r
                  where r ->> 'brand' is not null) x),
    'products', case when p_objective is null or (p_brand is null and nullif(btrim(p_search), '') is null) then '[]'::jsonb else
      (select coalesce(jsonb_agg(jsonb_build_object(
          'product_id', product_id, 'name', name, 'brand', brand, 'retail_price', retail_price, 'on_hand', on_hand,
          'units_90d', units_90d, 'class', class, 'arrived_on', arrived_on, 'arrival_basis', arrival_basis,
          'misfit', mkt_product_misfit(p_objective, on_hand, class, ownership, arrived_on))
          order by mkt_product_misfit(p_objective, on_hand, class, ownership, arrived_on) nulls first, on_hand desc, name), '[]')
         from (select * from mkt_products(p_brand, nullif(btrim(p_search), '')) limit 300) x) end
  );
end $$;

-- ── Creating a campaign ─────────────────────────────────────────────────────
create function public.campaign_create(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  s marketing_objective_settings;
  v_id uuid;
  v_task uuid;
  v_owner uuid := coalesce(nullif(p ->> 'campaign_owner', '')::uuid, auth.uid());
  v_window int;
  v_products jsonb := '[]'::jsonb;
  v_ids text[] := coalesce(array(select jsonb_array_elements_text(p -> 'product_ids')), '{}');
  v_emp uuid := nullif(p ->> 'assignee_employee_id', '')::uuid;
  v_team boolean := coalesce((p ->> 'assign_to_team')::boolean, false);
  v_deadline date := nullif(p ->> 'deadline', '')::date;
  v_title text := btrim(coalesce(p ->> 'title', ''));
  v_priority text := coalesce(nullif(p ->> 'priority', ''), 'Normal');
  v_bad text;
  v_assignee_name text;
  r record;
begin
  if not mkt_is_owner() then raise exception 'Only the owners can create campaigns'; end if;
  if not exists (select 1 from stock_ai_access where user_id = v_owner) then
    raise exception 'The campaign owner must be one of the owners';
  end if;

  select * into s from marketing_objective_settings where objective = p ->> 'objective';
  if not found then raise exception 'Choose an objective'; end if;
  if char_length(v_title) < 3 then raise exception 'Give the campaign a title'; end if;
  if coalesce((p ->> 'target_value')::numeric, 0) <= 0 then raise exception 'Set a measurable target above zero'; end if;
  if coalesce(p ->> 'target_unit', '') <> all (s.target_units) then
    raise exception 'A % target is counted in %', s.label, array_to_string(s.target_units, ' or ');
  end if;
  v_window := coalesce(nullif(p ->> 'window_days', '')::int, s.default_window_days);
  if v_window < s.min_window_days then
    raise exception 'The comparison window for % is at least % days', s.label, s.min_window_days;
  end if;
  if v_deadline is null then raise exception 'Set a deadline'; end if;
  if v_deadline < mkt_kuwait_today() then raise exception 'The deadline is in the past'; end if;
  if v_emp is null and not v_team then raise exception 'Assign it to a person or to the marketing team'; end if;
  if v_emp is not null and not exists (
      select 1 from employees e join profiles pr on pr.id = e.user_id where e.id = v_emp and pr.role = 'marketing') then
    raise exception 'Campaigns go to the marketing team';
  end if;
  if coalesce(jsonb_array_length(p -> 'channels'), 0) = 0 then raise exception 'Choose at least one channel'; end if;

  -- products: checked against the objective, stored without any cost
  if cardinality(v_ids) > 0 then
    for r in select * from mkt_products(null, null, v_ids) loop
      v_bad := mkt_product_misfit(s.objective, r.on_hand, r.class, r.ownership, r.arrived_on);
      if v_bad is not null then raise exception '% does not fit %: %', r.name, s.label, v_bad; end if;
      v_products := v_products || jsonb_build_object('product_id', r.product_id, 'name', r.name, 'brand', r.brand,
        'arrived_on', r.arrived_on, 'arrival_basis', r.arrival_basis);
    end loop;
    if jsonb_array_length(v_products) <> cardinality(v_ids) then raise exception 'Some products were not found'; end if;
  end if;
  if s.objective <> 'brand_awareness' and jsonb_array_length(v_products) = 0 then
    raise exception 'Choose at least one product';
  end if;
  if s.objective = 'brand_awareness' and nullif(btrim(p ->> 'brand'), '') is null then
    raise exception 'Choose the brand';
  end if;

  insert into marketing_campaigns (created_by, campaign_owner, title, objective, target_value, target_unit, window_days,
    brand, products, channels, offer, offer_pct, content_kind, priority, deadline, budget_cap_kd, brief,
    assignee_employee_id, assignee_role, source_mission_key)
  values (auth.uid(), v_owner, v_title, s.objective, (p ->> 'target_value')::numeric, p ->> 'target_unit', v_window,
    coalesce(nullif(btrim(p ->> 'brand'), ''), (select string_agg(distinct x ->> 'brand', ', ') from jsonb_array_elements(v_products) x)),
    v_products, array(select jsonb_array_elements_text(p -> 'channels')), coalesce(nullif(p ->> 'offer', ''), 'none'),
    nullif(p ->> 'offer_pct', '')::numeric, nullif(p ->> 'content_kind', ''), v_priority, v_deadline,
    nullif(p ->> 'budget_cap_kd', '')::numeric, nullif(btrim(p ->> 'brief'), ''),
    v_emp, case when v_team then 'marketing' end, nullif(p ->> 'source_mission_key', ''))
  returning id into v_id;

  -- the ordinary Inbox task; the existing task trigger sends the existing notification
  insert into assigned_tasks (title, details, assignee_employee_id, assignee_name, assigned_by, priority, due_date,
                              status, assignee_role, source_table, source_id)
  values ('Campaign: ' || v_title,
          s.label || ' · target ' || trim(to_char((p ->> 'target_value')::numeric, 'FM999999990.###')) || ' ' ||
            replace(p ->> 'target_unit', '_', ' ') || ' · first draft due ' || to_char(v_deadline, 'DD Mon') ||
            '. Open it here to see the brief.',
          v_emp, (select full_name from employees where id = v_emp), mkt_name(auth.uid()),
          case v_priority when 'Urgent' then 'High' when 'High' then 'High' when 'Low' then 'Low' else 'Medium' end,
          v_deadline, 'Open', case when v_team then 'marketing' end, 'marketing_campaigns', v_id)
  returning id into v_task;
  update marketing_campaigns set task_id = v_task where id = v_id;

  v_assignee_name := coalesce((select full_name from employees where id = v_emp), 'the marketing team');
  perform mkt_log(v_id, 'created', null, 'assigned', 'not_submitted', null,
    jsonb_build_object('objective', s.objective, 'target', p -> 'target_value', 'unit', p ->> 'target_unit',
                       'window_days', v_window, 'deadline', v_deadline, 'campaign_owner', v_owner));
  perform mkt_log(v_id, 'assigned', null, 'assigned', 'not_submitted', 'Assigned to ' || v_assignee_name,
    jsonb_build_object('assignee_employee_id', v_emp, 'team', v_team));
  return v_id;
end $$;

-- ── Every step after that ───────────────────────────────────────────────────
create function public.campaign_act(p_campaign uuid, p_action text, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c marketing_campaigns;
  v_from text;
  v_note text := nullif(btrim(p ->> 'note'), '');
  v_version int;
  v_file marketing_campaign_files;
  v_links text[];
  v_at timestamptz;
  v_emp uuid;
  v_new_owner uuid;
  v_new_deadline date;
  v_url text := '#/inbox?campaign=' || p_campaign;
begin
  select * into c from marketing_campaigns where id = p_campaign for update;
  if not found or not mkt_can_see(p_campaign) then raise exception 'Campaign not found'; end if;
  v_from := c.stage;

  if p_action in ('add_file') then
    p_action := case when coalesce(p ->> 'kind', 'draft') = 'reference' then 'add_reference' else 'add_draft' end;
  end if;
  if not mkt_allowed(c, p_action) then
    raise exception '% is not possible for you at this stage (%)', replace(p_action, '_', ' '), replace(c.stage, '_', ' ');
  end if;

  if p_action = 'pick_up' then
    v_emp := coalesce(c.assignee_employee_id, (mkt_my_employee_ids())[1]);
    update marketing_campaigns set stage = 'working', assignee_employee_id = v_emp, picked_up_at = now(), updated_at = now()
     where id = c.id returning * into c;
    perform mkt_log(c.id, 'picked_up', v_from, c.stage, c.approval_status, v_note);

  elsif p_action in ('add_draft', 'add_reference') then
    if nullif(p ->> 'storage_path', '') is null and nullif(btrim(p ->> 'caption_text'), '') is null then
      raise exception 'Upload a file or write the caption';
    end if;
    if nullif(p ->> 'storage_path', '') is not null then
      if mkt_path_campaign(p ->> 'storage_path') is distinct from c.id then raise exception 'That file belongs to another campaign'; end if;
      if not exists (select 1 from storage.objects where bucket_id = 'campaign-files' and name = p ->> 'storage_path') then
        raise exception 'The upload has not arrived yet; try again';
      end if;
    end if;
    select coalesce(max(version), 0) + 1 into v_version from marketing_campaign_files where campaign_id = c.id;
    insert into marketing_campaign_files (campaign_id, version, kind, storage_path, file_name, mime, size_bytes, caption_text, uploaded_by)
    values (c.id, v_version, case when p_action = 'add_draft' then 'draft' else 'reference' end,
            nullif(p ->> 'storage_path', ''), nullif(p ->> 'file_name', ''), nullif(p ->> 'mime', ''),
            nullif(p ->> 'size_bytes', '')::bigint, nullif(btrim(p ->> 'caption_text'), ''), auth.uid())
    returning * into v_file;
    update marketing_campaigns set updated_at = now() where id = c.id returning * into c;
    perform mkt_log(c.id, 'file_added', v_from, c.stage, c.approval_status, v_note,
      jsonb_build_object('version', v_version, 'kind', v_file.kind, 'file_name', v_file.file_name));

  elsif p_action = 'comment' then
    if v_note is null then raise exception 'Write the comment'; end if;
    perform mkt_log(c.id, 'comment', v_from, c.stage, c.approval_status, v_note);

  elsif p_action = 'submit' then
    select max(version) into v_version from marketing_campaign_files
     where campaign_id = c.id and kind = 'draft' and decision = 'none';
    update marketing_campaign_files set decision = 'under_review' where campaign_id = c.id and version = v_version;
    update marketing_campaigns set stage = 'in_review', approval_status = 'awaiting',
           first_submitted_at = coalesce(first_submitted_at, now()), last_submitted_at = now(), updated_at = now()
     where id = c.id returning * into c;
    perform mkt_log(c.id, 'submitted', v_from, c.stage, c.approval_status, v_note, jsonb_build_object('version', v_version));
    perform notify_event('campaign_review', 'Draft ready for review', c.title || ' · version ' || v_version,
                         v_url, null, c.campaign_owner, auth.uid(), 'campaign_review:' || c.id || ':' || v_version);

  elsif p_action in ('approve', 'request_changes') then
    if p_action = 'request_changes' and v_note is null then raise exception 'Say what should change'; end if;
    select max(version) into v_version from marketing_campaign_files where campaign_id = c.id and decision = 'under_review';
    update marketing_campaign_files
       set decision = case when p_action = 'approve' then 'approved' else 'changes_requested' end,
           decided_by = auth.uid(), decided_at = now()
     where campaign_id = c.id and version = v_version;
    if p_action = 'approve' then
      update marketing_campaigns set stage = 'approved', approval_status = 'approved', approved_at = now(), updated_at = now()
       where id = c.id returning * into c;
      perform mkt_log(c.id, 'approved', v_from, c.stage, c.approval_status, v_note, jsonb_build_object('version', v_version));
      perform notify_event('campaign_approved', 'Draft approved', c.title || ' · version ' || v_version || ' approved. Post it, then confirm it here.',
                           v_url, null, mkt_assignee_user(c), auth.uid(), 'campaign_approved:' || c.id || ':' || v_version);
    else
      update marketing_campaigns set stage = 'working', approval_status = 'changes_requested',
             revision_rounds = revision_rounds + 1, updated_at = now()
       where id = c.id returning * into c;
      perform mkt_log(c.id, 'changes_requested', v_from, c.stage, c.approval_status, v_note, jsonb_build_object('version', v_version));
      perform notify_event('campaign_changes', 'Changes requested', c.title || ': ' || left(v_note, 120),
                           v_url, null, mkt_assignee_user(c), auth.uid(), 'campaign_changes:' || c.id || ':' || v_version);
    end if;

  elsif p_action = 'confirm_published' then
    v_links := coalesce(array(select btrim(x) from jsonb_array_elements_text(p -> 'links') x where btrim(x) <> ''), '{}');
    v_at := nullif(p ->> 'published_at', '')::timestamptz;
    if v_at is null then raise exception 'Say when it actually went out'; end if;
    if v_at > now() + interval '5 minutes' then raise exception 'The publication time is in the future'; end if;
    if v_at < c.approved_at - interval '1 day' then raise exception 'It cannot have gone out before it was approved'; end if;
    if cardinality(v_links) = 0 and not (c.channels <@ array['in_store_display', 'whatsapp_broadcast']) then
      raise exception 'Add the link to the post';
    end if;
    if exists (select 1 from unnest(v_links) l where l !~ '^https://') then raise exception 'Links must start with https://'; end if;
    update marketing_campaigns set stage = 'posted', published_at = v_at, published_confirmed_at = now(),
           post_links = v_links, updated_at = now()
     where id = c.id returning * into c;
    perform mkt_log(c.id, 'published', v_from, c.stage, c.approval_status, v_note,
      jsonb_build_object('published_at', v_at, 'links', to_jsonb(v_links)));
    perform notify_event('campaign_published', 'Campaign published', c.title || ' went out ' ||
                           to_char(v_at at time zone 'Asia/Kuwait', 'DD Mon HH24:MI'),
                         v_url, null, c.campaign_owner, auth.uid(), 'campaign_published:' || c.id);

  elsif p_action = 'complete' then
    update marketing_campaigns set stage = 'done', completed_at = now(),
           lesson = coalesce(nullif(btrim(p ->> 'lesson'), ''), lesson), updated_at = now()
     where id = c.id returning * into c;
    perform mkt_log(c.id, 'completed', v_from, c.stage, c.approval_status, v_note, jsonb_build_object('lesson', c.lesson));

  elsif p_action = 'cancel' then
    if v_note is null then raise exception 'Give the reason for cancelling'; end if;
    update marketing_campaigns set stage = 'cancelled', cancelled_at = now(), updated_at = now()
     where id = c.id returning * into c;
    perform mkt_log(c.id, 'cancelled', v_from, c.stage, c.approval_status, v_note);

  elsif p_action = 'hand_over' then
    v_new_owner := nullif(p ->> 'campaign_owner', '')::uuid;
    if v_new_owner is null or not exists (select 1 from stock_ai_access where user_id = v_new_owner) then
      raise exception 'Hand it to one of the owners';
    end if;
    update marketing_campaigns set campaign_owner = v_new_owner, updated_at = now() where id = c.id returning * into c;
    perform mkt_log(c.id, 'handed_over', v_from, c.stage, c.approval_status, v_note,
      jsonb_build_object('campaign_owner', v_new_owner, 'name', mkt_name(v_new_owner)));

  elsif p_action = 'move_deadline' then
    v_new_deadline := nullif(p ->> 'deadline', '')::date;
    if v_new_deadline is null or v_new_deadline < mkt_kuwait_today() then raise exception 'Choose a date from today on'; end if;
    if v_note is null then raise exception 'Give the reason for moving the deadline'; end if;
    perform mkt_log(c.id, 'deadline_moved', v_from, c.stage, c.approval_status, v_note,
      jsonb_build_object('from', c.deadline, 'to', v_new_deadline));
    update marketing_campaigns set deadline = v_new_deadline, updated_at = now() where id = c.id returning * into c;
  end if;

  perform mkt_sync_task(c);
  return campaign_detail(c.id);
end $$;

-- ── Reading a campaign ──────────────────────────────────────────────────────
-- Execution is measured from the record's own timestamps. Performance (sales,
-- Instagram) is a separate block that opens when the after window closes.
create function public.campaign_detail(p_campaign uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c marketing_campaigns;
  s marketing_objective_settings;
  v_review_hours numeric;
  v_after_from date;
begin
  select * into c from marketing_campaigns where id = p_campaign;
  if not found or not mkt_can_see(p_campaign) then raise exception 'Campaign not found'; end if;
  select * into s from marketing_objective_settings where objective = c.objective;

  -- time with the owner: each submission until the decision on it
  select round(sum(extract(epoch from (d.at - sb.at)) / 3600)::numeric, 1) into v_review_hours
    from marketing_campaign_events sb
    join lateral (select at from marketing_campaign_events d
                   where d.campaign_id = sb.campaign_id and d.id > sb.id and d.action in ('approved', 'changes_requested')
                   order by d.id limit 1) d on true
   where sb.campaign_id = c.id and sb.action = 'submitted';
  v_after_from := (c.published_at at time zone 'Asia/Kuwait')::date;

  return jsonb_build_object(
    'id', c.id, 'title', c.title, 'objective', c.objective, 'objective_label', s.label,
    'target_value', c.target_value, 'target_unit', c.target_unit, 'window_days', c.window_days,
    'brand', c.brand, 'products', c.products, 'channels', c.channels, 'offer', c.offer, 'offer_pct', c.offer_pct,
    'content_kind', c.content_kind, 'priority', c.priority, 'deadline', c.deadline, 'budget_cap_kd', c.budget_cap_kd,
    'brief', c.brief, 'stage', c.stage, 'approval_status', c.approval_status,
    'campaign_owner', c.campaign_owner, 'campaign_owner_name', mkt_name(c.campaign_owner),
    'assignee_employee_id', c.assignee_employee_id,
    'assignee_name', coalesce((select full_name from employees where id = c.assignee_employee_id),
                              case when c.assignee_role is not null then 'Marketing team' end),
    'post_links', c.post_links, 'lesson', c.lesson, 'created_at', c.created_at, 'updated_at', c.updated_at,
    'overdue', c.stage in ('assigned', 'working') and c.deadline < mkt_kuwait_today(),
    'viewer', jsonb_build_object('is_owner', mkt_is_owner(), 'is_campaign_owner', c.campaign_owner = auth.uid(),
                                 'is_assignee', c.assignee_employee_id = any (mkt_my_employee_ids())),
    'next_actions', to_jsonb(mkt_next_actions(c)),
    'execution', jsonb_build_object(
      'assigned_at', c.assigned_at, 'picked_up_at', c.picked_up_at, 'first_submitted_at', c.first_submitted_at,
      'approved_at', c.approved_at, 'published_at', c.published_at, 'published_confirmed_at', c.published_confirmed_at,
      'completed_at', c.completed_at, 'cancelled_at', c.cancelled_at,
      'pickup_hours', round((extract(epoch from (c.picked_up_at - c.assigned_at)) / 3600)::numeric, 1),
      'first_draft_days_vs_deadline', (c.first_submitted_at at time zone 'Asia/Kuwait')::date - c.deadline,
      'first_draft_on_time', case when c.first_submitted_at is null then null
                                  else (c.first_submitted_at at time zone 'Asia/Kuwait')::date <= c.deadline end,
      'revision_rounds', c.revision_rounds,
      'hours_with_owner', v_review_hours,
      'approval_to_publication_hours', round((extract(epoch from (c.published_at - c.approved_at)) / 3600)::numeric, 1),
      'days_assigned_to_completed', (c.completed_at at time zone 'Asia/Kuwait')::date - (c.assigned_at at time zone 'Asia/Kuwait')::date),
    'performance', jsonb_build_object(
      'status', case when c.published_at is null then 'not_published'
                     when v_after_from + c.window_days > mkt_kuwait_today() then 'window_running'
                     else 'window_closed' end,
      'after_window_from', v_after_from,
      'after_window_to', v_after_from + c.window_days - 1,
      'results_open_on', v_after_from + c.window_days,
      'note', 'Before-and-after results are measured separately from the work, once the window closes.'),
    'files', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'version', f.version, 'kind', f.kind,
                'storage_path', f.storage_path, 'file_name', f.file_name, 'mime', f.mime, 'size_bytes', f.size_bytes,
                'caption_text', f.caption_text, 'uploaded_by', mkt_name(f.uploaded_by), 'uploaded_at', f.uploaded_at,
                'decision', f.decision, 'decided_by', mkt_name(f.decided_by), 'decided_at', f.decided_at) order by f.version), '[]')
                from marketing_campaign_files f where f.campaign_id = c.id),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'who', e.actor_name, 'action', e.action,
                'from_stage', e.from_stage, 'to_stage', e.to_stage, 'note', e.note, 'detail', e.detail) order by e.id), '[]')
                from marketing_campaign_events e where e.campaign_id = c.id)
  );
end $$;

create function public.campaign_list() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'title', c.title, 'objective', c.objective, 'objective_label', s.label,
      'stage', c.stage, 'approval_status', c.approval_status, 'deadline', c.deadline, 'priority', c.priority,
      'campaign_owner_name', mkt_name(c.campaign_owner), 'is_campaign_owner', c.campaign_owner = auth.uid(),
      'assignee_name', coalesce((select full_name from employees where id = c.assignee_employee_id), 'Marketing team'),
      'overdue', c.stage in ('assigned', 'working') and c.deadline < mkt_kuwait_today(),
      'waiting_on', case when c.stage in ('in_review', 'posted') then 'owner'
                         when c.stage in ('assigned', 'working', 'approved') then 'team' else 'nobody' end,
      'updated_at', c.updated_at)
    order by (c.stage in ('done', 'cancelled')), c.deadline, c.created_at), '[]')
    from marketing_campaigns c join marketing_objective_settings s on s.objective = c.objective
   where mkt_can_see(c.id)
$$;

-- ── Daily reminders, 07:05 Kuwait ───────────────────────────────────────────
create function public.campaign_daily() returns void
language plpgsql security definer set search_path = public as $$
declare c marketing_campaigns; v_today date := mkt_kuwait_today();
begin
  for c in select * from marketing_campaigns where stage in ('assigned', 'working') and deadline < v_today loop
    perform notify_event('campaign_overdue', 'Campaign draft overdue', c.title || ' was due ' || to_char(c.deadline, 'DD Mon'),
      '#/inbox?campaign=' || c.id, case when c.assignee_employee_id is null then array['marketing'] end,
      mkt_assignee_user(c), null, 'campaign_overdue:' || c.id || ':' || v_today);
    insert into marketing_campaign_events (campaign_id, actor_name, action, from_stage, to_stage, approval_status, note)
    values (c.id, 'Reminder', 'reminded', c.stage, c.stage, c.approval_status, 'Draft overdue');
  end loop;
  for c in select * from marketing_campaigns where stage = 'in_review' and last_submitted_at < now() - interval '24 hours' loop
    perform notify_event('campaign_review_waiting', 'A draft is waiting for your review', c.title,
      '#/inbox?campaign=' || c.id, null, c.campaign_owner, null, 'campaign_review_waiting:' || c.id || ':' || v_today);
    insert into marketing_campaign_events (campaign_id, actor_name, action, from_stage, to_stage, approval_status, note)
    values (c.id, 'Reminder', 'reminded', c.stage, c.stage, c.approval_status, 'Review waiting over 24 hours');
  end loop;
end $$;

select cron.schedule('marketing-campaign-daily', '5 4 * * *', 'select public.campaign_daily()');

-- ── Who may call what ───────────────────────────────────────────────────────
-- Internal helpers are not callable from the app. The rule helpers stay
-- callable because the read rules use them.
revoke execute on function public.mkt_append_only(), public.mkt_name(uuid), public.mkt_assignee_user(public.marketing_campaigns),
  public.mkt_log(uuid, text, text, text, text, text, jsonb), public.mkt_sync_task(public.marketing_campaigns),
  public.mkt_product_arrival(text, timestamptz), public.mkt_products(text, text, text[]),
  public.mkt_product_misfit(text, numeric, text, text, date), public.mkt_allowed(public.marketing_campaigns, text),
  public.mkt_next_actions(public.marketing_campaigns), public.campaign_daily()
  from public, anon, authenticated;
revoke execute on function public.campaign_form_options(text, text, text), public.campaign_create(jsonb),
  public.campaign_act(uuid, text, jsonb), public.campaign_detail(uuid), public.campaign_list(),
  public.mkt_is_owner(), public.mkt_my_employee_ids(), public.mkt_can_see(uuid), public.mkt_can_upload(uuid),
  public.mkt_path_campaign(text), public.mkt_kuwait_today()
  from public, anon;
grant execute on function public.campaign_form_options(text, text, text), public.campaign_create(jsonb),
  public.campaign_act(uuid, text, jsonb), public.campaign_detail(uuid), public.campaign_list(),
  public.mkt_is_owner(), public.mkt_my_employee_ids(), public.mkt_can_see(uuid), public.mkt_can_upload(uuid),
  public.mkt_path_campaign(text), public.mkt_kuwait_today()
  to authenticated;
