-- Payroll (owners only): salaries and increments, bonuses and deductions, store commission and a
-- monthly payroll that is locked once approved.
--
-- Kept in its own schema, closed to every client role, and read or written only through the
-- functions below, each of which refuses anyone but the three owners (stock_ai_allowed, the list
-- Time Keeper World uses). The employee record stays as it is: managers can read it, so no pay
-- figure is ever written there. Hours, leave and sales are read where they live, never copied.
--
-- Salaries are a history, not a field: an increment is a new row with its date and reason, and
-- nothing is overwritten or deleted. A bonus or deduction can be voided (kept, marked) until its
-- month is approved. An approved month is a frozen copy and does not change afterwards.
--
-- Commission (owners' rule, from October 2026): a shop that reaches its monthly sales target pays
-- its rate on the month's sales. Each salesperson earns the rate on the sales credited to them in
-- that shop (a sale credited to two people is split equally); sales credited to nobody are shown
-- apart so the owners decide. Sales are Lightspeed's, counted the way every report counts them.

create schema if not exists pay;
revoke all on schema pay from public, anon, authenticated;

create or replace function pay.forbid_change() returns trigger language plpgsql as $$
begin
  raise exception '% keeps its history: add a new entry instead', tg_table_name using errcode = '42501';
end $$;

create table if not exists pay.salaries (
  id bigint generated always as identity primary key,
  employee_id uuid not null references public.employees(id),
  effective_from date not null,
  basic numeric(12,3) not null check (basic >= 0),
  housing numeric(12,3) not null default 0 check (housing >= 0),
  transport numeric(12,3) not null default 0 check (transport >= 0),
  other numeric(12,3) not null default 0 check (other >= 0),
  reason text not null check (reason in ('Starting salary', 'Increment', 'Promotion', 'Correction')),
  note text,
  set_by uuid,
  set_by_name text not null,
  at timestamptz not null default now()
);
create index if not exists salaries_by_employee on pay.salaries (employee_id, effective_from desc, id desc);
create or replace trigger salaries_keep_history before update or delete on pay.salaries
  for each row execute function pay.forbid_change();

create table if not exists pay.adjustments (
  id bigint generated always as identity primary key,
  employee_id uuid not null references public.employees(id),
  month date not null check (extract(day from month) = 1),
  kind text not null check (kind in ('bonus', 'deduction')),
  label text not null,
  amount numeric(12,3) not null check (amount > 0),
  note text,
  set_by uuid,
  set_by_name text not null,
  at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by_name text
);
create index if not exists adjustments_by_month on pay.adjustments (month, employee_id);

create table if not exists pay.commission_rules (
  id bigint generated always as identity primary key,
  scope_code text not null references public.outlets(code),
  effective_from date not null check (extract(day from effective_from) = 1),
  target numeric(12,3) not null check (target >= 0),
  rate numeric(6,5) not null check (rate >= 0 and rate < 1),
  set_by_name text not null,
  at timestamptz not null default now(),
  unique (scope_code, effective_from)
);
create or replace trigger commission_rules_keep_history before update or delete on pay.commission_rules
  for each row execute function pay.forbid_change();

create table if not exists pay.months (
  month date primary key check (extract(day from month) = 1),
  approved_at timestamptz not null default now(),
  approved_by uuid,
  approved_by_name text not null,
  snapshot jsonb not null,
  paid_at timestamptz,
  paid_by_name text
);

revoke all on all tables in schema pay from public, anon, authenticated, service_role;

insert into pay.commission_rules (scope_code, effective_from, target, rate, set_by_name) values
  ('avenues', '2026-10-01', 45000, 0.025, 'Owners'' rule'),
  ('time_gallery', '2026-10-01', 10000, 0.025, 'Owners'' rule')
on conflict (scope_code, effective_from) do nothing;

/* Only the three owners. */
create or replace function pay.guard() returns void language plpgsql stable security definer
set search_path to 'public', 'pay' as $$
begin
  if auth.uid() is null or not public.stock_ai_allowed() then
    raise exception 'Payroll is limited to the owners.' using errcode = '42501';
  end if;
end $$;

create or replace function pay.my_name() returns text language sql stable security definer
set search_path to 'public' as $$
  select coalesce((select nullif(trim(full_name), '') from profiles where id = auth.uid()), 'Owner')
$$;

/* One month, worked out from the records: salary in force at the month's end, commission from the
   shops' Lightspeed sales, and the month's bonuses and deductions. */
create or replace function pay.compute(p_month date) returns jsonb language sql stable security definer
set search_path to 'public', 'pay' as $$
  with m as (select date_trunc('month', p_month)::date as m0,
                    (date_trunc('month', p_month) + interval '1 month')::date as m1),
  rules as (
    select distinct on (r.scope_code) r.scope_code, r.target, r.rate
    from pay.commission_rules r, m
    where r.effective_from <= m.m0
    order by r.scope_code, r.effective_from desc),
  sales as (
    select s.id, s.scope_code, s.total_price_incl as kd
    from lightspeed_sales s, m
    where s.sale_day >= m.m0 and s.sale_day < m.m1
      and s.status = any (lightspeed_sale_counts())
      and s.scope_code in (select scope_code from rules)),
  credits as (
    select c.sale_id, c.employee_id, count(*) over (partition by c.sale_id) as n
    from sale_credits c where c.sale_id in (select id from sales)),
  shops as (
    select r.scope_code, r.target, r.rate, o.display_name,
           coalesce(sum(s.kd), 0) as revenue,
           coalesce(sum(s.kd) filter (where not exists (select 1 from credits c where c.sale_id = s.id)), 0) as uncredited
    from rules r join outlets o on o.code = r.scope_code left join sales s on s.scope_code = r.scope_code
    group by r.scope_code, r.target, r.rate, o.display_name),
  own as (
    select c.employee_id, s.scope_code, sum(s.kd / c.n) as kd
    from credits c join sales s on s.id = c.sale_id group by 1, 2),
  comm as (
    select o.employee_id,
           round(sum(case when sh.revenue >= sh.target then o.kd * sh.rate else 0 end), 3) as commission,
           jsonb_agg(jsonb_build_object('shop', sh.display_name, 'sales', round(o.kd, 3),
             'commission', round(case when sh.revenue >= sh.target then o.kd * sh.rate else 0 end, 3))
             order by sh.display_name) as detail
    from own o join shops sh using (scope_code) group by o.employee_id),
  sal as (
    select distinct on (x.employee_id) x.*
    from pay.salaries x, m where x.effective_from < m.m1
    order by x.employee_id, x.effective_from desc, x.id desc),
  adj as (
    select a.employee_id,
           coalesce(sum(a.amount) filter (where a.kind = 'bonus'), 0) as bonuses,
           coalesce(sum(a.amount) filter (where a.kind = 'deduction'), 0) as deductions
    from pay.adjustments a, m where a.month = m.m0 and a.voided_at is null group by 1),
  people as (
    select e.id, coalesce(nullif(trim(e.dsr_staff_name), ''), e.full_name) as name, e.full_name, e.location, e.job_title
    from employees e
    where coalesce(e.status, 'Active') not in ('inactive', 'Inactive', 'Left', 'Terminated')
       or e.id in (select employee_id from sal) or e.id in (select employee_id from comm)),
  lines as (
    select p.id, p.name, p.full_name, p.location, p.job_title,
           sal.basic, sal.housing, sal.transport, sal.other,
           coalesce(sal.basic + sal.housing + sal.transport + sal.other, 0) as salary,
           coalesce(comm.commission, 0) as commission, coalesce(comm.detail, '[]'::jsonb) as commission_detail,
           coalesce(adj.bonuses, 0) as bonuses, coalesce(adj.deductions, 0) as deductions
    from people p left join sal on sal.employee_id = p.id left join comm on comm.employee_id = p.id
    left join adj on adj.employee_id = p.id)
  select jsonb_build_object(
    'month', (select m0 from m),
    'shops', coalesce((select jsonb_agg(jsonb_build_object(
               'code', scope_code, 'name', display_name, 'sales', round(revenue, 3), 'target', target, 'rate', rate,
               'reached', revenue >= target,
               'commission', round(case when revenue >= target then revenue * rate else 0 end, 3),
               'uncredited_sales', round(uncredited, 3),
               'uncredited_commission', round(case when revenue >= target then uncredited * rate else 0 end, 3))
               order by revenue desc) from shops), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
               'employee_id', id, 'name', name, 'full_name', full_name, 'location', location, 'job_title', job_title,
               'has_salary', basic is not null,
               'basic', coalesce(basic, 0), 'allowances', coalesce(housing + transport + other, 0), 'salary', salary,
               'commission', commission, 'commission_detail', commission_detail,
               'bonuses', bonuses, 'deductions', deductions,
               'net', salary + commission + bonuses - deductions)
               order by salary + commission + bonuses - deductions desc, name) from lines), '[]'::jsonb))
