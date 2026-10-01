/**
 * A salesperson's week, and whether they are keeping up with their target.
 *
 * The Kuwait week runs Saturday to Friday. A weekly target is only worth
 * showing next to where the week itself has got to: 1,200 KD of 3,500 is
 * behind on Tuesday evening and nothing to worry about on Saturday, so every
 * figure here is judged against the share of the week that has passed.
 *
 *   done      the target is reached.
 *   ahead     at least 10 points ahead of the week.
 *   on_track  within 15 points of it.
 *   behind    more than 15 points short, from the third day on — before then a
 *             slow start says nothing.
 *   none      no target has been set.
 *
 * Mirrored byte-for-byte in timekeeper-online and watch-store-crm. See
 * src/shared/README.md before editing.
 */

export type TargetState = 'done' | 'ahead' | 'on_track' | 'behind' | 'none';

const ymdAdd = (ymd: string, n: number): string => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Saturday of the week a date falls in. */
export const weekStart = (ymd: string): string =>
  ymdAdd(ymd, -((new Date(`${ymd}T12:00:00Z`).getUTCDay() + 1) % 7));

export interface WeekProgress {
  start: string;
  end: string;
  /** 1 on Saturday … 7 on Friday. */
  day: number;
  daysLeft: number;
  /** The share of the week that has passed, counting today: Saturday 1/7 … Friday 7/7. */
  fraction: number;
}

export function weekProgress(today: string): WeekProgress {
  const start = weekStart(today);
  const day = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000) + 1;
  return { start, end: ymdAdd(start, 6), day, daysLeft: 7 - day, fraction: day / 7 };
}

export function targetState(sales: number, target: number | null | undefined, week: WeekProgress): TargetState {
  if (!target || target <= 0) return 'none';
  if (sales >= target) return 'done';
  const got = sales / target;
  if (week.day >= 3 && got < week.fraction - 0.15) return 'behind';
  if (got >= week.fraction + 0.1) return 'ahead';
  return 'on_track';
}

/** What each remaining day has to bring in, or null when the target is met or the week is over. */
export function neededPerDay(sales: number, target: number | null | undefined, week: WeekProgress): number | null {
  if (!target || sales >= target) return null;
  const daysLeft = Math.max(1, week.daysLeft + 1); // today still counts
  return Math.ceil((target - sales) / daysLeft);
}
