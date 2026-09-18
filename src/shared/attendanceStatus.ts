/**
 * What somebody's attendance says about them, decided once.
 *
 * Home, Team, HR, My Portal and Store Day all used to work this out for
 * themselves, so the same person could read as present on one screen and absent
 * on another. They now all call this.
 *
 * The rule that matters most: nobody is absent merely because they are not
 * here. A person is only ever flagged when they were actually expected to work
 * that day — and when the schedule is unknown, the answer is "no schedule", not
 * "missing".
 *
 * Mirrored byte-for-byte in timekeeper-online and watch-store-crm. See
 * src/shared/README.md before editing.
 */

import { dayHours, type DayHours, type ShiftInput } from './workedHours';
import { isExpectedOn, scheduleOn, type Schedule } from './schedule';
import { shiftTimesOn } from './punctuality';

export type AttendanceStatus =
  /** Clocked in and still on the floor. */
  | 'working'
  /** Worked and clocked out. */
  | 'completed'
  /** Due in today, but the shift has not started yet. */
  | 'due_later'
  /** The shift has started and they have not clocked in. */
  | 'late'
  /** Expected that day and never clocked in at all. */
  | 'missing'
  /** Not a working day for them. */
  | 'off'
  | 'on_leave'
  /** A record that was never clocked out. The hours are unknown. */
  | 'needs_correction'
  /** Nothing is known about when this person works. */
  | 'no_schedule';

export const STATUS_WORD: Record<AttendanceStatus, string> = {
  working: 'Working now',
  completed: 'Completed',
  due_later: 'Due later',
  late: 'Late',
  missing: 'Missing check-in',
  off: 'Off duty',
  on_leave: 'On leave',
  needs_correction: 'Needs correction',
  no_schedule: 'No schedule',
};

/** Statuses a manager should act on today. */
export const NEEDS_ATTENTION: AttendanceStatus[] = ['late', 'missing', 'needs_correction'];

export interface StandingInput {
  /** Every attendance record for this person on this date. */
  records: ShiftInput[];
  /** Their dated schedules — all of them; the one covering the date is picked. */
  schedules: Schedule[];
  /** yyyy-mm-dd, read as a Kuwait calendar day. */
  date: string;
  onLeave?: boolean;
  /** Shift start to assume when the schedule does not set one, e.g. '09:00'. */
  defaultStart?: string | null;
}

export interface Standing {
  status: AttendanceStatus;
  word: string;
  hours: DayHours;
  /** They did clock in, but after their shift had started. */
  arrivedLate: boolean;
  /** Expected in that day. null when the schedule is unknown. */
  expected: boolean | null;
  needsAttention: boolean;
}

/** yyyy-mm-dd for a moment, as Kuwait reads the calendar. */
export const kuwaitDate = (at: Date = new Date()): string =>
  new Date(at.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);

/** Minutes past midnight, Kuwait time. */
const kuwaitMinutes = (at: Date): number => {
  const shifted = new Date(at.getTime() + 3 * 3_600_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};

const minutesOf = (hhmm: string | null | undefined): number | null => {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

/**
 * Where one person stands on one day.
 *
 * `now` is passed in rather than read, so a screen showing last Tuesday judges
 * that Tuesday against that Tuesday and not against this afternoon.
 */
export function standing(input: StandingInput, now: Date = new Date()): Standing {
  const { records, schedules, date, onLeave = false, defaultStart = null } = input;

  const hours = dayHours(records, now);
  const expected = isExpectedOn(schedules, date);
  const schedule = scheduleOn(schedules, date);
  const today = kuwaitDate(now);
  const isToday = date === today;
  const inFuture = date > today;

  /* Through shiftTimesOn, so somebody whose hours vary by the day is not called
     late against a morning they were never on. Null here means "cannot say",
     which reads as due_later rather than late. */
  const startAt = minutesOf(shiftTimesOn(schedules, date, { defaultStart }).start);
  const arrivals = records
    .map((r) => new Date(r.clockIn).getTime())
    .filter((t) => Number.isFinite(t));
  // Lateness is about when the day began, so only the first clock-in counts —
  // coming back from lunch at two is not arriving late.
  const firstIn = arrivals.length ? Math.min(...arrivals) : null;
  const arrivedLate =
    startAt !== null && firstIn !== null && kuwaitMinutes(new Date(firstIn)) > startAt;

  const decide = (): AttendanceStatus => {
    if (onLeave) return 'on_leave';
    // A record nobody ever closed says nothing about the hours worked, and
    // saying so is more use than a number that would be wrong.
    if (hours.hasAbandoned || hours.hasInvalid) return 'needs_correction';
    if (hours.onTheFloor) return 'working';
    if (hours.shifts > 0) return 'completed';

    // Nothing recorded. Only now does it matter whether they were due in.
    if (expected === null) return 'no_schedule';
    if (!expected) return 'off';
    if (inFuture) return 'due_later';
    if (!isToday) return 'missing';
    if (startAt === null) return 'due_later';
    return kuwaitMinutes(now) >= startAt ? 'late' : 'due_later';
  };

  const status = decide();
  return {
    status,
    word: STATUS_WORD[status],
    hours,
    arrivedLate: arrivedLate && (status === 'working' || status === 'completed'),
    expected,
    needsAttention: NEEDS_ATTENTION.includes(status),
  };
}

export interface RosterMember {
  id: string;
  name: string;
  records: ShiftInput[];
  schedules: Schedule[];
  onLeave?: boolean;
}

export interface MemberStanding extends Standing {
  id: string;
  name: string;
}

/** Ordered so what a manager must act on sits at the top. */
const RANK: Record<AttendanceStatus, number> = {
  needs_correction: 0,
  late: 1,
  missing: 2,
  working: 3,
  completed: 4,
  due_later: 5,
  on_leave: 6,
  off: 7,
  no_schedule: 8,
};

export function teamStanding(
  roster: RosterMember[],
  date: string,
  opts: { defaultStart?: string | null } = {},
  now: Date = new Date(),
): MemberStanding[] {
  return roster
    .map((m) => ({
      id: m.id,
      name: m.name,
      ...standing(
        {
          records: m.records,
          schedules: m.schedules,
          date,
          onLeave: m.onLeave,
          defaultStart: opts.defaultStart ?? null,
        },
        now,
      ),
    }))
    .sort((a, b) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name));
}
