/**
 * Whether a shop is open, and who is in it — worked out from attendance.
 *
 * There is no "open the store" button and there should not be one: somebody
 * would forget it, and then the app would disagree with the shop. The clock-ins
 * already say it. The first person through the door opens the shop, it stays
 * open while anyone is still clocked in, and it closes when the last person
 * leaves.
 *
 * Everything here is pure. It takes rows and returns an answer, so it can be
 * tested without a database and reused by the home page, the day sheet and the
 * team list without any of them re-querying.
 */
import { sameOutlet } from './outlet';
import { shiftHours as sharedShiftHours, dayHours } from '../shared/workedHours';
import { standing as sharedStanding, type AttendanceStatus } from '../shared/attendanceStatus';
import { shiftTimesOn } from '../shared/punctuality';
import { KUWAIT_WEEK, type Schedule, type Weekday } from '../shared/schedule';

export interface Shift {
  rosterName: string;
  fullName?: string;
  date: string;              // yyyy-mm-dd, Kuwait
  clockIn: string | null;
  clockOut: string | null;
  isLate: boolean;
  justified: boolean;
  location: string | null;
  hours: number | null;
}

export type StoreState = 'open' | 'closed' | 'not_opened';

export interface StoreDay {
  state: StoreState;
  openedAt: string | null;
  openedBy: string | null;
  closedAt: string | null;
  closedBy: string | null;
  /** Still clocked in right now. */
  onFloor: Shift[];
  /** Clocked in and back out again. */
  finished: Shift[];
  /** Every shift at this shop on this day, earliest first. */
  shifts: Shift[];
  hours: number;
}

const ms = (t: string) => new Date(t).getTime();

/**
 * Hours on a shift, counting an open one up to now.
 *
 * `hours` arrives null while somebody is still clocked in, so summing it
 * treated anyone on the floor as having worked nothing: a shop with one person
 * there since nine read "0h worked today" at lunchtime. A shift in progress has
 * been worked; it simply has not finished.
 *
 * The rule itself lives in src/shared/workedHours.ts, so the shop floor, the
 * back office and the database all answer this the same way — including for a
 * record nobody ever clocked out of, which is worth nothing here rather than
 * the weeks it has technically been open.
 */
export const shiftHours = (s: Shift, now = new Date()): number => {
  if (!s.clockIn) return 0;
  return sharedShiftHours({ clockIn: s.clockIn, clockOut: s.clockOut }, now).hours ?? 0;
};

/** The shared shape, for handing a set of shifts to the engines. */
const asInputs = (shifts: Shift[]) =>
  shifts.filter((s) => s.clockIn).map((s) => ({ clockIn: s.clockIn as string, clockOut: s.clockOut }));

/**
 * @param now  Passed in rather than read, so "is it open" is testable and so a
 *   day in the past is judged on its own terms instead of against this minute.
 */
export function storeDay(all: Shift[], outlet: string, date: string, now = new Date()): StoreDay {
  const shifts = all
    .filter((s) => s.date === date && sameOutlet(s.location, outlet) && s.clockIn)
    .sort((a, b) => ms(a.clockIn as string) - ms(b.clockIn as string));

  if (!shifts.length) {
    return { state: 'not_opened', openedAt: null, openedBy: null, closedAt: null, closedBy: null,
             onFloor: [], finished: [], shifts: [], hours: 0 };
  }

  /* Open while anybody is still clocked in. A clock-in nobody ever closed would
     otherwise keep a shop "open" for ever — one in this database had been
     running for six weeks — so a shift open past the shared threshold does not
     count as somebody on the floor. It is a correction to make, not a shop
     still trading. */
  const live = (s: Shift) => {
    const state = sharedShiftHours({ clockIn: s.clockIn as string, clockOut: s.clockOut }, now);
    return state.isOpen && !state.isAbandoned;
  };
  const onFloor = shifts.filter(live);
  const finished = shifts.filter((s) => !live(s));
  const first = shifts[0];
  const open = onFloor.length > 0;

  // The last person out closes it. With somebody still in there is no close yet.
  const closings = finished.filter((s) => s.clockOut);
  const lastOut = !open && closings.length
    ? closings.reduce((a, b) => (ms(a.clockOut as string) > ms(b.clockOut as string) ? a : b))
    : null;

  return {
    state: open ? 'open' : 'closed',
    openedAt: first.clockIn,
    openedBy: first.fullName ?? first.rosterName,
    closedAt: open ? null : lastOut?.clockOut ?? null,
    closedBy: open ? null : (lastOut ? lastOut.fullName ?? lastOut.rosterName : null),
    onFloor, finished, shifts,
    hours: dayHours(asInputs(shifts), now).hours ?? 0,
  };
}

/* ── who was due in ──────────────────────────────────────────────────────── */

