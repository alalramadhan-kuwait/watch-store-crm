/**
 * Kuwait's clock and calendar, in one place.
 *
 * Every screen needs "what day is it in Kuwait" and "what day did this happen
 * on", and for a long time each one wrote its own: about thirty copies across
 * the two apps, some through Intl and some by adding three hours. They agreed,
 * but only because nobody had made a mistake yet. These are the ones to import.
 *
 * Arithmetic rather than Intl, like the rest of this folder: Kuwait is UTC+3
 * all year with no daylight saving, and a rule the build tests should not
 * depend on which timezone data the machine running it was built with.
 *
 * Mirrored byte-for-byte in timekeeper-online and watch-store-crm. See
 * src/shared/README.md before editing.
 */
export { todayKuwait, kuwaitISO, kuwaitHM } from './portalRules';

const shifted = (iso: string): Date | null => {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? new Date(t + 3 * 3_600_000) : null;
};

/** yyyy-mm-dd: the Kuwait day an instant falls on. '' when it is not a date. */
export const kuwaitDateOf = (iso: string): string => shifted(iso)?.toISOString().slice(0, 10) ?? '';

/** HH:mm, 24-hour: the Kuwait time of an instant, for a time input. '' when it is not a date. */
export const kuwaitTimeOf = (iso: string): string => shifted(iso)?.toISOString().slice(11, 16) ?? '';

/* ------------------------------------------------------------------- leave */

/** The kinds of leave somebody can ask for. */
export const LEAVE_TYPES = ['Annual', 'Sick', 'WFH', 'Work trip'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

/**
 * Working days in a leave period, both ends included.
 *
 * Kuwait Labor Law (Law No. 6 of 2010): annual leave is 30 paid WORKING days.
 * The weekly rest day (Friday) inside a leave period does not consume leave,
 * so the count skips Fridays. Counted on the calendar dates themselves, at
 * noon UTC, so the answer does not change with the timezone of the device.
 */
export function workingDaysBetween(start: string, end: string): number {
  const last = new Date(`${end}T12:00:00Z`);
  const d = new Date(`${start}T12:00:00Z`);
  if (!Number.isFinite(last.getTime()) || !Number.isFinite(d.getTime())) return 0;
  let days = 0;
  while (d <= last) {
    if (d.getUTCDay() !== 5) days++; // 5 = Friday
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}
