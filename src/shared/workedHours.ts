/**
 * Worked hours, calculated in one place.
 *
 * This replaces six separate calculations that disagreed with each other. Three
 * of them reported an open shift as 0 hours, so somebody standing on the shop
 * floor at four in the afternoon had worked nothing all day.
 *
 * Two rules matter more than the arithmetic:
 *
 *  - An open shift is worth the hours so far, never zero. Somebody who clocked
 *    in at nine and has not clocked out has worked until now.
 *
 *  - A shift left open past ABANDON_AFTER_HOURS was never clocked out at all.
 *    Its length is unknown, not enormous. On the day this was written ten shifts
 *    were still open, the oldest for six weeks; counting them as hours-so-far
 *    would have credited one person with a thousand hours. Unknown is reported
 *    as null so it shows up as a correction to make rather than a number to
 *    trust.
 *
 * Mirrors the attendance_shifts / attendance_day_hours views, which apply the
 * same rules to reports and exports.
 *
 * Mirrored byte-for-byte in timekeeper-online and watch-store-crm. See
 * src/shared/README.md before editing.
 */

/**
 * Long enough to cover an overnight shift, short enough that a forgotten
 * clock-out is caught the next day.
 */
export const ABANDON_AFTER_HOURS = 16;

const MS_PER_HOUR = 3_600_000;

export interface ShiftInput {
  clockIn: string;
  clockOut?: string | null;
}

export interface Shift {
  /** Hours worked, or null when the record cannot answer the question. */
  hours: number | null;
  /** Still clocked in. */
  isOpen: boolean;
  /** Open so long it was plainly never clocked out. Needs a correction. */
  isAbandoned: boolean;
  /** Clocked out before clocking in. A broken record, not negative time. */
  isInvalid: boolean;
  /** Counting up right now, so a display of it should keep refreshing. */
  isLive: boolean;
}

const ms = (iso: string): number => new Date(iso).getTime();

/** One attendance record's worth of hours. */
export function shiftHours(s: ShiftInput, now: Date = new Date()): Shift {
  const start = ms(s.clockIn);
  if (!Number.isFinite(start)) {
    return { hours: null, isOpen: false, isAbandoned: false, isInvalid: true, isLive: false };
  }

  if (s.clockOut) {
    const end = ms(s.clockOut);
    if (!Number.isFinite(end) || end <= start) {
      return { hours: null, isOpen: false, isAbandoned: false, isInvalid: true, isLive: false };
    }
    return {
      hours: (end - start) / MS_PER_HOUR,
      isOpen: false,
      isAbandoned: false,
      isInvalid: false,
      isLive: false,
    };
  }

  const soFar = (now.getTime() - start) / MS_PER_HOUR;
  if (soFar > ABANDON_AFTER_HOURS) {
    return { hours: null, isOpen: true, isAbandoned: true, isInvalid: false, isLive: false };
  }
  return {
    hours: Math.max(0, soFar),
    isOpen: true,
    isAbandoned: false,
    isInvalid: false,
    isLive: true,
  };
}

export interface DayHours {
  /** Total for the day, or null when nothing usable was recorded. */
  hours: number | null;
  shifts: number;
  /** Records that need a correction before the total means anything. */
  unusableShifts: number;
  /** On the floor right now. */
  onTheFloor: boolean;
  hasAbandoned: boolean;
  hasInvalid: boolean;
  /** Any part of the total is still counting up. */
  isLive: boolean;
}

/**
 * A day's worth of records, summed. Split shifts add up; a broken record is
 * left out of the total and counted in unusableShifts instead, so a day that is
 * part-recorded reads as part-recorded rather than as a clean number.
 *
 * Shifts that overlap count their shared time once. A clock-in that went
 * through twice ten seconds apart (24 Sep) left two records covering the same
 * afternoon, and adding them up credited 13h 41m for a 6h 51m day.
 */
export function dayHours(records: ShiftInput[], now: Date = new Date()): DayHours {
  const parts = records.map((r) => shiftHours(r, now));
  const usable = parts.filter((p) => p.hours !== null);
  const spans = records
    .filter((_, i) => parts[i].hours !== null)
    .map((r) => {
      const start = ms(r.clockIn);
      return [start, r.clockOut ? ms(r.clockOut) : Math.max(start, now.getTime())] as const;
    })
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let reach = -Infinity;
  for (const [start, end] of spans) {
    if (end <= reach) continue;
    covered += end - Math.max(start, reach);
    reach = end;
  }
  return {
    hours: usable.length ? covered / MS_PER_HOUR : null,
    shifts: parts.length,
    unusableShifts: parts.length - usable.length,
    onTheFloor: parts.some((p) => p.isOpen && !p.isAbandoned),
    hasAbandoned: parts.some((p) => p.isAbandoned),
    hasInvalid: parts.some((p) => p.isInvalid),
    isLive: parts.some((p) => p.isLive),
  };
}

/** Sum of several days, ignoring days with nothing usable. */
export function totalHours(days: Array<{ hours: number | null }>): number {
  return days.reduce((t, d) => t + (d.hours ?? 0), 0);
}

/**
 * Hours for display: `7h 35m`. An unknown total says so rather than showing a
 * zero somebody would read as "did not work".
 */
export function formatHours(hours: number | null, unknown = '—'): string {
  if (hours === null || !Number.isFinite(hours)) return unknown;
  const whole = Math.floor(hours);
  const minutes = Math.round((hours - whole) * 60);
  if (minutes === 60) return `${whole + 1}h 0m`;
  return `${whole}h ${minutes}m`;
}

/** Hours as a decimal, the way payroll wants them: `7.58`. */
export const decimalHours = (hours: number | null): number | null =>
  hours === null ? null : Math.round(hours * 100) / 100;

/** Row shape of the attendance_day_hours view. */
export interface DayHoursRow {
  employee_id: string | null;
  user_id: string | null;
  employee_name: string | null;
  work_date: string;
  hours: number | string | null;
  shifts: number;
  unusable_shifts: number;
  on_the_floor: boolean | null;
  has_abandoned: boolean | null;
  late: boolean | null;
  first_in: string | null;
  last_out: string | null;
  outlet_codes: string[] | null;
}

/** The view's numeric comes back as a string over the wire. */
export const rowHours = (row: Pick<DayHoursRow, 'hours'>): number | null =>
  row.hours === null || row.hours === undefined ? null : Number(row.hours);
