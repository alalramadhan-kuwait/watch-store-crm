import { useState, useMemo } from 'react';
import { format, subDays, startOfDay, endOfDay } from 'date-fns';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { TrendingUp, Users, AlertCircle, DollarSign, Calendar, LogOut } from 'lucide-react';
import { db, getCasesForRange } from '../db';
import { formatKD, formatKDCompact } from '../utils/formatKD';
import { useAppStore } from '../store';
import { CaseTypeBadge, DayStatusBadge } from './shared/Badge';
import type { Case } from '../types';

const TEAL = '#0f766e';

export function ManagerDashboard() {
  const { setManagerAuthed } = useAppStore();
  const [view, setView] = useState<'daily' | 'weekly'>('daily');

  return (
    <div className="px-4 pt-6 pb-32 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Manager Dashboard</h1>
          <p className="text-slate-500 text-sm mt-0.5">{format(new Date(), 'EEEE, d MMMM yyyy')}</p>
        </div>
        <button
          onClick={() => setManagerAuthed(false)}
          className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 py-2 px-3 rounded-xl hover:bg-slate-100"
        >
          <LogOut className="w-4 h-4" /> Lock
        </button>
      </div>

      {/* Tab switcher */}
      <div className="flex bg-slate-100 rounded-2xl p-1 mb-6 gap-1">
        {(['daily', 'weekly'] as const).map(t => (
          <button
            key={t}
            onClick={() => setView(t)}
            className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all duration-150 capitalize ${
              view === t ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-500'
            }`}
          >
            {t === 'daily' ? 'Today' : 'Weekly'} View
          </button>
        ))}
      </div>

      {view === 'daily' ? <DailyView /> : <WeeklyView />}
    </div>
  );
}

function DailyView() {
  const today = format(new Date(), 'yyyy-MM-dd');
  const [staffFilter, setStaffFilter] = useState('');

  const cases = useLiveQuery(
    () => db.cases.where('dateLogged').equals(today).filter(c => !c.deleted).toArray(),
    [], []
  );
  const dayClose = useLiveQuery(() => db.dayCloses.where('date').equals(today).first());
  const openFollowUps = useLiveQuery(
    () => db.cases.where('caseType').equals('Follow-up').filter(c => !c.deleted && c.status === 'Open').count(),
    [], 0
  );
  const settings = useLiveQuery(() => db.settings.toArray().then(a => a[0]));

  const sales = (cases || []).filter(c => c.caseType === 'Sale');
  const followups = (cases || []).filter(c => c.caseType === 'Follow-up');
  const lost = (cases || []).filter(c => c.caseType === 'Lost Sale');
  const revenue = sales.reduce((s, c) => s + (c.amountKD || 0), 0);
  const total = sales.length + lost.length;
  const convRate = total > 0 ? Math.round((sales.length / total) * 100) : 0;

  const filteredCases = [...(cases || [])]
    .filter(c => !staffFilter || c.staff === staffFilter)
    .reverse();

  return (
    <div className="space-y-5">
      {/* Day status */}
      <div className="flex justify-end">
        <DayStatusBadge
          closed={!!dayClose}
          closedAt={dayClose ? format(new Date(dayClose.closedAt), 'HH:mm') : undefined}
        />
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-3">
        <KpiTile icon={<DollarSign className="w-5 h-5" />} label="Revenue Today" value={`${formatKDCompact(revenue)} KD`} color="brand" />
        <KpiTile icon={<TrendingUp className="w-5 h-5" />} label="Conversion Rate" value={`${convRate}%`} color="emerald" />
        <KpiTile icon={<Users className="w-5 h-5" />} label="Sales / Follow-ups / Lost" value={`${sales.length} / ${followups.length} / ${lost.length}`} color="amber" />
        <KpiTile icon={<AlertCircle className="w-5 h-5" />} label="Open Follow-ups" value={String(openFollowUps)} color="rose" />
      </div>

      {/* Staff filter */}
      <div>
        <select
          value={staffFilter}
          onChange={e => setStaffFilter(e.target.value)}
          className="input text-sm py-2"
        >
          <option value="">All staff</option>
          {settings?.staffRoster.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Case list */}
      <div className="space-y-2">
        {filteredCases.map(c => (
          <div key={c.id} className="card px-4 py-3 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <CaseTypeBadge type={c.caseType} />
                <span className="text-xs text-slate-400">{c.timeLogged}</span>
                <span className="text-xs text-slate-500">{c.staff}</span>
              </div>
              <p className="text-sm font-medium text-slate-800 mt-0.5 truncate">{c.product}</p>
              {c.customerName && <p className="text-xs text-slate-400">{c.customerName}</p>}
            </div>
            {c.amountKD && (
              <span className="text-sm font-bold text-emerald-700 shrink-0">{formatKD(c.amountKD)} KD</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function WeeklyView() {
  const [rangeEnd] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [rangeStart, setRangeStart] = useState(format(subDays(new Date(), 6), 'yyyy-MM-dd'));

  const cases = useLiveQuery(
    () => getCasesForRange(rangeStart, rangeEnd),
    [rangeStart, rangeEnd], []
  );

  const stats = useMemo(() => {
    const data = cases || [];
    const sales = data.filter(c => c.caseType === 'Sale');
    const followups = data.filter(c => c.caseType === 'Follow-up');
    const lost = data.filter(c => c.caseType === 'Lost Sale');
    const revenue = sales.reduce((s, c) => s + (c.amountKD || 0), 0);
    const total = sales.length + lost.length;
    const convRate = total > 0 ? Math.round((sales.length / total) * 100) : 0;

    // Staff leaderboard
    const staffMap: Record<string, { cases: number; sales: number; kd: number; followupsOwed: number }> = {};
    for (const c of data) {
      if (!staffMap[c.staff]) staffMap[c.staff] = { cases: 0, sales: 0, kd: 0, followupsOwed: 0 };
      staffMap[c.staff].cases++;
      if (c.caseType === 'Sale') { staffMap[c.staff].sales++; staffMap[c.staff].kd += c.amountKD || 0; }
      if (c.caseType === 'Follow-up' && c.status === 'Open') staffMap[c.staff].followupsOwed++;
    }
    const leaderboard = Object.entries(staffMap)
      .map(([name, d]) => ({ name, ...d, conv: d.cases > 0 ? Math.round((d.sales / d.cases) * 100) : 0 }))
      .sort((a, b) => b.kd - a.kd);

    // Lost reasons breakdown
    const lostReasonMap: Record<string, number> = {};
    for (const c of lost) {
      const r = c.lostReason || 'Other';
      lostReasonMap[r] = (lostReasonMap[r] || 0) + 1;
    }
    const lostReasons = Object.entries(lostReasonMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    // Product signals
    const lostProducts: Record<string, number> = {};
    const followUpProducts: Record<string, number> = {};
    for (const c of lost) lostProducts[c.product] = (lostProducts[c.product] || 0) + 1;
    for (const c of followups) followUpProducts[c.product] = (followUpProducts[c.product] || 0) + 1;

    const topLostProducts = Object.entries(lostProducts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const topFollowUpProducts = Object.entries(followUpProducts).sort((a, b) => b[1] - a[1]).slice(0, 5);

    const openFollowUps = followups.filter(c => c.status === 'Open').length;

    return { sales, followups, lost, revenue, convRate, leaderboard, lostReasons, topLostProducts, topFollowUpProducts, openFollowUps };
  }, [cases]);

  const quickRanges = [
    { label: '7 days', days: 6 },
    { label: '14 days', days: 13 },
    { label: '30 days', days: 29 },
  ];

  return (
    <div className="space-y-6">
      {/* Range selector */}
      <div className="card p-4">
        <div className="flex items-center gap-2 mb-3">
          <Calendar className="w-4 h-4 text-slate-400" />
          <span className="text-sm font-semibold text-slate-700">Date Range</span>
        </div>
        <div className="flex gap-2 mb-3">
          {quickRanges.map(({ label, days }) => (
            <button
              key={label}
              onClick={() => setRangeStart(format(subDays(new Date(), days), 'yyyy-MM-dd'))}
              className={`flex-1 py-2 rounded-xl text-xs font-semibold transition-colors ${
                rangeStart === format(subDays(new Date(), days), 'yyyy-MM-dd')
                  ? 'bg-brand-700 text-white'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              Last {label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input type="date" value={rangeStart} onChange={e => setRangeStart(e.target.value)} className="input text-sm py-2 flex-1" />
          <span className="self-center text-slate-400 text-sm">→</span>
          <input type="date" value={rangeEnd} readOnly className="input text-sm py-2 flex-1 bg-slate-50" />
        </div>
      </div>

      {/* Headline KPIs */}
      <div className="grid grid-cols-2 gap-3">
        <KpiTile icon={<DollarSign className="w-5 h-5" />} label="Total Revenue" value={`${formatKDCompact(stats.revenue)} KD`} color="brand" />
        <KpiTile icon={<TrendingUp className="w-5 h-5" />} label="Conversion" value={`${stats.convRate}%`} color="emerald" />
        <KpiTile icon={<Users className="w-5 h-5" />} label="Sales / FU / Lost" value={`${stats.sales.length} / ${stats.followups.length} / ${stats.lost.length}`} color="amber" />
        <KpiTile icon={<AlertCircle className="w-5 h-5" />} label="Open Follow-ups" value={String(stats.openFollowUps)} color="rose" />
      </div>

      {/* Staff leaderboard */}
      <div className="card p-4">
        <h3 className="font-bold text-slate-900 mb-3">Staff Leaderboard</h3>
        {stats.leaderboard.length === 0 ? (
          <p className="text-slate-400 text-sm">No data for this range.</p>
        ) : (
          <div className="space-y-3">
            {stats.leaderboard.map((s, i) => (
              <div key={s.name} className="flex items-center gap-3">
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                  i === 0 ? 'bg-amber-400 text-amber-900' : 'bg-slate-100 text-slate-500'
                }`}>{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-800 text-sm">{s.name}</span>
                    <span className="text-sm font-bold text-brand-700">{formatKD(s.kd)} KD</span>
                  </div>
                  <div className="flex gap-3 text-xs text-slate-500 mt-0.5">
                    <span>{s.sales} sales</span>
                    <span>{s.conv}% conv.</span>
                    {s.followupsOwed > 0 && <span className="text-amber-600">{s.followupsOwed} open FU</span>}
                  </div>
                  {/* Revenue bar */}
                  <div className="mt-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-brand-500 rounded-full"
                      style={{ width: `${stats.leaderboard[0].kd > 0 ? (s.kd / stats.leaderboard[0].kd) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Lost reasons chart */}
      {stats.lostReasons.length > 0 && (
        <div className="card p-4">
          <h3 className="font-bold text-slate-900 mb-3">Lost Sale Reasons</h3>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={stats.lostReasons} layout="vertical" margin={{ left: 8, right: 16 }}>
              <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={130} />
              <Tooltip formatter={(v) => [`${v} cases`, 'Count']} />
              <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                {stats.lostReasons.map((_, i) => (
                  <Cell key={i} fill={i === 0 ? '#e11d48' : '#fda4af'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Product signals */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ProductSignalCard
          title="🔴 Re-order Signals"
          subtitle="Most-lost products"
          items={stats.topLostProducts}
          color="rose"
        />
        <ProductSignalCard
          title="🟡 Demand Signals"
          subtitle="Most-followed-up products"
          items={stats.topFollowUpProducts}
          color="amber"
        />
      </div>
    </div>
  );
}

function KpiTile({ icon, label, value, color }: {
  icon: React.ReactNode; label: string; value: string;
  color: 'brand' | 'emerald' | 'amber' | 'rose';
}) {
  const colors = {
    brand: 'bg-brand-50 text-brand-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
    rose: 'bg-rose-50 text-rose-700',
  };
  return (
    <div className={`${colors[color]} rounded-2xl p-4`}>
      <div className="flex items-center gap-2 mb-2 opacity-70">
        {icon}
        <span className="text-xs font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <p className="text-xl font-bold leading-none">{value}</p>
    </div>
  );
}

function ProductSignalCard({ title, subtitle, items, color }: {
  title: string; subtitle: string; items: [string, number][]; color: 'rose' | 'amber';
}) {
  const barColor = color === 'rose' ? 'bg-rose-400' : 'bg-amber-400';
  const max = items[0]?.[1] || 1;
  return (
    <div className="card p-4">
      <p className="font-bold text-slate-900 text-sm">{title}</p>
      <p className="text-xs text-slate-400 mb-3">{subtitle}</p>
      {items.length === 0 ? (
        <p className="text-slate-400 text-xs">No data</p>
      ) : (
        <div className="space-y-2">
          {items.map(([product, count]) => (
            <div key={product}>
              <div className="flex justify-between text-xs mb-0.5">
                <span className="font-medium text-slate-700 truncate">{product}</span>
                <span className="text-slate-500 shrink-0 ml-2">{count}</span>
              </div>
              <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div className={`h-full ${barColor} rounded-full`} style={{ width: `${(count / max) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
