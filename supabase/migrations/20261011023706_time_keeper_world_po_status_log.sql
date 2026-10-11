-- Time Keeper World: the Loading Dock's receiving history can show the receiving-status changes
-- the PO sync has recorded in po_notify_queue (kind 'po_status'). Read-only, owners only (through
-- world_guard, like every World function). The table itself stays closed to clients.
create or replace function public.world_po_status_log()
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
begin
  perform world_guard();
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'po_id', q.po_id, 'po_number', q.po_number, 'supplier', q.supplier, 'brand', q.brand,
             'status', q.new_value,
             -- when the daily sync first saw the change, not when the goods arrived
             'at', q.at, 'timestamp_basis', 'first_detected')
             order by q.at desc, q.id desc), '[]'::jsonb)
    from po_notify_queue q
    where q.kind = 'po_status');
end $function$;

revoke all on function public.world_po_status_log() from public, anon;
grant execute on function public.world_po_status_log() to authenticated;

comment on function public.world_po_status_log() is
  'Time Keeper World (owners only): receiving-status changes the PO sync recorded, newest first. Times are first-detected, not arrival.';