$$;

create or replace function pay.totals(j jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'salary', coalesce(sum((l ->> 'salary')::numeric), 0),
    'commission', coalesce(sum((l ->> 'commission')::numeric), 0),
    'bonuses', coalesce(sum((l ->> 'bonuses')::numeric), 0),
    'deductions', coalesce(sum((l ->> 'deductions')::numeric), 0),
    'net', coalesce(sum((l ->> 'net')::numeric), 0),
    'people', count(*))
  from jsonb_array_elements(coalesce(j -> 'lines', '[]'::jsonb)) l
$$;

revoke all on all functions in schema pay from public, anon, authenticated;

/* A month as the owners see it: the frozen copy once approved, otherwise worked out now. */
create or replace function public.pay_month(p_month date)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'pay' as $$
declare v_m date := date_trunc('month', p_month)::date; r pay.months; j jsonb;
begin
  perform pay.guard();
  select * into r from pay.months where month = v_m;
  j := coalesce(r.snapshot, pay.compute(v_m));
  return j || jsonb_build_object(
    'month', v_m, 'totals', pay.totals(j),
    'status', case when r.month is null then 'open' when r.paid_at is null then 'approved' else 'paid' end,
    'approved_at', r.approved_at, 'approved_by', r.approved_by_name, 'paid_at', r.paid_at, 'paid_by', r.paid_by_name,
    'adjustments', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'employee_id', a.employee_id, 'kind', a.kind,
                      'label', a.label, 'amount', a.amount, 'note', a.note, 'by', a.set_by_name, 'at', a.at,
                      'voided_at', a.voided_at, 'voided_by', a.voided_by_name) order by a.at), '[]'::jsonb)
                    from pay.adjustments a where a.month = v_m));
