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
 * `hours` is null while somebody is still clocked in, so summing it treated
 * anyone on the floor as having worked nothing: a shop with one person there
 * since nine read "0h worked today" at lunchtime. A shift in progress has been
 * worked; it simply has not finished.
 */
export const shiftHours = (s: Shift, now = new Date()): number => {
  if (s.hours != null) return s.hours;
  if (!s.clockIn) return 0;
  return Math.max(0, (now.getTime() - ms(s.clockIn)) / 3600000);
};

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

  const onFloor = shifts.filter((s) => !s.clockOut);
  const finished = shifts.filter((s) => s.clockOut);
  const first = shifts[0];

  /* Open while anybody is still clocked in. A shift left open overnight would
     otherwise keep a shop "open" for ever, so a day that is not today is closed
     by its last clock-out whatever the records say — an unclosed shift is a
     correction to make, not a shop still trading. */
  const isToday = date === now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kuwait' });
  const open = isToday && onFloor.length > 0;

  // The last person out closes it. With shifts still open there is no close yet.
  const lastOut = finished.length && (!open || !isToday)
    ? finished.reduce((a, b) => (ms(a.clockOut as string) > ms(b.clockOut as string) ? a : b))
    : null;

  return {
    state: open ? 'open' : 'closed',
    openedAt: first.clockIn,
    openedBy: first.fullName ?? first.rosterName,
    closedAt: open ? null : lastOut?.clockOut ?? null,
    closedBy: open ? null : (lastOut ? lastOut.fullName ?? lastOut.rosterName : null),
    onFloor, finished, shifts,
    hours: shifts.reduce((t, s) => t + shiftHours(s, now), 0),
  };
}

/* ── who was due in ──────────────────────────────────────────────────────── */

export interface RosterMember {
  employeeId: string;
  fullName: string;
  rosterName: string;
  location: string | null;
  expectedDays: number[];
  shiftStart: string | null;
  shiftEnd: string | null;
}

export type Standing =
  | 'on_floor'      // clocked in, still here
  | 'finished'      // clocked in and out
  | 'late'          // here, but after the grace period
  | 'leave'         // approved leave today
  | 'missing'       // due in, nothing recorded, and their start time has passed
  | 'due_later'     // due in, but their day has not started yet
  | 'off';          // not due in today

export interface TeamStanding {
  member: RosterMember;
  standing: Standing;
  shifts: Shift[];
  hoursToday: number;
  firstIn: string | null;
  lastOut: string | null;
}

/** Postgres/JS weekday of a yyyy-mm-dd, Kuwait: 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (date: string) => new Date(`${date}T12:00:00+03:00`).getUTCDay();

export const isExpectedOn = (m: RosterMember, date: string) =>
  m.expectedDays.includes(weekdayOf(date));

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
  // Minutes since midnight in Kuwait, whatever the phone's own clock is set to.
  const [nowH, nowM] = new Intl.DateTimeFormat('en-GB',
    { timeZone: 'Asia/Kuwait', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(now).split(':').map(Number);
  const nowMinutes = nowH * 60 + nowM;
  const isToday = date === now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kuwait' });

  return roster.map((member) => {
    const mine = shifts
      .filter((s) => s.rosterName === member.rosterName && s.date === date && s.clockIn)
      .sort((a, b) => ms(a.clockIn as string) - ms(b.clockIn as string));
    const hoursToday = mine.reduce((t, s) => t + shiftHours(s, now), 0);
    const firstIn = mine[0]?.clockIn ?? null;
    const lastOut = mine.length && mine.every((s) => s.clockOut)
      ? mine.reduce((a, b) => (ms(a.clockOut as string) > ms(b.clockOut as string) ? a : b)).clockOut
      : null;

    let standing: Standing;
    if (mine.some((s) => !s.clockOut)) {
      standing = 'on_floor';
    } else if (mine.length) {
      // Lateness belongs to the clock-in that opened the day, and an excused
      // one is a decision somebody made.
      standing = mine[0].isLate && !mine[0].justified ? 'late' : 'finished';
    } else if (onLeave(member.rosterName, date)) {
      standing = 'leave';
    } else if (!isExpectedOn(member, date)) {
      standing = 'off';
    } else {
      const [h, m] = (member.shiftStart ?? opts.workStart).split(':').map(Number);
      const dueBy = h * 60 + m + opts.graceMinutes;
      // A past day is judged whole; today is judged against the clock.
      standing = !isToday || nowMinutes > dueBy ? 'missing' : 'due_later';
    }
    return { member, standing, shifts: mine, hoursToday, firstIn, lastOut };
  });
}

export const STANDING_WORD: Record<Standing, string> = {
  on_floor: 'In now', finished: 'Done', late: 'Late', leave: 'On leave',
  missing: 'Not in', due_later: 'Due later', off: 'Off',
};
