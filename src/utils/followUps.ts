import { differenceInDays, isBefore, isToday, startOfDay } from 'date-fns';
import type { Case } from '../types';

export type FollowUpUrgency = 'overdue' | 'today' | 'upcoming' | 'stale';

/**
 * Where a follow-up sits, in the order somebody should deal with it.
 *
 * "Stale" used to mean "nobody has been in touch for a week" — measured even
 * when a callback date had been agreed for LATER. That is not neglect, it is
 * the plan: a customer told to expect a call on the 30th is not owed one on
 * the 16th. It painted every parked follow-up red, so a board of ten showed
 * ten red cards of which four were genuinely late, and once everything is red
 * red stops meaning anything.
 *
 * The case it missed is the mirror image. A follow-up with NO callback date was
 * filed as 'upcoming' and drawn in white — yet it is the only kind nothing will
 * ever raise again. No date can pass, so it can never become overdue, and it
 * sinks down the list as newer work arrives. That is what actually drifts, and
 * that is what stale now means.
 */
export function followUpUrgency(c: Case): FollowUpUrgency {
  const now = startOfDay(new Date());

  if (!c.promisedCallback) {
    // Nothing agreed, so nothing will bring this back on its own. A week's
    // grace, then it is asking for a next step rather than for a phone call.
    const since = c.lastContactDate ?? c.dateLogged;
    return differenceInDays(now, new Date(since + 'T00:00:00')) > 7 ? 'stale' : 'upcoming';
  }

  const cb = new Date(c.promisedCallback + 'T00:00:00');
  if (isBefore(cb, now)) return 'overdue';
  if (isToday(cb)) return 'today';
  // A date is agreed and it has not arrived. However long ago the last call
  // was, this one is waiting, not slipping.
  return 'upcoming';
}

/* Things with a deadline come first; the undated one sits above the merely
   future because it is the one that disappears if nobody looks. */
export const urgencyOrder: Record<FollowUpUrgency, number> =
  { overdue: 0, today: 1, stale: 2, upcoming: 3 };
