import { useState, useMemo, useEffect, useCallback } from 'react';
import { format, startOfMonth, endOfMonth, addMonths, subMonths, eachDayOfInterval, isFriday } from 'date-fns';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { TrendingUp, Users, AlertCircle, DollarSign, FileText, X, ChevronLeft, ChevronRight, Clock, CalendarDays } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { getCasesForRange, getSettings, getEffectiveItems, getTeamAttendance, getTeamLeave } from '../db';
import type { AttendanceDay, LeaveDay } from '../db';
import { formatKD, formatKDCompact } from '../utils/formatKD';
import { CaseTypeBadge } from './shared/Badge';
import { Modal } from './shared/Modal';
import type { Case } from '../types';

export function ManagerDashboard() {

  return (
    <div className="px-4 pt-6 pb-32 max-w-5xl mx-auto lg:max-w-none lg:px-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Manager Dashboard</h1>
          <p className="text-slate-500 text-sm mt-0.5">{format(new Date(), 'EEEE, d MMMM yyyy')}</p>
        </div>
        <NavLink
          to="/reports"
          className="flex items-center gap-1.5 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl text-xs font-semibold transition-colors"
        >
          <FileText className="w-3.5 h-3.5" /> Reports
        </NavLink>
      </div>

      <MonthView />
    </div>
  );
}

interface DrillDown { title: string; cases: Case[]; }


export interface AttendanceSummary {
  days: number;        // days actually worked
  hours: number;       // total clocked hours; open shifts contribute nothing
  late: number;
  openShifts: number;  // clocked in and never out — hours are understated by these
  leaveDays: number;
  shifts: number;      // clock-ins; more than one a day means a split shift
}

/** Roll a month of attendance up per roster name. */
function summariseAttendance(rows: AttendanceDay[], leave: LeaveDay[], monthStart: string, monthEnd: string) {
  const out: Record<string, AttendanceSummary> = {};
  const blank = (): AttendanceSummary => ({ days: 0, hours: 0, late: 0, openShifts: 0, leaveDays: 0, shifts: 0 });
  // A day can hold several shifts — a morning and an evening — so days are
  // counted per date and only the clock-in that opened the date can be late.
  const seenDays = new Map<string, AttendanceDay>();   // "roster|date" -> earliest row
  for (const r of rows) {
    const a = (out[r.rosterName] ??= blank());
    a.shifts++;
    if (r.hours === null) a.openShifts++; else a.hours += r.hours;
    const key = `${r.rosterName}|${r.date}`;
    const first = seenDays.get(key);
    if (!first) {
      a.days++;
      seenDays.set(key, r);
    } else if (r.clockIn && first.clockIn && r.clockIn < first.clockIn) {
      seenDays.set(key, r);
    }
  }
  for (const r of seenDays.values()) {
    if (r.isLate && !r.justified) out[r.rosterName].late++;
  }
  for (const l of leave) {
    const a = (out[l.rosterName] ??= blank());
    // only the part of the leave that falls inside this month, Fridays excluded
    for (const d of eachDayOfInterval({ start: new Date(l.start + 'T12:00:00'), end: new Date(l.end + 'T12:00:00') })) {
      const iso = format(d, 'yyyy-MM-dd');
      if (iso >= monthStart && iso <= monthEnd && !isFriday(d)) a.leaveDays++;
    }
  }
  return out;
}

/**
 * Per-person KPIs for a set of cases — the same shape whether the range is one
 * day or one month, so the manager reads his team the same way in both views.
 */
