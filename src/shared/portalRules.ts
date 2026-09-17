/**
 * My Portal's rules, with nothing plugged in.
 *
 * Where the day begins in Kuwait, how far away a workplace is, and what a leave
 * balance means. Separated from portal.ts — which asks the database — because a
 * rule that can only run inside a browser with a live connection is a rule
 * nobody can check. These are pure, so the build tests them.
 *
 * Mirrored byte-for-byte in timekeeper-online and watch-store-crm. See
 * src/shared/README.md before editing.
 */

export interface Geofence {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
  active: boolean;
}

export interface PortalLeaveLike {
  leave_type: string | null;
  leave_end: string;
  days: number | null;
  approval_status: string;
}

/** yyyy-mm-dd as Kuwait reads the calendar. UTC+3 all year, no daylight saving. */
export const todayKuwait = (at: Date = new Date()): string =>
  new Date(at.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);

/** A Kuwait date and HH:mm as an instant. */
export const kuwaitISO = (date: string, time: string): string =>
  new Date(`${date}T${time}:00+03:00`).toISOString();

export interface Position {
  latitude: number;
  longitude: number;
  accuracy: number;
}

export interface NearFence {
  fence: Geofence;
  metres: number;
  inside: boolean;
}

/** Straight-line metres between two points. */
export function metresBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Every workplace, nearest first.
 *
 * All of them, not the one on the employee's HR record: a manager covering the
 * other shop is standing in a real workplace and should be able to clock in to
 * it. Which one they are in is a question about where they are, not about which
 * row somebody typed.
 */
export function fencesNear(fences: Geofence[], at: Position): NearFence[] {
  return fences
    .map((fence) => {
      const metres = metresBetween(at.latitude, at.longitude, Number(fence.lat), Number(fence.lng));
      return { fence, metres, inside: metres <= Number(fence.radius_m) };
    })
    .sort((a, b) => a.metres - b.metres);
}

export interface LeaveBalance {
  entitlement: number;
  taken: number;
  booked: number;
  remaining: number;
}

/**
 * Where their annual leave stands.
 *
 * Approved days in the past are taken; approved days still to come are booked.
 * Pending requests are neither — nobody has agreed to them yet. Only annual
 * leave counts against the entitlement; sick leave is not a holiday.
 */
export function leaveBalance(
  leaves: PortalLeaveLike[],
  entitlement: number | null,
  at: Date = new Date(),
): LeaveBalance {
  const today = todayKuwait(at);
  const annual = leaves.filter(
    (l) => l.approval_status === 'Approved' && (l.leave_type ?? 'Annual') === 'Annual',
  );
  const taken = annual.filter((l) => l.leave_end < today).reduce((t, l) => t + Number(l.days ?? 0), 0);
  const booked = annual.filter((l) => l.leave_end >= today).reduce((t, l) => t + Number(l.days ?? 0), 0);
  const total = Number(entitlement ?? 0);
  return { entitlement: total, taken, booked, remaining: Math.max(0, total - taken - booked) };
}


/* ── what a correction is actually asking for ────────────────────────────────
 *
 * A salesperson could not clock out, followed the app's own advice to ask for a
 * correction, and the request reached his manager as "change my check-in to
 * 14:12" — the time it already said — with no leaving time at all. The form had
 * filled the box that was right and left empty the box that was wrong, and
 * nothing checked that the request changed anything.
 *
 * So the decision moved here, where it can be tested without a database: given
 * what is recorded and what the employee typed, what is actually being asked?
 * A time equal to what is already there is not a change and is never sent.
 */

/** yyyy-mm-dd, the day after a Kuwait date. */
export const nextKuwaitDay = (date: string): string => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/**
 * The HH:mm an instant reads as in Kuwait.
 *
 * Arithmetic rather than Intl, because this file is tested outside a browser
 * and a pure rule should not depend on which timezone data node was built with.
 * Kuwait is UTC+3 all year.
 */
export const kuwaitHM = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + 3 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

export interface RecordedShift {
  id: string;
  clock_in: string;
  clock_out: string | null;
}

export interface CorrectionInput {
  date: string;
  /** HH:mm the employee typed. Empty means they left that end alone. */
  arrivedAt?: string;
  leftAt?: string;
  /** The leaving time is the morning after `date`. */
  leftNextDay?: boolean;
  reason: string;
  /** The shift whose end is wrong — chosen by the employee, never assumed. */
  record?: RecordedShift | null;
}

