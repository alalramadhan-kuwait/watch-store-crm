-- instagram-sync settings: the Graph API version it calls and any newer metrics to ask for per kind
-- ({"REELS": [...], "FEED": [...]}), so a new Instagram metric can be tried without a deploy. A metric
-- Instagram refuses is left out of that run, so a wrong name costs nothing.
alter table public.instagram_auth
  add column if not exists graph_version text not null default 'v21.0',
  add column if not exists extra_metrics jsonb not null default '{}';
comment on column public.instagram_auth.graph_version is 'Graph API version instagram-sync calls, e.g. v21.0.';
comment on column public.instagram_auth.extra_metrics is 'Extra post metrics instagram-sync asks for: {"REELS": [...], "FEED": [...]}.';
