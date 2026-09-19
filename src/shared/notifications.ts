/**
 * The notification feed, for both apps.
 *
 * The engine — triggers, quiet hours, batching, the flush job every thirty
 * seconds — has been running in the database for months, and until now exactly
 * one client read it. The store manager, who spends his day on the shop floor
 * app, was told nothing: not when a request arrived, not when one went overdue,
 * not when the owner decided something he had approved.
 *
 * Nothing here decides who may see what. `notifications` is row-level secured
 * on `person_user_id` and `audience_roles`, so the database already answers
 * that; this is a reader, and a reader that filtered on its own would only be a
 * second, weaker opinion.
 *
 * Mirrored byte-for-byte in timekeeper-online and watch-store-crm. See
 * src/shared/README.md before editing.
 */
import { supabase } from '../lib/supabase';

export interface FeedNotif {
  id: string;
  created_at: string;
  event_type: string;
  title: string;
  body: string;
  /** Where it points, in the sending app's routing. Each app maps it to its own. */
  url: string | null;
  read: boolean;
}

/** Events no feed should show: a rollup that exists to be pushed, not read. */
const NOT_IN_THE_FEED = new Set(['po_summary']);

/**
 * The event types that belong on a shop floor.
 *
 * Read from the database rather than listed here, because the decision is the
 * same for both apps and a list in the client is a second opinion waiting to
 * drift. `notification_settings.shop_floor` holds it; adding an event type in
 * future is one row, not a release.
 *
 * Why it exists at all: a store manager was addressed by every event whose
 * audience includes "manager", which is fifteen of the twenty-six types. Most
 * of what reached him — supplier payments, shipment updates, account changes,
 * geofence edits — is nothing he can act on from a shop, and a notification you
 * cannot act on teaches you the bell is noise. The one that needed him is then
 * the one he misses.
 */
async function shopFloorTypes(): Promise<string[]> {
  const { data } = await supabase.from('notification_settings')
    .select('event_type').eq('shop_floor', true).eq('enabled', true);
  return (data ?? []).map((r) => (r as { event_type: string }).event_type);
}

/**
 * Everything addressed to this person, newest first.
 *
 * Addressed means either named directly or sent to a role they hold. The
 * `exclude_user` column carries the person who caused the event — you are not
 * told about your own approval — which is applied here because the database
 * cannot know which of several audiences a reader arrived through.
 */
export async function loadMyNotifications(
  userId: string, role: string | null, opts: { limit?: number; shopFloorOnly?: boolean } = {},
): Promise<FeedNotif[]> {
  const limit = opts.limit ?? 100;
  const addressed = role
    ? `person_user_id.eq.${userId},audience_roles.cs.{${role}}`
    : `person_user_id.eq.${userId}`;

  const allowed = opts.shopFloorOnly ? await shopFloorTypes() : null;
  /* An empty allow-list means nothing is marked for the shop floor, which is a
     configuration answer, not a reason to fall back to showing everything. */
  if (allowed && allowed.length === 0) return [];

  let q = supabase.from('notifications')
    .select('id, created_at, event_type, title, body, url, exclude_user')
    .or(addressed);
  if (allowed) q = q.in('event_type', allowed);

  const [{ data: rows }, { data: reads }] = await Promise.all([
    q.order('created_at', { ascending: false }).limit(limit),
    supabase.from('notification_reads').select('notification_id').eq('user_id', userId),
  ]);

  const seen = new Set((reads ?? []).map((r) => (r as { notification_id: string }).notification_id));
  type Row = FeedNotif & { exclude_user: string | null };
  return ((rows ?? []) as unknown as Row[])
    .filter((n) => n.exclude_user !== userId && !NOT_IN_THE_FEED.has(n.event_type))
    .map((n) => ({
      id: n.id, created_at: n.created_at, event_type: n.event_type,
      title: n.title, body: n.body, url: n.url, read: seen.has(n.id),
    }));
}

/** The number on the bell. */
export async function unreadCount(
  userId: string, role: string | null, opts: { shopFloorOnly?: boolean } = {},
): Promise<number> {
  const list = await loadMyNotifications(userId, role, { ...opts, limit: 100 });
  return list.filter((n) => !n.read).length;
}

/** Marking read is per person, so the same notification can be new to somebody else. */
export async function markRead(userId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await supabase.from('notification_reads')
    .upsert(ids.map((id) => ({ user_id: userId, notification_id: id })), { onConflict: 'user_id,notification_id' });
}

/**
 * Where a notification should land in *this* app.
 *
 * The sender writes one URL, in the back office's routing, because the trigger
 * that writes it has no idea which app will read it. Rather than teach the
 * database about both, each app translates on arrival. An unknown destination
 * returns null and the row is shown without being clickable — better than a tap
 * that goes nowhere.
 */
export function routeFor(url: string | null, map: Record<string, string>): string | null {
  if (!url) return null;
  const path = url.replace(/^#/, '');
  const [base, query] = path.split('?');
  const to = map[base];
  if (!to) return null;
  return query ? `${to}?${query}` : to;
}
