/**
 * When somebody is expected to work.
 *
 * Schedules are dated, not overwritten. If a person moves to a new shift next
 * month, last month's attendance must still be judged against the shift they
 * actually had — otherwise a roster change silently rewrites everybody's
 * history, turning days they worked correctly into days they were late for.
 *
 * Mirrored byte-for-byte in timekeeper-online and watch-store-crm. See
 * src/shared/README.md before editing.
 */

/** Postgres day-of-week numbering: 0 = Sunday … 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** The Kuwait working week: Saturday through Thursday, Friday off. */
export const KUWAIT_WEEK: Weekday[] = [0, 1, 2, 3, 4, 6];

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Days in the order Kuwait reads a week, starting Saturday. */
export const WEEK_ORDER: Weekday[] = [6, 0, 1, 2, 3, 4, 5];

export interface Schedule {
  id?: string;
  employeeId: string;
  effectiveFrom: string;
  /** null = still in force. */
  effectiveTo: string | null;
  workingDays: Weekday[];
  shiftStart: string | null;
  shiftEnd: string | null;
  /**
   * Minutes after the shift start that still count as on time.
   *
   * Null means "use the company default", which is nearly everybody. A number
   * belongs here rather than in settings because grace forgives a *shift*: the
   * company's hour was written for the office's 09:00 start, and laying it on
   * top of a 10:00 shift moves that person's deadline to 11:00, which is not
   * what anybody means by late.
   */
  graceMinutes?: number | null;
  note?: string | null;
}

/** Row shape of the employee_schedules table. */
export interface ScheduleRow {
  id: string;
  employee_id: string;
  effective_from: string;
  effective_to: string | null;
  working_days: number[] | null;
  shift_start: string | null;
  shift_end: string | null;
  grace_minutes?: number | null;
  note: string | null;
}

export const scheduleFromRow = (r: ScheduleRow): Schedule => ({
  id: r.id,
  employeeId: r.employee_id,
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
  workingDays: (r.working_days ?? KUWAIT_WEEK) as Weekday[],
  shiftStart: r.shift_start,
  shiftEnd: r.shift_end,
  graceMinutes: r.grace_minutes ?? null,
  note: r.note,
});

/** Postgres weekday for a yyyy-mm-dd date, read as a Kuwait calendar day. */
export const weekdayOf = (date: string): Weekday =>
  new Date(`${date}T12:00:00Z`).getUTCDay() as Weekday;

/**
 * The schedule in force on a date. Ranges never overlap — the database
 * enforces it — so at most one matches.
 */
export function scheduleOn(schedules: Schedule[], date: string): Schedule | null {
  const covering = schedules.filter(
    (s) => date >= s.effectiveFrom && (s.effectiveTo === null || date <= s.effectiveTo),
  );
  if (!covering.length) return null;
  return covering.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
}

/**
 * Was this person due in on this date?
 *
 * Returns null when nothing is known about their schedule. That is not the same
 * as "no" — an unknown schedule must never be read as an absence, which is why
 * nobody is flagged for a day we cannot say they were expected to work.
 */
export function isExpectedOn(schedules: Schedule[], date: string): boolean | null {
  const s = scheduleOn(schedules, date);
  if (!s) return null;
  return s.workingDays.includes(weekdayOf(date));
}

/** The regular day off, when there is exactly one. */
export function dayOff(schedule: Schedule | null): Weekday | null {
  if (!schedule) return null;
  const off = ([0, 1, 2, 3, 4, 5, 6] as Weekday[]).filter(
    (d) => !schedule.workingDays.includes(d),
  );
  return off.length === 1 ? off[0] : null;
}

/** `Sat–Thu`, or `Sun, Tue, Thu` when the days do not run together. */
export function describeDays(days: Weekday[]): string {
  if (!days.length) return 'No working days';
  if (days.length === 7) return 'Every day';
  const inWeekOrder = WEEK_ORDER.filter((d) => days.includes(d));
  const positions = inWeekOrder.map((d) => WEEK_ORDER.indexOf(d));
  const runsTogether = positions.every((p, i) => i === 0 || p === positions[i - 1] + 1);
  if (runsTogether && inWeekOrder.length > 2) {
    return `${WEEKDAY_SHORT[inWeekOrder[0]]}–${WEEKDAY_SHORT[inWeekOrder[inWeekOrder.length - 1]]}`;
  }
  return inWeekOrder.map((d) => WEEKDAY_SHORT[d]).join(', ');
}

/** `09:00–18:00`, or a plain note when the times are not set. */
export function describeShift(schedule: Schedule | null, unset = 'No set hours'): string {
  if (!schedule || !schedule.shiftStart) return unset;
  const trim = (t: string) => t.slice(0, 5);
  return schedule.shiftEnd
    ? `${trim(schedule.shiftStart)}–${trim(schedule.shiftEnd)}`
    : `from ${trim(schedule.shiftStart)}`;
}
