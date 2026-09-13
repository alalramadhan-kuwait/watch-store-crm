import { format } from 'date-fns';

/**
 * Which day is "today" for the shop, from the device clock.
 * The shops are all in one timezone, so local time is the shop's time.
 */
export const localDay = (now: Date = new Date()) => format(now, 'yyyy-MM-dd');

/** The day before `now` — the only day the auto-close safety net may close. */
export const previousDay = (now: Date = new Date()) =>
  format(new Date(now.getTime() - 86400000), 'yyyy-MM-dd');

/**
 * Is `date` finished, so closing it cannot lock a day people are still working?
 *
 * A day is over only once the clock says a later date. A phone that sleeps
 * defers pending timers, so an auto-close timer can fire hours after it was
 * meant to — on 2026-09-13 one fired at 12:29 and closed that same day for
 * both shops. Every auto-close is gated on this.
 */
export const dayIsOver = (date: string, now: Date = new Date()) => date < localDay(now);
