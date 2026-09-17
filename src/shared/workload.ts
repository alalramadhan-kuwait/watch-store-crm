/**
 * How much each person actually worked over a stretch of days.
 *
 * A manager asking "is the work spread fairly" is not asking who is present —
 * that is today's question, answered by attendanceStatus. This is the other
 * one: over this week, or this month, who carried how much.
 *
 * Counted per person rather than per record, because a split shift is one day
 * worked and counting rows would call a morning-plus-evening day two days and
 * make somebody look twice as busy as they were.
 *
 * Fairness needs both halves. Somebody due four days who worked four is not
 * behind somebody due six — comparing raw hours flags the part-timer as a
 * slacker and the six-day person as a hero, which is a good way to teach a
 * manager to ignore the numbers. So days due are carried alongside.
 *
 * Mirrored byte-for-byte in timekeeper-online and watch-store-crm. See
 * src/shared/README.md before editing.
 */

import { dayHours, type ShiftInput } from './workedHours';
import { resolveOutlet } from './outlets';

export interface WorkRecord extends ShiftInput {
  /** Whoever it was — a roster name, a full name, an id. Grouping key. */
  who: string;
  /** yyyy-mm-dd, Kuwait. */
  date: string;
  outlet?: string | null;
}

export interface Workload {
  who: string;
  /** Total over the period, or null when nothing usable was recorded. */
  hours: number | null;
  /** Days with at least one usable record. */
  daysWorked: number;
  shifts: number;
  /** Records needing a correction before the total means anything. */
  unusableShifts: number;
  /** Days the schedule expected them, when it is known. */
  daysDue: number | null;
  /** Hours per day worked. */
  perDay: number | null;
  /** Hours per day they were due — the number worth comparing between people. */
  perDayDue: number | null;
}

export interface WorkloadOptions {
  /** Only this outlet, however it is spelled. */
  outlet?: string | null;
  /** Inclusive yyyy-mm-dd bounds. */
  from?: string;
  to?: string;
  /** Days each person was expected in over the period, by the same key as `who`. */
  daysDue?: Map<string, number>;
}

/** One row per person over the period, busiest first. */
export function workload(
  records: WorkRecord[],
  opts: WorkloadOptions = {},
  now: Date = new Date(),
): Workload[] {
  const code = opts.outlet ? resolveOutlet(opts.outlet) : null;

  const mine = records.filter((r) => {
    if (opts.from && r.date < opts.from) return false;
    if (opts.to && r.date > opts.to) return false;
    if (code && resolveOutlet(r.outlet) !== code) return false;
    return true;
  });

  // person -> day -> that day's records, so a split shift stays one day
  const byPerson = new Map<string, Map<string, ShiftInput[]>>();
  for (const r of mine) {
    let days = byPerson.get(r.who);
    if (!days) { days = new Map(); byPerson.set(r.who, days); }
    const list = days.get(r.date) ?? [];
    list.push({ clockIn: r.clockIn, clockOut: r.clockOut });
    days.set(r.date, list);
  }

  const rows: Workload[] = [];
  for (const [who, days] of byPerson) {
    let hours = 0;
    let usableDays = 0;
    let shifts = 0;
    let unusable = 0;
    let anyUsable = false;

    for (const records of days.values()) {
      const d = dayHours(records, now);
      shifts += d.shifts;
      unusable += d.unusableShifts;
      if (d.hours !== null) { hours += d.hours; usableDays++; anyUsable = true; }
    }

    const daysDue = opts.daysDue?.get(who) ?? null;
    rows.push({
      who,
      hours: anyUsable ? hours : null,
      daysWorked: usableDays,
      shifts,
      unusableShifts: unusable,
      daysDue,
      perDay: anyUsable && usableDays ? hours / usableDays : null,
      perDayDue: anyUsable && daysDue ? hours / daysDue : null,
    });
  }

  return rows.sort((a, b) => (b.hours ?? -1) - (a.hours ?? -1) || a.who.localeCompare(b.who));
}

export interface Fairness {
  /** Hours per day due, averaged across everybody who has one. */
  average: number | null;
  busiest: Workload | null;
  quietest: Workload | null;
  /** The gap between them, in hours per day due. */
  spread: number | null;
  /** True when somebody is carrying half a day more than somebody else, daily. */
  uneven: boolean;
}

/**
 * Whether the load is evenly spread.
 *
 * Compared as hours per day due, never as raw totals, so somebody who works
 * four days is measured against their four and not against a colleague's six.
 * Anyone whose hours cannot be known is left out rather than counted as zero —
 * an uncorrected record is a gap in the evidence, not a light week.
 */
export function fairness(rows: Workload[], tolerance = 0.5): Fairness {
  const comparable = rows.filter((r) => r.perDayDue !== null);
  if (comparable.length < 2) {
    return { average: comparable[0]?.perDayDue ?? null, busiest: null, quietest: null, spread: null, uneven: false };
  }
  const sorted = [...comparable].sort((a, b) => (b.perDayDue as number) - (a.perDayDue as number));
  const busiest = sorted[0];
  const quietest = sorted[sorted.length - 1];
  const spread = (busiest.perDayDue as number) - (quietest.perDayDue as number);
  return {
    average: comparable.reduce((t, r) => t + (r.perDayDue as number), 0) / comparable.length,
    busiest,
    quietest,
    spread,
    uneven: spread > tolerance,
  };
}
