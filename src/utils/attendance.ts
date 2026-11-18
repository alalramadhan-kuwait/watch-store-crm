/**
 * Attendance and leave rules, shared with Timekeeper Online (same tables).
 *
 * How late is late, and against whose hours, is decided in src/shared/punctuality;
 * this file keeps only what the shop app needs beside it.
 */

/** Minutes since midnight, Kuwait time, whatever the device is set to. */
export function kuwaitMinutes(iso: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuwait', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
  const [h, m] = parts.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Did they leave before their shift ended?
 *
 * The shift end is passed in rather than assumed: it used to default to the
 * office's 17:00 for everybody, which told a manager who finishes at 15:30 that
 * she had left early every day she worked. False when nobody has said when the
 * day ends — unknown, not "left early".
 */
export function isEarlyLeave(clockOutIso: string | null, workEnd: string | null = '17:00'): boolean {
  if (!clockOutIso || !workEnd) return false;
  const [eh, em] = workEnd.split(':').map(Number);
  if (!Number.isFinite(eh) || !Number.isFinite(em)) return false;
  return kuwaitMinutes(clockOutIso) < eh * 60 + em;
}

/**
 * Kuwait Labor Law (Law No. 6 of 2010): annual leave is 30 paid WORKING days.
 * The weekly rest day (Friday) inside a leave period does not consume leave,
 * so the count skips Fridays.
 */
export { workingDaysBetween } from '../shared/kuwaitTime';