end $$;

/* Totals for the last months, for the chart. */
create or replace function public.pay_history(p_months integer default 6)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'pay' as $$
declare v_out jsonb := '[]'::jsonb; v_m date; j jsonb; i integer;
begin
  perform pay.guard();
  for i in reverse least(greatest(coalesce(p_months, 6), 1), 24) - 1 .. 0 loop
    v_m := (date_trunc('month', (now() at time zone 'Asia/Kuwait')) - make_interval(months => i))::date;
    j := coalesce((select snapshot from pay.months where month = v_m), pay.compute(v_m));
    v_out := v_out || jsonb_build_array(jsonb_build_object('month', v_m, 'totals', pay.totals(j),
               'approved', exists (select 1 from pay.months where month = v_m)));
  end loop;
  return v_out;
end $$;

/* One person: their salary history (every increment) and their recent months. */
create or replace function public.pay_employee(p_employee uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'pay' as $$
begin
  perform pay.guard();
  return jsonb_build_object(
    'salaries', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'effective_from', s.effective_from,
                   'basic', s.basic, 'housing', s.housing, 'transport', s.transport, 'other', s.other,
                   'total', s.basic + s.housing + s.transport + s.other, 'reason', s.reason, 'note', s.note,
                   'by', s.set_by_name, 'at', s.at) order by s.effective_from desc, s.id desc), '[]'::jsonb)
                 from pay.salaries s where s.employee_id = p_employee));
end $$;

create or replace function public.pay_salary_add(p_employee uuid, p_effective_from date, p_basic numeric,
  p_housing numeric default 0, p_transport numeric default 0, p_other numeric default 0,
  p_reason text default 'Increment', p_note text default null)
returns jsonb language plpgsql security definer set search_path to 'public', 'pay' as $$
declare v_id bigint;
begin
  perform pay.guard();
  if not exists (select 1 from employees where id = p_employee) then
    raise exception 'No employee with that id.' using errcode = 'P0002';
  end if;
  if p_effective_from is null or p_effective_from > ((now() at time zone 'Asia/Kuwait')::date + 366) then
    raise exception 'Give the date the salary starts (at most a year ahead).' using errcode = '22023';
  end if;
  insert into pay.salaries (employee_id, effective_from, basic, housing, transport, other, reason, note, set_by, set_by_name)
  values (p_employee, p_effective_from, coalesce(p_basic, 0), coalesce(p_housing, 0), coalesce(p_transport, 0),
          coalesce(p_other, 0), coalesce(p_reason, 'Increment'), nullif(trim(coalesce(p_note, '')), ''), auth.uid(), pay.my_name())
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.pay_adjust_add(p_employee uuid, p_month date, p_kind text, p_label text,
  p_amount numeric, p_note text default null)
