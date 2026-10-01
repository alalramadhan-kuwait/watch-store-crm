/**
 * Which customers deserve attention, decided once.
 *
 * The database knows about 8,914 customers, and most of them bought once, a
 * long time ago. Measured on 1 October 2026, 1,095 of them (12%) either spent
 * 1,000 KD or bought three times, and between them account for 55% of
 * everything the shop has ever sold. The lists open on those, and the rest are
 * one search away.
 *
 * The groups work out of what the list already carries — no extra column, no
 * tagging by hand — so both apps read the same customer the same way.
 *
 *   top       spent 1,000 KD or more, or bought 3+ times, or is marked VIP —
 *             and has been seen in the last 12 months.
 *   win_back  the same, but not seen for 12 months or more. Worth a message.
 *   new       one purchase, in the last 60 days: the moment to earn a second.
 *   other     everyone else.
 *
 * "Seen" is the later of the last logged visit and the last purchase.
 *
 * Mirrored byte-for-byte in timekeeper-online and watch-store-crm. See
 * src/shared/README.md before editing.
 */

export const TOP_SPEND_KD = 1000;
export const TOP_PURCHASES = 3;
export const ACTIVE_DAYS = 365;
export const NEW_DAYS = 60;

export type CustomerGroup = 'top' | 'win_back' | 'new' | 'other';

export const GROUP_LABEL: Record<CustomerGroup, string> = {
  top: 'Top',
  win_back: 'Win back',
  new: 'New',
  other: '',
};

export interface TierInput {
  isVip: boolean;
  purchases: number;
  purchasesKD: number;
  lastVisit: string | null;
  lastPurchase: string | null;
}

/** The later of the last visit and the last purchase, or null. */
export function lastSeen(r: Pick<TierInput, 'lastVisit' | 'lastPurchase'>): string | null {
  const times = [r.lastVisit, r.lastPurchase].filter((t): t is string => !!t);
  return times.length ? times.sort().pop()! : null;
}

const daysSince = (iso: string | null, now: Date): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now.getTime() - t) / 86_400_000 : null;
};

/** High value by what they have spent or how often they have come back. */
export const isTop = (r: TierInput): boolean =>
  r.isVip || r.purchasesKD >= TOP_SPEND_KD || r.purchases >= TOP_PURCHASES;

export function groupOf(r: TierInput, now: Date = new Date()): CustomerGroup {
  const seen = daysSince(lastSeen(r), now);
  const active = seen !== null && seen <= ACTIVE_DAYS;
  if (isTop(r)) return active ? 'top' : 'win_back';
  const bought = daysSince(r.lastPurchase, now);
  if (r.purchases === 1 && bought !== null && bought <= NEW_DAYS) return 'new';
  return 'other';
}
