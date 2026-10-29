-- Shareable valuation questionnaire: people without an account answer through a link carrying a token.
-- Anonymous visitors can only (a) read the question list for a valid token and (b) submit answers; they can read nothing else.
create table public.val_form (
  token text primary key,
  label text,
  questions jsonb not null,
  active boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.val_submissions (
  id bigserial primary key,
  token text not null references public.val_form(token) on delete cascade,
  respondent text,
  answers jsonb not null,
  submitted_at timestamptz not null default now()
);
create index val_submissions_token_idx on public.val_submissions (token, submitted_at desc);
comment on table public.val_form is 'Shareable valuation questionnaire links (token = the secret in the link). Owners only; anonymous access is through val_form_get/val_form_submit.';
comment on table public.val_submissions is 'Answers sent through a val_form link. Owners read them; anonymous visitors can only insert through val_form_submit.';
alter table public.val_form enable row level security;
alter table public.val_submissions enable row level security;
create policy val_form_owners on public.val_form for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy val_submissions_owners on public.val_submissions for all to authenticated using (public.is_owner()) with check (public.is_owner());
revoke all on public.val_form, public.val_submissions from anon;

create or replace function public.val_form_get(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('label', label, 'questions', questions)
  from public.val_form
  where token = p_token and active and (expires_at is null or expires_at > now());
$$;

create or replace function public.val_form_submit(p_token text, p_respondent text, p_answers jsonb) returns boolean
language plpgsql volatile security definer set search_path = public as $$
begin
  if not exists (select 1 from public.val_form where token = p_token and active and (expires_at is null or expires_at > now())) then
    raise exception 'This link is no longer active';
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' or octet_length(p_answers::text) > 60000 then
    raise exception 'Answers are missing or too long';
  end if;
  if (select count(*) from public.val_submissions where token = p_token and submitted_at > now() - interval '1 day') >= 30 then
    raise exception 'Too many submissions today — please try again tomorrow';
  end if;
  insert into public.val_submissions (token, respondent, answers) values (p_token, left(nullif(trim(p_respondent), ''), 100), p_answers);
  return true;
end $$;

revoke all on function public.val_form_get(text), public.val_form_submit(text, text, jsonb) from public;
grant execute on function public.val_form_get(text), public.val_form_submit(text, text, jsonb) to anon, authenticated;
-- The link token and its question list were inserted directly in the database (kept out of this public repo).
