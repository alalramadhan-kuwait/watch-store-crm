/**
 * Everything a manager's home page asks for, in one round trip per outlet-day.
 *
 * Each screen fetching what it needs would mean the home page, the team tab and
 * the day sheet all asking for the same attendance and the same cases, three
 * times, on mall wifi. They ask this instead, and the pure functions in
 * utils/storeDay turn one answer into all three views.
 */
import { supabase } from '../lib/supabase';
import { getTeamAttendance, getTeamDirectory, getTeamLeave, type TeamMemberHR } from './index';
import { sameOutlet } from '../utils/outlet';
import type { Shift, RosterMember } from '../utils/storeDay';

export interface StoreDayData {
  roster: RosterMember[];
  shifts: Shift[];
  /** Approved leave, asked by roster name and date. */
  onLeave: (rosterName: string, date: string) => string | null;
  /** Today's cases at this outlet, already filtered — the sales figures. */
  cases: CaseLite[];
  dayClosed: boolean;
  closedBy: string | null;
  fetchedAt: number;
}

export interface CaseLite {
  id: string; caseId: string; staff: string; outlet: string | null;
  caseType: string; status: string; brand: string | null;
  customerName: string | null; amountKd: number | null;
}

const ymdAdd = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * One outlet, one day.
 *
 * Attendance is asked for by DAY rather than by outlet, because
 * `attendance_records.location` is the geofence's spelling and the outlet
 * picker's is the settings one — the two are matched in `sameOutlet`, not in a
 * `where` clause that would silently return nothing for Time Gallery.
 */
export async function loadStoreDay(outlet: string, date: string): Promise<StoreDayData> {
  const next = ymdAdd(date, 1);
  const [roster, attendance, leave, caseRows, close] = await Promise.all([
    getTeamDirectory(),
    getTeamAttendance(date, next),
    getTeamLeave(date, next),
    supabase.from('cases')
      .select('id, case_id, staff, outlet, case_type, status, brand, customer_name, amount_kd')
      .eq('date_logged', date).eq('deleted', false),
    supabase.from('day_closes').select('closed_by, outlet').eq('date', date),
  ]);

  const byRoster = new Map(roster.map((r: TeamMemberHR) => [r.rosterName, r]));
  const shifts: Shift[] = attendance.map((a) => ({
    rosterName: a.rosterName,
    fullName: byRoster.get(a.rosterName)?.fullName,
    date: a.date, clockIn: a.clockIn, clockOut: a.clockOut,
    isLate: a.isLate, justified: a.justified, location: a.location, hours: a.hours,
  }));

  const closes = (close.data ?? []) as { closed_by: string | null; outlet: string | null }[];
  /* A close with no outlet is the auto-close, which covers every shop — it
     writes no outlet precisely because no outlet can escape it. */
  const mine = closes.find((c) => !c.outlet || sameOutlet(c.outlet, outlet));

  return {
    roster,
    shifts,
    onLeave: (name, d) => leave.find((l) => l.rosterName === name && l.start <= d && l.end >= d)?.type ?? null,
    cases: ((caseRows.data ?? []) as Record<string, unknown>[])
      .filter((c) => sameOutlet(c.outlet as string, outlet))
      .map((c) => ({
        id: c.id as string, caseId: c.case_id as string, staff: c.staff as string,
        outlet: (c.outlet as string) ?? null, caseType: c.case_type as string,
        status: c.status as string, brand: (c.brand as string) ?? null,
        customerName: (c.customer_name as string) ?? null,
        amountKd: c.amount_kd == null ? null : Number(c.amount_kd),
      })),
    dayClosed: !!mine,
    closedBy: mine?.closed_by ?? null,
    fetchedAt: Date.now(),
  };
}

/** Month-to-date takings at one outlet, for the target line. Separate from the
 *  day because it is one number and changes slowly. */
export async function loadMonthToDate(outlet: string, date: string): Promise<number> {
  const monthStart = `${date.slice(0, 8)}01`;
  const { data } = await supabase.from('cases')
    .select('outlet, amount_kd, case_type')
    .gte('date_logged', monthStart).lte('date_logged', date).eq('deleted', false);
  return ((data ?? []) as Record<string, unknown>[])
    .filter((c) => sameOutlet(c.outlet as string, outlet) && c.case_type === 'Sale')
    .reduce((t, c) => t + Number(c.amount_kd ?? 0), 0);
}

/** The monthly target for an outlet, from the shared settings row the HQ app
 *  writes. Null when nobody has set one — then no target line is shown rather
 *  than a percentage of zero. */
export async function loadMonthlyTarget(outlet: string): Promise<number | null> {
  const { data } = await supabase.from('settings')
    .select('sales_target_month, sales_target_avenues, sales_target_timegallery').maybeSingle();
  if (!data) return null;
  const d = data as Record<string, number | null>;
  const perOutlet = sameOutlet(outlet, 'Avenues') ? d.sales_target_avenues
    : sameOutlet(outlet, 'TimeGallery') ? d.sales_target_timegallery
    : null;
  return perOutlet ?? null;
}