function buildTeam(cases: Case[]) {
  // formula the daily PDF prints, so the manager and the report agree. It is
  // deliberately not sales ÷ every case: browsing visits are footfall, not a
  // chance that was lost.
  const today = format(new Date(), 'yyyy-MM-dd');
  type Person = {
    name: string; sales: number; kd: number; lost: number; browsing: number;
    openFU: number; overdueFU: number; outlets: Set<string>;
    brands: Record<string, number>;
  };
  const staffMap: Record<string, Person> = {};
  const blank = (name: string): Person => ({
    name, sales: 0, kd: 0, lost: 0, browsing: 0, openFU: 0, overdueFU: 0,
    outlets: new Set<string>(), brands: {},
  });
  for (const c of cases) {
    const p = (staffMap[c.staff] ??= blank(c.staff));
    if (c.outlet) p.outlets.add(c.outlet);
    if (c.caseType === 'Sale') {
      p.sales++;
      p.kd += c.amountKD || 0;
      for (const item of getEffectiveItems(c)) {
        const b = item.brand || 'Unknown';
        p.brands[b] = (p.brands[b] || 0) + (item.amountKD || 0);
      }
    } else if (c.caseType === 'Lost Sale') {
      p.lost++;
    } else if (c.caseType === 'No Interaction') {
      p.browsing += c.visitorCount ?? 1;
    } else if (c.caseType === 'Follow-up' && c.status === 'Open') {
      p.openFU++;
      if (c.promisedCallback && c.promisedCallback < today) p.overdueFU++;
    }
  }
  return Object.values(staffMap)
    .map((d) => {
      const decided = d.sales + d.lost;
      const topBrand = Object.entries(d.brands).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
      return {
        ...d,
        outletList: [...d.outlets].sort(),
        topBrand,
        cases: d.sales + d.lost + d.openFU + d.browsing,
        followupsOwed: d.openFU,
        conv: decided > 0 ? Math.round((d.sales / decided) * 100) : 0,
        avg: d.sales > 0 ? d.kd / d.sales : 0,
      };
    })
    .sort((a, b) => b.kd - a.kd);
}

export type TeamMember = ReturnType<typeof buildTeam>[number];