returns jsonb language plpgsql security definer set search_path to 'public', 'pay' as $$
declare v_m date := date_trunc('month', p_month)::date; v_id bigint;
begin
  perform pay.guard();
  if exists (select 1 from pay.months where month = v_m) then
    raise exception 'That month is approved and locked.' using errcode = '22023';
  end if;
  if not exists (select 1 from employees where id = p_employee) then
    raise exception 'No employee with that id.' using errcode = 'P0002';
  end if;
  if nullif(trim(coalesce(p_label, '')), '') is null then
    raise exception 'Say what it is for.' using errcode = '22023';
  end if;
  insert into pay.adjustments (employee_id, month, kind, label, amount, note, set_by, set_by_name)
  values (p_employee, v_m, p_kind, trim(p_label), p_amount, nullif(trim(coalesce(p_note, '')), ''), auth.uid(), pay.my_name())
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.pay_adjust_void(p_id bigint)
returns jsonb language plpgsql security definer set search_path to 'public', 'pay' as $$
declare a pay.adjustments;
begin
  perform pay.guard();
  select * into a from pay.adjustments where id = p_id;
  if a.id is null then raise exception 'Nothing to remove.' using errcode = 'P0002'; end if;
  if exists (select 1 from pay.months where month = a.month) then
    raise exception 'That month is approved and locked.' using errcode = '22023';
  end if;
  update pay.adjustments set voided_at = now(), voided_by_name = pay.my_name() where id = p_id and voided_at is null;
  return jsonb_build_object('ok', true);
end $$;

/* Approve a month: keep a frozen copy. From then on the month reads from the copy. */
create or replace function public.pay_month_approve(p_month date)
returns jsonb language plpgsql security definer set search_path to 'public', 'pay' as $$
declare v_m date := date_trunc('month', p_month)::date;
begin
  perform pay.guard();
  if v_m > date_trunc('month', (now() at time zone 'Asia/Kuwait'))::date then
    raise exception 'A month can be approved once it has started.' using errcode = '22023';
  end if;
  insert into pay.months (month, approved_by, approved_by_name, snapshot)
  values (v_m, auth.uid(), pay.my_name(), pay.compute(v_m))
  on conflict (month) do nothing;
  if not found then raise exception 'That month is already approved.' using errcode = '22023'; end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.pay_month_paid(p_month date)
returns jsonb language plpgsql security definer set search_path to 'public', 'pay' as $$
declare v_m date := date_trunc('month', p_month)::date;
begin
  perform pay.guard();
  update pay.months set paid_at = now(), paid_by_name = pay.my_name() where month = v_m and paid_at is null;
  if not found then raise exception 'Approve the month first.' using errcode = '22023'; end if;
  return jsonb_build_object('ok', true);
end $$;

/* Only the void columns of a bonus or deduction may change. */
create or replace function pay.adjustment_only_void() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or (to_jsonb(new) - 'voided_at' - 'voided_by_name') <> (to_jsonb(old) - 'voided_at' - 'voided_by_name')
     or old.voided_at is not null then
    raise exception 'A bonus or deduction is kept; remove it instead of editing it.' using errcode = '42501';
  end if;
  return new;
end $$;
create or replace trigger adjustments_only_void before update or delete on pay.adjustments
  for each row execute function pay.adjustment_only_void();

/* An approved month's copy never changes; only its payment date is added. */
create or replace function pay.month_frozen() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or (to_jsonb(new) - 'paid_at' - 'paid_by_name') <> (to_jsonb(old) - 'paid_at' - 'paid_by_name')
     or old.paid_at is not null then
    raise exception 'An approved month does not change.' using errcode = '42501';
  end if;
  return new;
end $$;
create or replace trigger months_frozen before update or delete on pay.months
  for each row execute function pay.month_frozen();

revoke all on all functions in schema pay from public, anon, authenticated;
revoke all on function public.pay_month(date), public.pay_history(integer), public.pay_employee(uuid),
  public.pay_salary_add(uuid, date, numeric, numeric, numeric, numeric, text, text),
  public.pay_adjust_add(uuid, date, text, text, numeric, text), public.pay_adjust_void(bigint),
  public.pay_month_approve(date), public.pay_month_paid(date) from public, anon;
grant execute on function public.pay_month(date), public.pay_history(integer), public.pay_employee(uuid),
  public.pay_salary_add(uuid, date, numeric, numeric, numeric, numeric, text, text),
  public.pay_adjust_add(uuid, date, text, text, numeric, text), public.pay_adjust_void(bigint),
  public.pay_month_approve(date), public.pay_month_paid(date) to authenticated;
