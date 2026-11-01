-- The Time Keeper video studio (the owner's film workflow with Claude) lives in its own schema, apart from the shop's data.
-- Nothing here is reachable through the public API: no grants to anon or authenticated, RLS on with no policies.
-- Only the `studio` Edge Function (service role) reads and writes it; it signs the owner in with a passcode of its own,
-- so the studio never creates an auth user (and so never a staff profile through handle_new_user).
create schema if not exists studio;
revoke all on schema studio from public, anon, authenticated;
grant usage on schema studio to service_role;

-- the studio's documents: one row per film, voice, ... (the shapes the studio page already uses)
create table studio.docs (
  collection text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

-- the owner's passcode (one row) and how sign-in attempts are going
create table studio.access (
  id smallint primary key default 1 check (id = 1),
  setup_hash text,                       -- a one-time code for the first sign-in; cleared once used
  pass_hash text,                        -- PBKDF2, set by the owner on first sign-in
  failed integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

-- signed-in devices (the owner) and Claude's upload key; only hashes are kept
create table studio.sessions (
  token_hash text primary key,
  kind text not null check (kind in ('owner', 'agent')),
  label text,
  created_at timestamptz not null default now(),
  last_seen timestamptz,
  expires_at timestamptz
);

-- what happened, both ways: the owner's taps for Claude to read, Claude's steps for the owner to see
create table studio.events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  who text not null check (who in ('owner', 'claude')),
  kind text not null,
  text text,
  data jsonb,
  seen_at timestamptz
);
create index events_unseen on studio.events (at) where seen_at is null;

alter table studio.docs enable row level security;
alter table studio.access enable row level security;
alter table studio.sessions enable row level security;
alter table studio.events enable row level security;
revoke all on all tables in schema studio from public, anon, authenticated;
grant all on all tables in schema studio to service_role;
grant usage, select on all sequences in schema studio to service_role;

-- films, voice samples and stills: private, served to the signed-in owner by short-lived signed links
insert into storage.buckets (id, name, public, file_size_limit)
values ('studio-media', 'studio-media', false, 52428800)
on conflict (id) do nothing;
