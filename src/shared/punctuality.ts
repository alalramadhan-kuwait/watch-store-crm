/**
 * How late somebody was, and how early they left — in hours, against their own
 * shift.
 *
 * The old rule was 09:00–17:00 for everybody, hardcoded. That is the office's
 * day, and the shops do not work it: on the figures this replaced, a
 * salesperson on an afternoon shift was scored six hours late every day he
 * turned up on time, and a manager who starts at 08:30 and leaves at 15:30 was
 * "leaving early" thirteen days out of fourteen. Numbers like that do not get
 * argued with, they get ignored, which is worse than not having them.
 *
 * So lateness is measured against the schedule in force on that date — the
 * dated one, so last month is judged by last month's shift — and only falls
 * back to the shop-wide default when nobody has set one.
 *
 * Two things are deliberately not zero:
 *   - a day with no shift times anywhere is `null`, unknown, not "on time"
 *   - a day never clocked out of has no leaving time to judge
 *
 * Mirrored byte-for-byte in timekeeper-online and watch-store-crm. See
 * src/shared/README.md before editing.
 */

import { scheduleOn, type Schedule } from './schedule';
import type { ShiftInput } from './workedHours';

/** Arrival grace: how long after the shift starts still counts as on time. */
export const DEFAULT_GRACE_MINUTES = 60;

export type LateClass = 'On time' | 'Minor late' | 'Late' | 'Serious late';

/** Minutes past the grace deadline that separate one word from the next. */
const LATE_STEPS: Array<[number, LateClass]> = [
  [0, 'On time'],
  [15, 'Minor late'],
  [30, 'Late'],
];

export const lateClassOf = (minutesLate: number): LateClass => {
  for (const [limit, word] of LATE_STEPS) if (minutesLate <= limit) return word;
  return 'Serious late';
};

export interface ShiftTimes {
  /** 'HH:mm', or null when nobody has said. */
  start: string | null;
  end: string | null;
  /** Where the times came from, so a report can say when it is guessing. */
  source: 'schedule' | 'default' | 'none';
}

export interface PunctualityOptions {
  /** Shop-wide fallback when the person has no shift set, e.g. '09:00'. */
  defaultStart?: string | null;
  defaultEnd?: string | null;
  graceMinutes?: number;
}

/** Minutes past midnight, Kuwait, for an instant. UTC+3 all year. */
const kuwaitMinutes = (iso: string): number | null => {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const shifted = new Date(t + 3 * 3_600_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};

const minutesOf = (hhmm: string | null | undefined): number | null => {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

/** The shift somebody was on, on a date. */
export function shiftTimesOn(
  schedules: Schedule[],
  date: string,
  opts: PunctualityOptions = {},
): ShiftTimes {
  const s = scheduleOn(schedules, date);
  if (s?.shiftStart || s?.shiftEnd) {
    return { start: s.shiftStart?.slice(0, 5) ?? null, end: s.shiftEnd?.slice(0, 5) ?? null, source: 'schedule' };
  }
  const start = opts.defaultStart ?? null;
  const end = opts.defaultEnd ?? null;
  if (start || end) return { start, end, source: 'default' };
  return { start: null, end: null, source: 'none' };
}

export interface DayPunctuality {
  /** Hours past the grace deadline. null when the shift start is unknown. */
  hoursLate: number | null;
  /** Hours before the shift end. null when they never clocked out, or the
   *  shift end is unknown. */
  hoursEarly: number | null;
  lateClass: LateClass | null;
  /** Somebody decided this lateness was excused. */
  excused: boolean;
  shift: ShiftTimes;
}

export interface DayRecords {
  /** Every record for one person on one Kuwait day. */
  records: Array<ShiftInput & { justified?: boolean | null }>;
  schedules: Schedule[];
  date: string;
}

/**
 * One person, one day.
 *
 * Lateness belongs to the clock-in that opened the day — coming back from
 * lunch at two is not arriving late — and leaving early to the last clock-out.
 */
export function dayPunctuality(input: DayRecords, opts: PunctualityOptions = {}): DayPunctuality {
  const { records, schedules, date } = input;
  const grace = opts.graceMinutes ?? DEFAULT_GRACE_MINUTES;
  const shift = shiftTimesOn(schedules, date, opts);

  const arrivals = records
    .map((r) => ({ at: kuwaitMinutes(r.clockIn), justified: !!r.justified, raw: r.clockIn }))
    .filter((a): a is { at: number; justified: boolean; raw: string } => a.at !== null)
    .sort((a, b) => a.at - b.at);
  const departures = records
    .map((r) => (r.clockOut ? kuwaitMinutes(r.clockOut) : null))
    .filter((m): m is number => m !== null)
    .sort((a, b) => a - b);

  const first = arrivals[0] ?? null;
  const last = departures.length ? departures[departures.length - 1] : null;

  const startAt = minutesOf(shift.start);
  const endAt = minutesOf(shift.end);

  // An excused late arrival is a decision somebody already made; it is recorded
  // as excused rather than quietly dropped, so a report can show both.
  const excused = !!first?.justified;

  let hoursLate: number | null = null;
  let lateClass: LateClass | null = null;
  if (first && startAt !== null) {
    const over = Math.max(0, first.at - (startAt + grace));
    hoursLate = excused ? 0 : over / 60;
    lateClass = lateClassOf(over);
  }

  let hoursEarly: number | null = null;
  if (last !== null && endAt !== null) {
    hoursEarly = Math.max(0, endAt - last) / 60;
  }

  return { hoursLate, hoursEarly, lateClass, excused, shift };
}

export interface PunctualityTotals {
  /** Days with something recorded. */
  days: number;
  timesLate: number;
  timesEarly: number;
  /** Summed hours. null when no day could be judged at all. */
  hoursLate: number | null;
  hoursEarly: number | null;
  /** Late arrivals somebody excused; not counted in the totals above. */
  excusedDays: number;
  /** Days whose shift times nobody has set — the totals do not cover them. */
  daysWithoutShift: number;
  /** True when every judged day used the shop-wide default, not a real shift. */
  usedDefaultOnly: boolean;
}

/** A period's worth of days, added up. */
export function punctualityTotals(
  days: DayPunctuality[],
): PunctualityTotals {
  const judgedLate = days.filter((d) => d.hoursLate !== null);
  const judgedEarly = days.filter((d) => d.hoursEarly !== null);
  return {
    days: days.length,
    timesLate: days.filter((d) => (d.hoursLate ?? 0) > 0).length,
    timesEarly: days.filter((d) => (d.hoursEarly ?? 0) > 0).length,
    hoursLate: judgedLate.length ? judgedLate.reduce((t, d) => t + (d.hoursLate as number), 0) : null,
    hoursEarly: judgedEarly.length ? judgedEarly.reduce((t, d) => t + (d.hoursEarly as number), 0) : null,
    excusedDays: days.filter((d) => d.excused).length,
    daysWithoutShift: days.filter((d) => d.shift.source === 'none').length,
    usedDefaultOnly:
      days.length > 0 && days.every((d) => d.shift.source !== 'schedule'),
  };
}