function MonthView() {
  // One whole month at a time, navigated back and forward. A shop is run and
  // paid by the month, so that is the unit the manager compares.
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const rangeStart = format(month, 'yyyy-MM-dd');
  const rangeEnd = format(endOfMonth(month), 'yyyy-MM-dd');
  const isThisMonth = format(month, 'yyyy-MM') === format(new Date(), 'yyyy-MM');
  const [cases, setCases] = useState<Case[]>([]);
  const [drillDown, setDrillDown] = useState<DrillDown | null>(null);

  function drillInto(title: string, filteredCases: Case[]) {
    setDrillDown({ title, cases: filteredCases });
  }

  const [attendance, setAttendance] = useState<AttendanceDay[]>([]);
  const [leave, setLeave] = useState<LeaveDay[]>([]);
  const [sheetFor, setSheetFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    // `to` is exclusive for attendance, so ask for the first of the next month
    const nextMonth = format(startOfMonth(addMonths(month, 1)), 'yyyy-MM-dd');
    const [data, att, lv] = await Promise.all([
      getCasesForRange(rangeStart, rangeEnd),
      getTeamAttendance(rangeStart, nextMonth),
      getTeamLeave(rangeStart, rangeEnd),
    ]);
    setCases(data);
    setAttendance(att);
    setLeave(lv);
  }, [rangeStart, rangeEnd, month]);

  useEffect(() => { load(); }, [load]);

  const stats = useMemo(() => {
    const sales = cases.filter(c => c.caseType === 'Sale');
    const followups = cases.filter(c => c.caseType === 'Follow-up');
    const lost = cases.filter(c => c.caseType === 'Lost Sale');
    const revenue = sales.reduce((s, c) => s + (c.amountKD || 0), 0);
    const totalVisitors = cases.reduce((s, c) => s + (c.visitorCount ?? 1), 0);
    const interactions = sales.length + followups.length + lost.length;
    const convRate = interactions > 0 ? Math.round((sales.length / interactions) * 100) : 0;
    const visitorConv = totalVisitors > 0 ? Math.round((sales.length / totalVisitors) * 100) : 0;
    const interactionRate = totalVisitors > 0 ? Math.round((interactions / totalVisitors) * 100) : 0;

    const leaderboard = buildTeam(cases);
    const attendanceBy = summariseAttendance(attendance, leave, rangeStart, rangeEnd);

    const lostReasonMap: Record<string, number> = {};
    for (const c of lost) { const r = c.lostReason || 'Other'; lostReasonMap[r] = (lostReasonMap[r] || 0) + 1; }
    const lostReasons = Object.entries(lostReasonMap).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

    // Brand-level analytics — uses getEffectiveItems for multi-item sale support
    const brandSalesMap: Record<string, { count: number; kd: number }> = {};
    for (const c of sales) {
      const items = getEffectiveItems(c);
      for (const item of items) {
        const key = item.brand || 'Unknown';
        if (!brandSalesMap[key]) brandSalesMap[key] = { count: 0, kd: 0 };
        brandSalesMap[key].count++;
        brandSalesMap[key].kd += item.amountKD || 0;
      }
      // Count the transaction as 1 sale per transaction (already counted above via items count)
      // but for cases with no items, fall back
      if (items.length === 0) {
        const key = c.brand || c.product || 'Unknown';
        if (!brandSalesMap[key]) brandSalesMap[key] = { count: 0, kd: 0 };
        brandSalesMap[key].count++;
        brandSalesMap[key].kd += c.amountKD || 0;
      }
    }
    const brandSales = Object.entries(brandSalesMap)
      .map(([brand, d]) => ({ brand, ...d }))
      .sort((a, b) => b.kd - a.kd)
      .slice(0, 8);

    const brandLostMap: Record<string, number> = {};
    for (const c of lost) {
      const key = c.brand || c.product || 'Unknown';
      brandLostMap[key] = (brandLostMap[key] || 0) + 1;
    }
    const brandLost = Object.entries(brandLostMap)
      .map(([brand, count]) => ({ brand, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    const lostBrands: Record<string, number> = {};
    const followUpBrands: Record<string, number> = {};
    for (const c of lost) { const k = c.brand || c.product; if (k) lostBrands[k] = (lostBrands[k] || 0) + 1; }
    for (const c of followups) { const k = c.brand || c.product; if (k) followUpBrands[k] = (followUpBrands[k] || 0) + 1; }

    return {
      sales, followups, lost, revenue, convRate, visitorConv, interactionRate, totalVisitors,
      leaderboard, attendanceBy, lostReasons, brandSales, brandLost,
      topLostProducts: Object.entries(lostBrands).sort((a, b) => b[1] - a[1]).slice(0, 5),
      topFollowUpProducts: Object.entries(followUpBrands).sort((a, b) => b[1] - a[1]).slice(0, 5),
      openFollowUps: followups.filter(c => c.status === 'Open').length,
    };
  }, [cases, attendance, leave, rangeStart, rangeEnd]);


  return (
    <div className="space-y-6">
      {/* Month navigator */}
      <div className="card p-3 flex items-center justify-between gap-2">
        <button onClick={() => setMonth(m => subMonths(m, 1))}
          className="p-2 rounded-xl text-slate-500 hover:bg-slate-100 transition-colors" aria-label="Previous month">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="text-center min-w-0">
          <div className="font-bold text-slate-900 leading-tight">{format(month, 'MMMM yyyy')}</div>
          <div className="text-[11px] text-slate-400">
            {isThisMonth ? `1–${format(new Date(), 'd MMM')} · so far` : 'full month'}
          </div>
        </div>
        <button onClick={() => setMonth(m => startOfMonth(addMonths(m, 1)))}
          disabled={isThisMonth}
          className="p-2 rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          aria-label="Next month">
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiTile icon={<DollarSign className="w-5 h-5" />} label="Total Revenue" value={`${formatKDCompact(stats.revenue)} KD`} color="brand" />
        <KpiTile icon={<TrendingUp className="w-5 h-5" />} label="Visitor Conv." value={`${stats.visitorConv}%`} color="emerald" />
        <KpiTile icon={<Users className="w-5 h-5" />} label="Total Visitors" value={String(stats.totalVisitors)} color="amber" />
        <KpiTile icon={<TrendingUp className="w-5 h-5" />} label="Interaction Rate" value={`${stats.interactionRate}%`} color="brand" />
        <KpiTile icon={<AlertCircle className="w-5 h-5" />} label="Open Follow-ups" value={String(stats.openFollowUps)} color="rose" />
      </div>

      {/* Desktop: two-column layout */}
      <div className="lg:grid lg:grid-cols-2 lg:gap-6 space-y-6 lg:space-y-0">
        <div className="lg:col-span-2">
          <TeamCards
            team={stats.leaderboard}
            attendanceBy={stats.attendanceBy}
            onOpen={(name) => drillInto(`${name} — All Cases`, cases.filter(c => c.staff === name))}
            onSheet={(name) => setSheetFor(name)}
          />
        </div>

        {stats.lostReasons.length > 0 && (
          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-slate-900">Lost Sale Reasons</h3>
              <span className="text-[10px] text-slate-400">Click bars ↗</span>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={stats.lostReasons} layout="vertical" margin={{ left: 8, right: 16 }}>
                <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={130} />
                <Tooltip formatter={(v) => [`${v} cases`, 'Count']} />
                <Bar dataKey="count" radius={[0, 4, 4, 0]} cursor="pointer"
                  onClick={(data) => drillInto(
                    `Lost Reason: ${data.name}`,
                    stats.lost.filter(c => (c.lostReason || 'Other') === data.name)
                  )}>
                  {stats.lostReasons.map((_, i) => <Cell key={i} fill={i === 0 ? '#e11d48' : '#fda4af'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Brand analytics */}
      <div className="lg:grid lg:grid-cols-2 lg:gap-6 space-y-6 lg:space-y-0">
        {stats.brandSales.length > 0 && (
          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-slate-900">Sales by Brand</h3>
              <span className="text-[10px] text-slate-400">Click bars ↗</span>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={stats.brandSales} layout="vertical" margin={{ left: 8, right: 16 }}>
                <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                <YAxis type="category" dataKey="brand" tick={{ fontSize: 11 }} width={110} />
                <Tooltip formatter={(v, name) => [name === 'kd' ? `${v} KD` : `${v}`, name === 'kd' ? 'Revenue' : 'Sales']} />
                <Bar dataKey="kd" name="kd" radius={[0, 4, 4, 0]} cursor="pointer"
                  onClick={(data) => drillInto(
                    `Sales — ${data.brand}`,
                    stats.sales.filter(c => {
                      const items = getEffectiveItems(c);
                      return items.some(i => (i.brand || 'Unknown') === data.brand) ||
                        (items.length === 0 && (c.brand || c.product || 'Unknown') === data.brand);
                    })
                  )}>
                  {stats.brandSales.map((_, i) => <Cell key={i} fill={i === 0 ? '#1e40af' : '#93c5fd'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {stats.brandLost.length > 0 && (
          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-slate-900">Lost Sales by Brand</h3>
              <span className="text-[10px] text-slate-400">Click bars ↗</span>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={stats.brandLost} layout="vertical" margin={{ left: 8, right: 16 }}>
                <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                <YAxis type="category" dataKey="brand" tick={{ fontSize: 11 }} width={110} />
                <Tooltip formatter={(v) => [`${v} cases`, 'Lost']} />
                <Bar dataKey="count" radius={[0, 4, 4, 0]} cursor="pointer"
                  onClick={(data) => drillInto(
                    `Lost Sales — ${data.brand}`,
                    stats.lost.filter(c => (c.brand || c.product || 'Unknown') === data.brand)
                  )}>
                  {stats.brandLost.map((_, i) => <Cell key={i} fill={i === 0 ? '#e11d48' : '#fda4af'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ProductSignalCard title="Re-order Signals" subtitle="Most-lost brands"
          items={stats.topLostProducts} color="rose"
          cases={stats.lost}
          onItemClick={drillInto} />
        <ProductSignalCard title="Demand Signals" subtitle="Most-followed-up brands"
          items={stats.topFollowUpProducts} color="amber"
          cases={stats.followups}
          onItemClick={drillInto} />
      </div>

      {sheetFor && (
        <AttendanceSheet
          name={sheetFor} month={month} rows={attendance} leave={leave}
          onClose={() => setSheetFor(null)}
        />
      )}

      {drillDown && (
        <DrillDownModal drillDown={drillDown} onClose={() => setDrillDown(null)} />
      )}
    </div>
  );
}


/** The manager's main view of his team: one card per salesperson. */
function TeamCards({ team, onOpen, onSheet, attendanceBy, subtitle }: {
  team: TeamMember[];
  onOpen: (name: string) => void;
  onSheet: (name: string) => void;
  attendanceBy: Record<string, AttendanceSummary>;
  subtitle?: string;
}) {
  const top = team[0]?.kd ?? 0;
  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-bold text-slate-900">Team{subtitle ? <span className="font-normal text-slate-400 text-sm ml-2">{subtitle}</span> : null}</h3>
        <span className="text-[10px] text-slate-400">Tap a card to see their cases ↗</span>
      </div>
      {team.length === 0 ? (
        <p className="text-slate-400 text-sm">Nobody has logged anything yet.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {team.map((s, i) => (
            <button key={s.name} type="button" onClick={() => onOpen(s.name)}
              className="card p-4 text-left hover:border-brand-200 hover:shadow-md transition-all focus:outline-none focus:ring-2 focus:ring-brand-200">
              <div className="flex items-start gap-2 mb-3">
                <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${i === 0 && s.kd > 0 ? 'bg-amber-400 text-amber-900' : 'bg-slate-100 text-slate-500'}`}>{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-slate-900 text-sm truncate">{s.name}</div>
                  <div className="text-[11px] text-slate-400 truncate">
                    {s.outletList.length > 0 ? s.outletList.join(' · ') : 'No outlet'}
                  </div>
                </div>
              </div>

              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-bold text-brand-700 leading-none">{formatKDCompact(s.kd)}</span>
                <span className="text-xs font-semibold text-slate-400">KD</span>
              </div>
              <div className="mt-1.5 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full bg-brand-500 rounded-full" style={{ width: `${top > 0 ? (s.kd / top) * 100 : 0}%` }} />
              </div>

              <div className="grid grid-cols-3 gap-2 mt-3 text-center">
                <StaffStat label="Sales" value={String(s.sales)} />
                <StaffStat label="Close rate" value={s.sales + s.lost === 0 ? '—' : `${s.conv}%`}
                  tone={s.sales + s.lost === 0 ? 'muted' : s.conv >= 50 ? 'good' : s.conv >= 25 ? 'warn' : 'bad'} />
                <StaffStat label="Avg sale" value={s.sales > 0 ? formatKDCompact(s.avg) : '—'} />
                <StaffStat label="Lost" value={String(s.lost)} tone={s.lost > 0 ? 'bad' : 'muted'} />
                <StaffStat label="Browsing" value={String(s.browsing)} />
                <StaffStat label="Open FU" value={String(s.openFU)}
                  tone={s.overdueFU > 0 ? 'bad' : s.openFU > 0 ? 'warn' : 'muted'}
                  sub={s.overdueFU > 0 ? `${s.overdueFU} overdue` : undefined} />
              </div>

              {/* Attendance for the same month, from the clock-in records */}
              {(() => {
                const a = attendanceBy[s.name];
                return (
                  <div className="mt-3 pt-2.5 border-t border-slate-100">
                    <div className="flex items-center gap-3 text-[11px]">
                      <span className="flex items-center gap-1 text-slate-600">
                        <Clock className="w-3 h-3 text-slate-400 shrink-0" />
                        {a && a.days > 0
                          ? <><span className="font-semibold">{Math.round(a.hours)}h</span> over {a.days} day{a.days === 1 ? '' : 's'}{a.shifts > a.days ? ` · ${a.shifts} shifts` : ''}</>
                          : <span className="text-slate-400">No clock-ins</span>}
                      </span>
                      {a && a.late > 0 && <span className="text-amber-600 font-medium">{a.late} late</span>}
                      {a && a.leaveDays > 0 && <span className="text-blue-600">{a.leaveDays}d leave</span>}
                    </div>
                    {a && a.openShifts > 0 && (
                      <div className="text-[10px] text-slate-400 mt-0.5">
                        {a.openShifts} shift{a.openShifts === 1 ? '' : 's'} never clocked out
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2 mt-2">
                      {s.topBrand
                        ? <span className="text-[11px] text-slate-500 truncate">Best brand <span className="font-semibold text-slate-700">{s.topBrand}</span></span>
                        : <span />}
                      <span
                        role="button" tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); onSheet(s.name); }}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onSheet(s.name); } }}
                        className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold text-brand-700 bg-brand-50 px-2 py-1 rounded-lg hover:bg-brand-100 transition-colors cursor-pointer">
                        <CalendarDays className="w-3 h-3" /> Attendance
                      </span>
                    </div>
                  </div>
                );
              })()}
            </button>
          ))}
        </div>
      )}
    </>
  );
}


/**
 * Clock times, always in the shops' timezone.
 *
 * date-fns `format` uses the viewer's device clock, so an owner opening this
 * from another country would read a salesperson's 08:55 start as 05:55. The
 * date these rows are grouped by is already pinned to Kuwait in `db`; the time
 * has to be pinned the same way.
 */
const kuwaitTime = (ts: string) =>
  new Date(ts).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Kuwait', hour: '2-digit', minute: '2-digit',
  });

/**
 * One person's month of attendance as a calendar.
 *
 * Every day in the month gets a square so the gaps are as visible as the
 * presence: worked (with the hours), late, on leave, Friday, or absent. Days
 * that have not happened yet are left blank rather than marked absent.
 */
/* Exported so the Team tab opens this month sheet rather than growing a second
   one. It renders its own modal and takes the month's rows, which is why the
   caller fetches them. */
export function AttendanceSheet({ name, month, rows, leave, onClose }: {
  name: string; month: Date; rows: AttendanceDay[]; leave: LeaveDay[]; onClose: () => void;
}) {
  const days = eachDayOfInterval({ start: startOfMonth(month), end: endOfMonth(month) });
  const today = format(new Date(), 'yyyy-MM-dd');
  const mine = rows.filter(r => r.rosterName === name).sort((a, b) => (a.clockIn ?? '').localeCompare(b.clockIn ?? ''));
  // Several shifts can share a date, so a square summarises the whole day
  // rather than showing whichever record happened to be last in the list.
  const byDate = new Map<string, AttendanceDay[]>();
  for (const r of mine) {
    const list = byDate.get(r.date) ?? [];
    list.push(r);
    byDate.set(r.date, list);
  }
  const onLeave = (iso: string) =>
    leave.find(l => l.rosterName === name && l.start <= iso && l.end >= iso);

  const worked = byDate.size;                                   // days, not clock-ins
  const hours = mine.reduce((t, r) => t + (r.hours ?? 0), 0);
  // only the shift that opened a day can make that day late
  const lates = [...byDate.values()].filter(day => day[0].isLate && !day[0].justified).length;
  // the week starts on Saturday in Kuwait, so shift the first column accordingly
  const pad = (days[0].getDay() + 1) % 7;

  return (
    <Modal open onClose={onClose} title={`${name} — ${format(month, 'MMMM yyyy')}`} size="lg">
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-slate-50 rounded-xl py-2">
            <div className="text-lg font-bold text-slate-800 leading-none">{worked}</div>
            <div className="text-[11px] text-slate-400 mt-1">Days worked</div>
          </div>
          <div className="bg-slate-50 rounded-xl py-2">
            <div className="text-lg font-bold text-slate-800 leading-none">{Math.round(hours)}h</div>
            <div className="text-[11px] text-slate-400 mt-1">Total hours</div>
          </div>
          <div className="bg-slate-50 rounded-xl py-2">
            <div className={`text-lg font-bold leading-none ${lates > 0 ? 'text-amber-600' : 'text-slate-800'}`}>{lates}</div>
            <div className="text-[11px] text-slate-400 mt-1">Late</div>
          </div>
        </div>

        <div>
          <div className="grid grid-cols-7 gap-1 mb-1">
            {['Sa', 'Su', 'Mo', 'Tu', 'We', 'Th', 'Fr'].map(d => (
              <div key={d} className="text-[10px] font-semibold text-slate-400 text-center">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: pad }, (_, i) => <div key={`pad${i}`} />)}
            {days.map(d => {
              const iso = format(d, 'yyyy-MM-dd');
              const day = byDate.get(iso);
              const lv = onLeave(iso);
              const future = iso > today;
              const friday = isFriday(d);

              let cls = 'bg-slate-50 text-slate-300';
              let note = '';
              if (day) {
                const dayHours = day.reduce((t, r) => t + (r.hours ?? 0), 0);
                const stillIn = day.some(r => r.hours === null);
                cls = day[0].isLate && !day[0].justified
                  ? 'bg-amber-100 text-amber-800 border border-amber-200'
                  : 'bg-emerald-100 text-emerald-800 border border-emerald-200';
                note = stillIn && dayHours === 0 ? 'open' : `${dayHours.toFixed(1)}h`;
              } else if (lv) {
                cls = 'bg-blue-100 text-blue-700 border border-blue-200';
                // a blind slice turned "Annual" into "Annu"
                note = lv.type === 'WFH' ? 'WFH' : lv.type === 'Sick' ? 'Sick' : 'Leave';
              } else if (friday) {
                cls = 'bg-slate-100 text-slate-400';
                note = '—';
              } else if (!future) {
                cls = 'bg-rose-50 text-rose-400 border border-rose-100';
                note = 'absent';
              }

              return (
                <div key={iso} className={`rounded-lg px-1 py-1.5 text-center ${cls}`}
                  title={day
                    ? day.map(r => `${kuwaitTime(r.clockIn!)}${r.clockOut ? ` → ${kuwaitTime(r.clockOut)}` : ' → still in'}`).join('\n')
                      + (day[0].location ? `\n${day[0].location}` : '')
                    : undefined}>
                  <div className="text-[11px] font-semibold leading-none">{format(d, 'd')}</div>
                  <div className="text-[9px] leading-tight mt-0.5 truncate">{note}</div>
                  {/* two dots means the day was split into two shifts */}
                  {day && day.length > 1 && (
                    <div className="text-[8px] leading-none mt-0.5 opacity-70">{'•'.repeat(Math.min(day.length, 3))}</div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-3 mt-3 text-[10px] text-slate-400">
            <span><span className="inline-block w-2 h-2 rounded bg-emerald-200 mr-1" />On time</span>
            <span><span className="inline-block w-2 h-2 rounded bg-amber-200 mr-1" />Late</span>
            <span><span className="inline-block w-2 h-2 rounded bg-blue-200 mr-1" />Leave</span>
            <span><span className="inline-block w-2 h-2 rounded bg-rose-100 mr-1" />Absent</span>
            <span><span className="inline-block w-2 h-2 rounded bg-slate-200 mr-1" />Friday</span>
          </div>
        </div>

        {mine.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Clock-ins</p>
            <div className="space-y-1 max-h-56 overflow-y-auto">
              {[...mine].sort((a, b) => (b.clockIn ?? '').localeCompare(a.clockIn ?? '')).map(r => (
                <div key={r.date + r.clockIn} className="flex items-center gap-2 text-xs py-1 border-b border-slate-50 last:border-0">
                  <span className="w-20 shrink-0 text-slate-500">{format(new Date(r.date + 'T12:00:00'), 'EEE d MMM')}</span>
                  <span className="font-medium text-slate-700">{kuwaitTime(r.clockIn!)}</span>
                  <span className="text-slate-300">→</span>
                  <span className="font-medium text-slate-700">{r.clockOut ? kuwaitTime(r.clockOut) : <span className="text-amber-600">still in</span>}</span>
                  {r.hours !== null && <span className="text-slate-400">({r.hours.toFixed(1)}h)</span>}
                  {r.isLate && !r.justified && <span className="text-amber-600 ml-auto">late</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** One KPI inside a team member's card. */
function StaffStat({ label, value, tone = 'plain', sub }: {
  label: string; value: string; tone?: 'plain' | 'good' | 'warn' | 'bad' | 'muted'; sub?: string;
}) {
  const toneClass = {
    plain: 'text-slate-800', good: 'text-emerald-600', warn: 'text-amber-600',
    bad: 'text-rose-600', muted: 'text-slate-400',
  }[tone];
  return (
    <div className="bg-slate-50 rounded-xl py-2 px-1">
      <div className={`text-sm font-bold leading-none ${toneClass}`}>{value}</div>
      <div className="text-[10px] text-slate-400 mt-1 leading-tight">{label}</div>
      {sub && <div className="text-[10px] text-rose-500 leading-tight">{sub}</div>}
    </div>
  );
}

function KpiTile({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: 'brand' | 'emerald' | 'amber' | 'rose' }) {
  const colors = { brand: 'bg-brand-50 text-brand-700', emerald: 'bg-emerald-50 text-emerald-700', amber: 'bg-amber-50 text-amber-700', rose: 'bg-rose-50 text-rose-700' };
  return (
    <div className={`${colors[color]} rounded-2xl p-4`}>
      <div className="flex items-center gap-2 mb-2 opacity-70">{icon}<span className="text-xs font-semibold uppercase tracking-wide">{label}</span></div>
      <p className="text-xl font-bold leading-none">{value}</p>
    </div>
  );
}

function ProductSignalCard({ title, subtitle, items, color, cases, onItemClick }: {
  title: string;
  subtitle: string;
  items: [string, number][];
  color: 'rose' | 'amber';
  cases: Case[];
  onItemClick: (title: string, cases: Case[]) => void;
}) {
  const barColor = color === 'rose' ? 'bg-rose-400' : 'bg-amber-400';
  const max = items[0]?.[1] || 1;
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-1">
        <p className="font-bold text-slate-900 text-sm">{title}</p>
        <span className="text-[10px] text-slate-400">Click to see cases ↗</span>
      </div>
      <p className="text-xs text-slate-400 mb-3">{subtitle}</p>
      {items.length === 0 ? <p className="text-slate-400 text-xs">No data</p> : (
        <div className="space-y-1.5">
          {items.map(([product, count]) => (
            <button
              key={product}
              type="button"
              onClick={() => {
                const matching = cases.filter(c => (c.brand || c.product) === product);
                onItemClick(`${title} — ${product}`, matching);
              }}
              className="w-full text-left rounded-xl px-2 py-1.5 -mx-2 hover:bg-slate-50 transition-colors"
            >
              <div className="flex justify-between text-xs mb-0.5">
                <span className="font-medium text-slate-700 truncate">{product}</span>
                <span className="text-slate-500 shrink-0 ml-2">{count}</span>
              </div>
              <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div className={`h-full ${barColor} rounded-full`} style={{ width: `${(count / max) * 100}%` }} />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Drill-down modal ──────────────────────────────────────────────────────────

function DrillDownModal({ drillDown, onClose }: { drillDown: DrillDown; onClose: () => void }) {
  const sorted = [...drillDown.cases].sort((a, b) =>
    b.dateLogged.localeCompare(a.dateLogged) || b.timeLogged.localeCompare(a.timeLogged)
  );

  return (
    <Modal
      open
      onClose={onClose}
      title=""
      size="lg"
      footer={<button onClick={onClose} className="btn-ghost ml-auto">Close</button>}
    >
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-bold text-slate-900 text-lg leading-snug">{drillDown.title}</h2>
            <p className="text-sm text-slate-400 mt-0.5">{drillDown.cases.length} case{drillDown.cases.length !== 1 ? 's' : ''}</p>
          </div>
        </div>

        {/* Case list */}
        {sorted.length === 0 ? (
          <p className="text-slate-400 text-sm text-center py-8">No cases found.</p>
        ) : (
          <div className="space-y-2.5 max-h-[480px] overflow-y-auto pr-1">
            {sorted.map(c => (
              <div key={c.id} className="bg-slate-50 rounded-2xl p-3.5">
                {/* Top row */}
                <div className="flex items-start gap-3">
                  <div className="shrink-0 text-center w-12">
                    <p className="text-[10px] font-medium text-slate-400 leading-none">
                      {format(new Date(c.dateLogged + 'T12:00:00'), 'MMM')}
                    </p>
                    <p className="text-base font-bold text-slate-700 leading-none mt-0.5">
                      {format(new Date(c.dateLogged + 'T12:00:00'), 'd')}
                    </p>
                    <p className="text-[10px] text-slate-300 leading-none mt-0.5">
                      {format(new Date(c.dateLogged + 'T12:00:00'), 'yyyy')}
                    </p>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1.5">
                      <CaseTypeBadge type={c.caseType} />
                      {c.brand && <span className="text-xs font-semibold text-slate-700">{c.brand}</span>}
                      {c.productType && <span className="text-xs text-slate-400">{c.productType}</span>}
                      <span className="text-xs text-slate-400 ml-auto shrink-0">{c.staff}</span>
                    </div>
                    {c.product && c.product !== c.brand && (
                      <p className="text-xs text-slate-500 mb-1">{c.product}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                      {c.lostReason && (
                        <span className="text-rose-600 font-medium">Reason: {c.lostReason}</span>
                      )}
                      {c.followUpAction && (
                        <span className="text-amber-700 font-medium">Action: {c.followUpAction}</span>
                      )}
                      {c.promisedCallback && (
                        <span className="text-slate-400">
                          Callback: {format(new Date(c.promisedCallback + 'T12:00:00'), 'd MMM yyyy')}
                        </span>
                      )}
                      {c.amountKD != null && c.amountKD > 0 && (
                        <span className="font-bold text-emerald-700 ml-auto">{formatKD(c.amountKD)} KD</span>
                      )}
                    </div>
                    {c.notes && (
                      <p className="text-xs text-slate-600 italic mt-1.5 leading-snug">"{c.notes}"</p>
                    )}
                    {(c.customerName || c.contact) && (
                      <p className="text-xs text-slate-400 mt-1">
                        {[c.customerName, c.contact].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
