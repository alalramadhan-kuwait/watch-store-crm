-- The Instagram-style grid needs larger covers, shown as soon as they are made, not at the next 3-hour refresh.
update public.instagram_media set thumb = null where thumb is not null;

create or replace function public.ig_feed_thumbs()
returns void language plpgsql security definer set search_path to 'public' as $f$
declare out_d jsonb := '{}'; a text; v jsonb;
begin
  for a, v in select key, value from jsonb_each((select data from studio_state where key = 'dash')) loop
    out_d := out_d || jsonb_build_object(a, v || jsonb_build_object('feed', (
      select coalesce(jsonb_agg(f || jsonb_build_object('thumb', nullif(m.thumb, '')) order by o), '[]')
        from jsonb_array_elements(coalesce(v->'feed', '[]')) with ordinality x(f, o) left join instagram_media m on m.media_id = f->>'id')));
  end loop;
  update studio_state set data = out_d where key = 'dash';
end $f$;
revoke execute on function public.ig_feed_thumbs() from public, anon, authenticated;
grant execute on function public.ig_feed_thumbs() to service_role;

select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'instagram-thumbs'), schedule := '*/3 * * * *');
