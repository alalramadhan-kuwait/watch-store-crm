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

