/**
 * When a shop opened and closed, derived from who was standing in it.
 *
 * Applies to the two shops only. Online and WhatsApp sell things but have no
 * floor, no geofence and no opening time, and the office has staff but is not a
 * shop — asking any of them when they opened is a question with no answer, so
 * this returns null rather than inventing one.
 *
 * The rule:
 *   first valid check-in of the day  -> the shop is open
 *   at least one person still in     -> it stays open
 *   the last person clocks out       -> it closes
 * A manager on the floor counts like anyone else. Past dates use the same rule.
 *
 * Mirrored byte-for-byte in timekeeper-online and watch-store-crm. See
 * src/shared/README.md before editing.
 */

import { shiftHours, type ShiftInput } from './workedHours';
import { resolveOutlet, tracksStoreDay, type Outlet, type OutletCode } from './outlets';

export interface StoreShift extends ShiftInput {
  /** However the record spells it — it is resolved here. */
  outlet: string | null;
  /** Whoever it was; used only to count heads. */
  who: string;
}

export interface StoreDay {
  outlet: OutletCode;
  date: string;
  openedAt: string | null;
  closedAt: string | null;
  isOpen: boolean;
  /** People on the floor right now. */
  staffIn: number;
  /** People who worked any part of the day. */
  staffTotal: number;
  /** Records left open from a past day, which would otherwise hold it open. */
  abandoned: number;
}

/**
 * The day for one shop. Returns null when the outlet has no opening hours —
 * a digital channel, the office, or a name nobody recognises.
 */
export function storeDay(
  shifts: StoreShift[],
  outlet: string,
  date: string,
  now: Date = new Date(),
  registry?: Outlet[],
): StoreDay | null {
  const code = resolveOutlet(outlet, registry);
  if (!code || !tracksStoreDay(outlet, registry)) return null;

  const mine = shifts.filter((s) => resolveOutlet(s.outlet, registry) === code);
  const graded = mine.map((s) => ({ shift: s, state: shiftHours(s, now) }));

  // A clock-in nobody ever closed must not keep the shop open for six weeks.
  const live = graded.filter((g) => g.state.isOpen && !g.state.isAbandoned);
  const closings = graded
    .map((g) => g.shift.clockOut)
    .filter((t): t is string => !!t)
    .sort();
  const openings = graded.map((g) => g.shift.clockIn).sort();

  return {
    outlet: code,
    date,
    openedAt: openings[0] ?? null,
    closedAt: live.length ? null : closings[closings.length - 1] ?? null,
    isOpen: live.length > 0,
    staffIn: new Set(live.map((g) => g.shift.who)).size,
    staffTotal: new Set(mine.map((s) => s.who)).size,
    abandoned: graded.filter((g) => g.state.isAbandoned).length,
  };
}

/** Row shape returned by the store_day() database function. */
export interface StoreDayRow {
  outlet_code: string;
  work_date: string;
  opened_at: string | null;
  closed_at: string | null;
  is_open: boolean;
  staff_in: number;
  staff_total: number;
}

export const storeDayFromRow = (r: StoreDayRow): StoreDay => ({
  outlet: r.outlet_code as OutletCode,
  date: r.work_date,
  openedAt: r.opened_at,
  closedAt: r.closed_at,
  isOpen: r.is_open,
  staffIn: r.staff_in,
  staffTotal: r.staff_total,
  abandoned: 0,
});

/** `Open since 10:45`, `Closed 21:30`, `Did not open`. */
export function describeStoreDay(day: StoreDay | null, unavailable = 'No opening hours'): string {
  if (!day) return unavailable;
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Kuwait',
    });
  if (day.isOpen && day.openedAt) return `Open since ${time(day.openedAt)}`;
  if (day.closedAt) return `Closed ${time(day.closedAt)}`;
  if (day.openedAt) return `Opened ${time(day.openedAt)}`;
  return 'Did not open';
}
