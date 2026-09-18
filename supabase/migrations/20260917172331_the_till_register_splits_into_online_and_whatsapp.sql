-- One till register, two channels.
--
-- The POS has three registers, but the shop sells through four channels: the
-- register called "Time Keeper" carries both the online shop and the WhatsApp
-- orders Eman handles. Split by who rang the sale up: Eman's are WhatsApp, the
-- rest are Online.
--
-- Nothing historical is rewritten. lightspeed_sales_daily stays exactly as it
-- is — the per-outlet, per-day total from the till, and the figure everything
-- else must still add up to. The split is derived beside it and reconciled
-- against it, so a day always totals what the till said even when the split
-- cannot be worked out.

create table if not exists public.lightspeed_sales_by_staff (
  outlet      text not null,
  sale_date   date not null,
  salesperson text not null,
  revenue     numeric not null default 0,
  units       numeric not null default 0,
  sale_count  integer not null default 0,
  synced_at   timestamptz not null default now(),
  primary key (outlet, sale_date, salesperson)
);

comment on table public.lightspeed_sales_by_staff is
  'Till revenue per outlet per day per salesperson, written by lightspeed-sync from the same pages it already fetches. Exists so one register can be split between the channels it serves. lightspeed_sales_daily remains the authoritative outlet-day total.';

create index if not exists lightspeed_sales_by_staff_date_idx
  on public.lightspeed_sales_by_staff (sale_date desc);

alter table public.lightspeed_sales_by_staff enable row level security;
drop policy if exists ls_staff_read on public.lightspeed_sales_by_staff;
create policy ls_staff_read on public.lightspeed_sales_by_staff
  for select to authenticated using (true);

-- The rule, as data: a second person selling on WhatsApp is one row, not a
-- deployment.
create table if not exists public.pos_channel_rules (
  id           uuid primary key default gen_random_uuid(),
  pos_name     text not null,
  salesperson  text,
  channel_code text not null references public.outlets(code),
  priority     int not null default 100,
  note         text,
  created_at   timestamptz not null default now()
);

comment on table public.pos_channel_rules is
  'How one till register divides between canonical channels, by who rang the sale up. Lowest priority wins; a null salesperson is the catch-all for that register.';
comment on column public.pos_channel_rules.salesperson is
  'Matched case-insensitively as a substring of the till user name, so "Eman" matches "Eman Salman". Null means everyone not matched by a more specific rule.';

insert into public.pos_channel_rules (pos_name, salesperson, channel_code, priority, note)
select * from (values
  ('Time Keeper', 'Eman', 'whatsapp', 10,
   'Eman handles the WhatsApp orders; what she rings up on this register is the WhatsApp channel'),
  ('Time Keeper', null,   'online',  100,
   'Everything else on this register is the online shop')
) v(pos_name, salesperson, channel_code, priority, note)
where not exists (select 1 from public.pos_channel_rules);

alter table public.pos_channel_rules enable row level security;
drop policy if exists pos_rules_read on public.pos_channel_rules;
create policy pos_rules_read on public.pos_channel_rules
  for select to authenticated using (true);
drop policy if exists pos_rules_write on public.pos_channel_rules;
create policy pos_rules_write on public.pos_channel_rules for all to authenticated
  using (get_my_role() = any (array['admin', 'manager']))
  with check (get_my_role() = any (array['admin', 'manager']));

create or replace function public.pos_splits_by_staff(p_outlet text)
returns boolean
language sql stable
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1 from public.pos_channel_rules r
     where public.outlet_key(r.pos_name) = public.outlet_key(p_outlet)
       and r.salesperson is not null
  )
$$;

comment on function public.pos_splits_by_staff(text) is
  'True when this till register serves more than one channel and needs the salesperson to tell them apart.';

create or replace function public.resolve_channel(p_outlet text, p_salesperson text default null)
returns text
language sql stable
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(
    (select r.channel_code
       from public.pos_channel_rules r
      where public.outlet_key(r.pos_name) = public.outlet_key(p_outlet)
        and (
          r.salesperson is null
          or (p_salesperson is not null and p_salesperson ilike '%' || r.salesperson || '%')
        )
      order by r.priority, (r.salesperson is null)
      limit 1),
    public.resolve_outlet(p_outlet)
  )
$$;

comment on function public.resolve_channel(text, text) is
  'The canonical channel a till sale belongs to, from the register it was rung on and who rang it. Falls back to resolve_outlet() for a register that serves one channel.';

-- Every row of lightspeed_sales_daily accounted for exactly once. Where the
-- salesperson is known the day is split; whatever is left over — a day synced
-- before the salesperson was recorded, or a sale rung up by nobody — goes to the
-- register's catch-all channel and is marked unattributed, so the total always
-- matches the till and nothing is silently lost or counted twice.
create or replace view public.pos_channel_sales
with (security_invoker = true) as
with by_channel as (
  select s.outlet,
         s.sale_date,
         public.resolve_channel(s.outlet, s.salesperson) as channel_code,
         sum(s.revenue)    as revenue,
         sum(s.units)      as units,
         sum(s.sale_count) as sale_count
    from public.lightspeed_sales_by_staff s
   group by 1, 2, 3
),
covered as (
  select outlet, sale_date,
         sum(revenue) as revenue, sum(units) as units, sum(sale_count) as sale_count
    from by_channel
   group by 1, 2
)
select b.outlet, b.sale_date, b.channel_code, b.revenue, b.units, b.sale_count,
       true as attributed
  from by_channel b
union all
select d.outlet,
       d.sale_date,
       public.resolve_channel(d.outlet, null),
       d.revenue    - coalesce(c.revenue, 0),
       d.units      - coalesce(c.units, 0),
       d.sale_count - coalesce(c.sale_count, 0),
       not public.pos_splits_by_staff(d.outlet)
  from public.lightspeed_sales_daily d
  left join covered c on c.outlet = d.outlet and c.sale_date = d.sale_date
 where abs(d.revenue - coalesce(c.revenue, 0)) > 0.0005
    or d.sale_count - coalesce(c.sale_count, 0) <> 0;

comment on view public.pos_channel_sales is
  'Till revenue by canonical channel and Kuwait day. Sums back to lightspeed_sales_daily exactly: attributed rows come from the salesperson, and any remainder is carried in the register''s catch-all channel with attributed = false.';

grant select on public.lightspeed_sales_by_staff, public.pos_channel_rules,
                public.pos_channel_sales to authenticated;
grant execute on function public.resolve_channel(text, text),
                          public.pos_splits_by_staff(text) to authenticated;

-- A target each, now the register is two channels. The old figure moves to
-- Online — the catch-all, carrying about three quarters of the takings — and
-- WhatsApp starts blank so it shows no target line rather than a guess.
alter table public.settings add column if not exists sales_target_online   numeric;
alter table public.settings add column if not exists sales_target_whatsapp numeric;

comment on column public.settings.sales_target_online is
  'Monthly target in KD for the Time Keeper Online channel.';
comment on column public.settings.sales_target_whatsapp is
  'Monthly target in KD for the Time Keeper WhatsApp channel (Eman''s sales on the Time Keeper register).';
comment on column public.settings.sales_target_timekeeper is
  'Deprecated: the old single target for the whole Time Keeper register, before it was split into Online and WhatsApp. Kept so nothing that still reads it breaks.';

update public.settings
   set sales_target_online = sales_target_timekeeper
 where sales_target_online is null
   and sales_target_timekeeper is not null;
