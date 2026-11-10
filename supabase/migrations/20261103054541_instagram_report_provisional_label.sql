-- A verdict reached without a same-age baseline, on a post under 6 days old, is provisional and says so («مبدئي»).
-- The report itself moves to ig_post_report_core; ig_post_report keeps its name and grants for every caller.
alter function public.ig_post_report(text, text) rename to ig_post_report_core;
create or replace function public.ig_post_report(p_media_id text, p_stage text default 'latest')
returns jsonb language sql stable security definer set search_path = public as $$
  select case when r->>'verdict' is not null and r->>'basis' = 'final' and (r->>'age_hours')::numeric < 144
                   and r->>'label' not like 'مبدئي%'
              then jsonb_set(r, '{label}', to_jsonb('مبدئي · ' || (r->>'label')))
              else r end
    from (select public.ig_post_report_core(p_media_id, p_stage) r) x
$$;
revoke execute on function public.ig_post_report(text, text), public.ig_post_report_core(text, text) from public, anon, authenticated;
grant execute on function public.ig_post_report(text, text), public.ig_post_report_core(text, text) to service_role;
