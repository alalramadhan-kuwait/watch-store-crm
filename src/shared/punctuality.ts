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
  /**
   * The grace this shift carries, if it names one. Null falls back to the
   * company default. Zero is a real answer, not a missing one: it means the
   * shift start is the deadline.
   */
  graceMinutes: number | null;
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

/**
 * The shift somebody was on, on a date.
 *
 * Three states, and the third one matters. A schedule that sets times is
 * judged against them. Somebody with no schedule at all falls back to the
 * shop-wide default. But a schedule that exists and deliberately sets *no*
 * times means the hours vary — the Avenues manager assigns mornings or nights
 * by the day — and there is no honest pair to judge against: 10:00 makes a
 * night shift four hours late, 14:00 makes a morning one look wrong, and the
 * whole 10:00–22:00 window makes everybody on mornings leave four hours early.
 *
 * That case used to fall through to the office's 09:00–17:00, which is the rule
 * that scored a salesperson nineteen hours late across three days he turned up
 * for. It now says it does not know, which a report can show as "—".
 */
export function shiftTimesOn(
  schedules: Schedule[],
  date: string,
  opts: PunctualityOptions = {},
): ShiftTimes {
  const s = scheduleOn(schedules, date);
  if (s) {
    if (s.shiftStart || s.shiftEnd) {
      return {
        start: s.shiftStart?.slice(0, 5) ?? null,
        end: s.shiftEnd?.slice(0, 5) ?? null,
        graceMinutes: s.graceMinutes ?? null,
        source: 'schedule',
      };
    }
    // A schedule on the record with no hours on it: their hours vary.
    return { start: null, end: null, graceMinutes: s.graceMinutes ?? null, source: 'none' };
  }
  const start = opts.defaultStart ?? null;
  const end = opts.defaultEnd ?? null;
  if (start || end) return { start, end, graceMinutes: null, source: 'default' };
  return { start: null, end: null, graceMinutes: null, source: 'none' };
}

export interface DayPunctuality {
  /** The Kuwait day this is about. Carried through so a total can be opened
   *  back up into the days behind it — "two hours late" invites "when?", and
   *  the answer should not mean going and counting. */
  date: string;
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
  const shift = shiftTimesOn(schedules, date, opts);
  /* The shift's own grace wins. The company's hour was written for a 09:00
     start, and laying it on top of somebody's 10:00 shift moves their deadline
     to 11:00 — a morning everybody would call late, scored as on time. A
     schedule that names a number, including zero, means that number. */
  const grace = shift.graceMinutes ?? opts.graceMinutes ?? DEFAULT_GRACE_MINUTES;

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

  return { date: input.date, hoursLate, hoursEarly, lateClass, excused, shift };
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
  /** Days whose hours are not knowable — nobody set them, or they vary by the
   *  day. The totals do not cover these. */
  daysWithoutShift: number;
  /** True when every judged day used the shop-wide default, not a real shift. */
  usedDefaultOnly: boolean;
  /**
   * True when nobody's hours could be judged at all, because the schedule on
   * record deliberately sets none — the Avenues case, where the manager assigns
   * mornings and nights by the day. Different from usedDefaultOnly: there the
   * figures are real but rest on an assumption; here there are no figures.
   */
  hoursVary: boolean;
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
    /* Only 'default' counts as "measured against the office hours". A day with
       no shift at all was not measured, so it must not be reported as if it
       had been — that is the claim that put nineteen late hours beside a name. */
    usedDefaultOnly:
      days.length > 0 && days.every((d) => d.shift.source === 'default'),
    hoursVary: days.length > 0 && days.every((d) => d.shift.source === 'none'),
  };
}