export interface CorrectionPlan {
  /** A sentence when it cannot be sent, null when it can. */
  problem: string | null;
  proposedClockIn: string | null;
  proposedClockOut: string | null;
  recordId: string | null;
  /** Which ends genuinely differ from what is recorded. */
  changes: Array<'in' | 'out'>;
  /** Stored on the request. */
  details: string;
  /** Read back on the button, so a no-op cannot look like a correction. */
  summary: string;
}

/** A shift open longer than this was never clocked out; also the ceiling on a
 *  correction, so a typo cannot ask for a thirty-hour day. */
const MAX_SHIFT_HOURS = 16;

const empty = (v?: string) => !v || !v.trim();

export function planCorrection(i: CorrectionInput, at: Date = new Date()): CorrectionPlan {
  const nothing: CorrectionPlan = {
    problem: null, proposedClockIn: null, proposedClockOut: null,
    recordId: i.record?.id ?? null, changes: [], details: '', summary: '',
  };
  const refuse = (problem: string): CorrectionPlan => ({ ...nothing, problem });

  if (empty(i.reason)) return refuse('Say why the change is needed');
  if (!i.date) return refuse('Pick the day to correct');
  if (i.date > todayKuwait(at)) return refuse('That day has not happened yet');

  const nowIn = kuwaitHM(i.record?.clock_in);
  const nowOut = kuwaitHM(i.record?.clock_out ?? null);

  /* The heart of it: a time equal to what is recorded is not a change. An
     employee who only wants to fix their leaving time no longer sends their
     arrival along with it — and an arrival typed back unchanged can no longer
     rewrite the stored instant just because the form shows only minutes. */
  const wantsIn = !empty(i.arrivedAt) && i.arrivedAt !== nowIn;
  const wantsOut = !empty(i.leftAt) && i.leftAt !== nowOut;

  if (!wantsIn && !wantsOut) {
    return refuse(
      i.record
        ? 'Nothing here is different from what is recorded. Change the time you arrived, the time you left, or both.'
        : 'Give the time you arrived, the time you left, or both.',
    );
  }

  // Opening a day that has no record needs a start; a leaving time alone has
  // nothing to hang on. Said here, where it can still be fixed, rather than
  // when a manager tries to approve it.
  if (!i.record && !wantsIn) {
    return refuse('There is no record for that day, so the time you arrived is needed too.');
  }

  const startHM = wantsIn ? (i.arrivedAt as string) : nowIn;
  const endHM = wantsOut ? (i.leftAt as string) : nowOut;

  let outDate = i.date;
  if (endHM && startHM && endHM <= startHM) {
    // An evening shift that ends after midnight is not a mistake, but it has to
    // be said — otherwise a plain typo reads as one.
    if (!i.leftNextDay) {
      return refuse('That leaving time is earlier in the day than the arrival. Tick “I left after midnight” if the shift ran into the next day.');
    }
    outDate = nextKuwaitDay(i.date);
  }

  const proposedClockIn = wantsIn ? kuwaitISO(i.date, i.arrivedAt as string) : null;
  const proposedClockOut = wantsOut ? kuwaitISO(outDate, i.leftAt as string) : null;

  if (startHM && endHM) {
    const from = new Date(kuwaitISO(i.date, startHM)).getTime();
    const to = new Date(kuwaitISO(outDate, endHM)).getTime();
    if ((to - from) / 3_600_000 > MAX_SHIFT_HOURS) {
      return refuse(`That is more than ${MAX_SHIFT_HOURS} hours on one shift — check the times.`);
    }
  }

  const changes: Array<'in' | 'out'> = [
    ...(wantsIn ? ['in' as const] : []),
    ...(wantsOut ? ['out' as const] : []),
  ];

  /* Only what changed is named. The approver's card splits this on the first
     ": " to recover the reason, so nothing above it may contain one. */
  const asks = [
    wantsIn && `in ${i.arrivedAt}`,
    wantsOut && `out ${i.leftAt}${outDate !== i.date ? ' next day' : ''}`,
  ].filter(Boolean).join(', ');

  const said = [
    wantsIn && `arrival to ${i.arrivedAt}`,
    wantsOut && `leaving time to ${i.leftAt}`,
  ].filter(Boolean).join(' and ');

  return {
    problem: null,
    proposedClockIn,
    proposedClockOut,
    recordId: i.record?.id ?? null,
    changes,
    details: `${i.date} — ${asks}${i.record ? '' : ' (no record for that day)'}: ${i.reason.trim()}`,
    summary: `Ask to set ${said}`,
  };
}
