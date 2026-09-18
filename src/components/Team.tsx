import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, Users } from 'lucide-react';
import { useAppStore } from '../store';
import { supabase } from '../lib/supabase';
import { getSettings, getTeamAttendance, getTeamDirectory, getTeamLeave } from '../db';
import { loadStoreDay } from '../db/storeToday';
import { standings, STANDING_WORD, type Shift, type TeamStanding, isExpectedOn } from '../utils/storeDay';
import { workload, fairness, type Fairness } from '../shared/workload';
import { useLive } from '../shared/live';
import { shopsFrom, sameOutlet } from '../utils/outlet';
import { AttendanceSheet } from './ManagerDashboard';
import { TeamRequests } from './TeamRequests';
import type { AttendanceDay, LeaveDay } from '../db';

const todayKuwait = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuwait' });
const hhmm = (iso: string | null) => (!iso ? '—' : new Date(iso)
  .toLocaleTimeString('en-KW', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kuwait' }));
const hm = (hours: number) => `${Math.floor(hours)}h ${String(Math.round((hours % 1) * 60)).padStart(2, '0')}m`;
const ymdAdd = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Saturday of the week a date falls in — the Kuwait week starts Saturday. */
const satOfWeek = (ymd: string) => ymdAdd(ymd, -((new Date(`${ymd}T12:00:00Z`).getUTCDay() + 1) % 7));

const TONE: Record<string, string> = {
  working: 'bg-emerald-100 text-emerald-700', completed: 'bg-slate-100 text-slate-600',
  late: 'bg-amber-100 text-amber-700', on_leave: 'bg-sky-100 text-sky-700',
  missing: 'bg-rose-100 text-rose-700', due_later: 'bg-slate-100 text-slate-500',
  off: 'bg-slate-50 text-slate-400',
  needs_correction: 'bg-amber-100 text-amber-700',
  no_schedule: 'bg-slate-50 text-slate-400',
};

/**
 * The team, today, and how the week's hours are shared out.
 *
 * Today answers "who is in and who is missing". The week answers the question
 * behind it — whether the hours are being divided fairly — which one day can
 * never show. Both come from the same attendance rows.
 *
 * The month view is not rebuilt here. Tapping somebody opens the calendar sheet
 * the Dashboard already has.
 */
export function Team() {
  const activeOutlet = useAppStore((s) => s.activeOutlet);
  const setActiveOutlet = useAppStore((s) => s.setActiveOutlet);
  const today = todayKuwait();

  const [outlets, setOutlets] = useState<string[]>([]);
  const [workStart, setWorkStart] = useState('09:00');
  const [rows, setRows] = useState<TeamStanding[]>([]);
  const [weekHours, setWeekHours] = useState<Map<string, number>>(new Map());
  const [weekDue, setWeekDue] = useState<Map<string, number>>(new Map());
  const [balance, setBalance] = useState<Fairness | null>(null);
  const [sales, setSales] = useState<Map<string, { count: number; kd: number }>>(new Map());
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [month, setMonth] = useState<{ rows: AttendanceDay[]; leave: LeaveDay[] } | null>(null);
  const [loading, setLoading] = useState(true);

  const outlet = activeOutlet ?? outlets[0] ?? '';

  useEffect(() => {
    void getSettings().then((s) => setOutlets(shopsFrom(s.outlets)));
    void supabase.from('settings').select('work_start_time').maybeSingle()
      .then(({ data }) => { const w = (data as { work_start_time?: string } | null)?.work_start_time; if (w) setWorkStart(w); });
  }, []);

  const load = useCallback(async () => {
    if (!outlet) return;
    setLoading(true);
    const weekStart = satOfWeek(today);
    try {
      const [day, roster, weekAtt, weekLeave] = await Promise.all([
        loadStoreDay(outlet, today),
        getTeamDirectory(),
        getTeamAttendance(weekStart, ymdAdd(today, 1)),
        getTeamLeave(weekStart, ymdAdd(today, 1)),
      ]);
      const here = roster.filter((r) => sameOutlet(r.location, outlet));
      setRows(standings(here, day.shifts, day.onLeave, today, { workStart, graceMinutes: 60 }));

      /* Hours worked so far this week, and how many days they were due — the two
         together are what makes an imbalance visible. A person due four days
         and working four is not behind somebody due six.
         The counting is src/shared/workload.ts, the same code HR reports with. */
      const due = new Map<string, number>();
      for (const m of here) {
        let n = 0;
        for (let d = weekStart; d <= today; d = ymdAdd(d, 1)) {
          if (isExpectedOn(m, d) && !weekLeave.find((l) => l.rosterName === m.rosterName && l.start <= d && l.end >= d)) n++;
        }
        due.set(m.rosterName, n);
      }
      setWeekDue(due);

      const loads = workload(
        (weekAtt as unknown as Shift[])
          .filter((a) => a.clockIn)
          .map((a) => ({
            who: a.rosterName, date: a.date, outlet: a.location,
            clockIn: a.clockIn as string, clockOut: a.clockOut,
          })),
        { outlet, from: weekStart, to: today, daysDue: due },
      );
      setWeekHours(new Map(loads.map((l) => [l.who, l.hours ?? 0])));
      setBalance(fairness(loads));

      const byStaff = new Map<string, { count: number; kd: number }>();
      for (const c of day.cases) {
        if (c.caseType !== 'Sale') continue;
        const cur = byStaff.get(c.staff) ?? { count: 0, kd: 0 };
        byStaff.set(c.staff, { count: cur.count + 1, kd: cur.kd + (c.amountKd ?? 0) });
      }
      setSales(byStaff);
    } finally { setLoading(false); }
  }, [outlet, today, workStart]);

  useEffect(() => { void load(); }, [load]);

  // Who is on the floor changes while this is open; the week's totals do not
  // need to, so only attendance is subscribed to.
  useLive('team-today', [{ table: 'attendance_records' }], () => { void load(); });

  const ordered = useMemo(() => {
    const rank: Record<string, number> = { needs_correction: 0, missing: 1, late: 2, working: 3, due_later: 4, completed: 5, on_leave: 6, off: 7, no_schedule: 8 };
    return [...rows].sort((a, b) => (rank[a.standing] - rank[b.standing])
      || a.member.fullName.localeCompare(b.member.fullName));
  }, [rows]);

  const weekTotal = [...weekHours.values()].reduce((t, h) => t + h, 0);

  /* The month sheet is the Dashboard's, so it wants the month's rows. Fetched
     when somebody taps rather than up front — most visits never open it. */
  async function openMonth(rosterName: string) {
    const first = `${today.slice(0, 8)}01`;
    const nextMonth = ymdAdd(`${today.slice(0, 8)}28`, 7).slice(0, 8) + '01';
    const [rows, leave] = await Promise.all([getTeamAttendance(first, nextMonth), getTeamLeave(first, nextMonth)]);
    setMonth({ rows, leave });
    setSheetFor(rosterName);
  }

  return (
    <div className="p-4 pb-28 space-y-4 max-w-2xl mx-auto">
      {outlets.length > 1 && (
        <div className="flex rounded-xl border border-slate-200 overflow-hidden text-sm">
          {outlets.map((o) => (
            <button key={o} onClick={() => setActiveOutlet(o)}
              className={`flex-1 px-3 py-2.5 font-semibold ${sameOutlet(o, outlet) ? 'bg-slate-900 text-white' : 'bg-white text-slate-600'}`}>
              {o}
            </button>
          ))}
        </div>
      )}

      {/* Approvals first. Who is in today can wait a scroll; a correction that
          has been sitting for three days cannot, and until now he could not see
          it on this device at all. */}
      <TeamRequests />

      <div className="flex items-center gap-2">
        <Users className="w-5 h-5 text-slate-400" />
        <h1 className="text-lg font-bold text-slate-900">Team today</h1>
        {weekTotal > 0 && <span className="ml-auto text-xs text-slate-500">{hm(weekTotal)} this week</span>}
      </div>

      {balance?.uneven && balance.busiest && balance.quietest && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
          {balance.busiest.who} is working about {hm(balance.spread ?? 0)} more per day due than {balance.quietest.who} this week.
        </p>
      )}

      {loading && !rows.length ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-24 rounded-2xl bg-slate-100 animate-pulse" />)}</div>
      ) : !ordered.length ? (
        <p className="text-sm text-slate-400">Nobody is on the roster for {outlet}.</p>
      ) : ordered.map((t) => {
        const s = sales.get(t.member.rosterName);
        const wh = weekHours.get(t.member.rosterName) ?? 0;
        const due = weekDue.get(t.member.rosterName) ?? 0;
        return (
          <button key={t.member.employeeId} onClick={() => void openMonth(t.member.rosterName)}
            className="w-full text-left card p-4 active:scale-[0.99] transition-transform">
            <div className="flex items-center gap-2">
              <span className="font-bold text-slate-900 flex-1 min-w-0 truncate">{t.member.fullName}</span>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${TONE[t.standing]}`}>
                {STANDING_WORD[t.standing]}
              </span>
              <ChevronRight className="w-4 h-4 text-slate-300 shrink-0" />
            </div>

            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 tabular-nums">
              {t.shifts.length ? (
                <span>{t.shifts.map((sh, i) => (
                  <span key={i}>{i > 0 && ' · '}{hhmm(sh.clockIn)} → {sh.clockOut ? hhmm(sh.clockOut) : 'in now'}</span>
                ))}</span>
              ) : (
                <span>{t.standing === 'off' ? 'Not due in today'
                  : t.standing === 'on_leave' ? 'On approved leave'
                  /* `dueAt` is the start actually in force, which is null when
                     their hours vary. Falling back to the office default here
                     printed "Due at 09:00" for people the engine had just
                     decided it could not time — the shops assign two shifts a
                     day, so there is no 09:00 to be due at. */
                  : t.standing === 'due_later' ? (t.dueAt ? `Due at ${t.dueAt}` : 'Hours vary — not due at a set time')
                  : t.standing === 'no_schedule' ? 'No working days set'
                  : t.standing === 'late' ? (t.dueAt ? `Due at ${t.dueAt} — not clocked in` : 'Not clocked in')
                  : 'No clock-in'}</span>
              )}
            </div>

            <div className="mt-3 pt-3 border-t border-slate-100 grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-base font-bold text-slate-900 leading-none">{t.hoursKnown === null ? '—' : hm(t.hoursToday)}</p>
                <p className="text-[10px] text-slate-400 mt-1">today</p>
              </div>
              <div>
                <p className="text-base font-bold text-slate-900 leading-none">{hm(wh)}</p>
                <p className="text-[10px] text-slate-400 mt-1">this week{due ? ` · ${due}d due` : ''}</p>
              </div>
              <div>
                <p className="text-base font-bold text-slate-900 leading-none">{s?.count ?? 0}</p>
                <p className="text-[10px] text-slate-400 mt-1">sales today</p>
              </div>
            </div>
          </button>
        );
      })}

      <p className="text-[11px] text-slate-400">
        Nobody is marked missing for a day they were not due in. Days off come from their HR record.
      </p>

      {sheetFor && month && (
        <AttendanceSheet
          name={sheetFor} month={new Date(`${today}T12:00:00+03:00`)}
          rows={month.rows} leave={month.leave}
          onClose={() => { setSheetFor(null); setMonth(null); }}
        />
      )}
    </div>
  );
}