export interface RosterMember {
  employeeId: string;
  /** The login behind this record. Anything asking "which of these is me?"
   *  matches on this — a display name is a copy and gets corrected. */
  userId: string | null;
  fullName: string;
  rosterName: string;
  location: string | null;
  expectedDays: number[];
  shiftStart: string | null;
  shiftEnd: string | null;
  /** Dated schedules, when they have been loaded. A schedule that changes next
   *  month must not change what last month looked like, so a day is judged
   *  against the row covering that date. Falls back to the columns above. */
  schedules?: Schedule[];
}

/**
 * The schedules to judge a date against.
 *
 * `expected_days` and the shift columns on the employee record are a mirror of
 * whichever dated schedule is in force today. Using them for a past date would
 * re-judge that date against today's roster, so the dated rows are preferred
 * whenever they have been loaded.
 */
const schedulesFor = (m: RosterMember): Schedule[] => {
  if (m.schedules?.length) return m.schedules;
  return [{
    employeeId: m.employeeId,
    effectiveFrom: '1970-01-01',
    effectiveTo: null,
    workingDays: (m.expectedDays.length ? m.expectedDays : KUWAIT_WEEK) as Weekday[],
    shiftStart: m.shiftStart,
    shiftEnd: m.shiftEnd,
  }];
};

/**
 * The shop floor and the back office name these the same things now — the words
 * come from src/shared/attendanceStatus.ts so a person cannot read as present on
 * one screen and absent on the other.
 */
export type Standing = AttendanceStatus;

export interface TeamStanding {
  member: RosterMember;
  standing: Standing;
  shifts: Shift[];
  hoursToday: number;
  /** null when a record needs a correction before the total means anything. */
  hoursKnown: number | null;
  /** They did clock in, just after their shift had started. */
  arrivedLate: boolean;
  /** The start their day is judged against, hh:mm — null when nobody has said
   *  what hours they work, which is not the same as the office default. */
  dueAt: string | null;
  firstIn: string | null;
  lastOut: string | null;
}

/** Postgres/JS weekday of a yyyy-mm-dd, Kuwait: 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (date: string) => new Date(`${date}T12:00:00+03:00`).getUTCDay();

export const isExpectedOn = (m: RosterMember, date: string): boolean => {
  const covering = schedulesFor(m).find(
    (sc) => date >= sc.effectiveFrom && (sc.effectiveTo === null || date <= sc.effectiveTo),
  );
  return covering ? covering.workingDays.includes(weekdayOf(date) as Weekday) : false;
};

/**
 * Where each person stands today.
 *
 * `missing` is deliberately narrow. Somebody is only missing when they were due
 * in, are not on leave, have clocked nothing, AND their start time has already
 * gone — being absent at ten past nine when you start at eleven is not absence,
 * and a shop that flags it teaches its manager to ignore the flag.
 */
export function standings(
  roster: RosterMember[],
  shifts: Shift[],
  onLeave: (rosterName: string, date: string) => string | null,
  date: string,
  opts: { workStart: string; graceMinutes: number; now?: Date },
): TeamStanding[] {
  const now = opts.now ?? new Date();

  return roster.map((member) => {
    const mine = shifts
      .filter((s) => s.rosterName === member.rosterName && s.date === date && s.clockIn)
      .sort((a, b) => ms(a.clockIn as string) - ms(b.clockIn as string));
    const firstIn = mine[0]?.clockIn ?? null;
    const lastOut = mine.length && mine.every((s) => s.clockOut)
      ? mine.reduce((a, b) => (ms(a.clockOut as string) > ms(b.clockOut as string) ? a : b)).clockOut
      : null;

    const verdict = sharedStanding({
      records: asInputs(mine),
      schedules: schedulesFor(member),
      date,
      onLeave: !!onLeave(member.rosterName, date),
      defaultStart: opts.workStart,
    }, now);

    return {
      member,
      standing: verdict.status,
      shifts: mine,
      hoursToday: verdict.hours.hours ?? 0,
      hoursKnown: verdict.hours.hours,
      // An excused late arrival is a decision somebody already made.
      arrivedLate: verdict.arrivedLate && !(mine[0]?.justified ?? false),
      dueAt: shiftTimesOn(schedulesFor(member), date, { defaultStart: opts.workStart }).start,
      firstIn,
      lastOut,
    };
  });
}

/** The shop floor's shorter wording for the shared statuses. */
export const STANDING_WORD: Record<Standing, string> = {
  working: 'In now',
  completed: 'Done',
  late: 'Late',
  on_leave: 'On leave',
  missing: 'Not in',
  due_later: 'Due later',
  off: 'Off',
  needs_correction: 'Needs clock-out',
  no_schedule: 'No schedule',
};
