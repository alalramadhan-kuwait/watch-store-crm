import { useState, useMemo, useEffect, useCallback } from 'react';
import { format, subDays } from 'date-fns';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { TrendingUp, Users, AlertCircle, DollarSign, Calendar, FileText, X } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { getTodayCases, getDayClose, getCasesForRange, getSettings, countOpenFollowUps, getEffectiveItems } from '../db';
import { supabase } from '../lib/supabase';
import { formatKD, formatKDCompact } from '../utils/formatKD';
import { CaseTypeBadge, DayStatusBadge } from './shared/Badge';
import { Modal } from './shared/Modal';
import type { Case, AppSettings, DayClose } from '../types';

export function ManagerDashboard() {
  const [view, setView] = useState<'daily' | 'weekly'>('daily');

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

      <div className="flex bg-slate-100 rounded-2xl p-1 mb-6 gap-1 max-w-xs">
        {(['daily', 'weekly'] as const).map(t => (
          <button key={t} onClick={() => setView(t)}
            className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all duration-150 capitalize ${
              view === t ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-500'}`}>
            {t === 'daily' ? 'Today' : 'History'} View
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
  const [cases, setCases] = useState<Case[]>([]);
  const [dayClose, setDayClose] = useState<DayClose | null>(null);
  const [openFU, setOpenFU] = useState(0);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  const load = useCallback(async () => {
    const [c, dc, fu, s] = await Promise.all([
      getTodayCases(), getDayClose(today), countOpenFollowUps(), getSettings(),
    ]);
    setCases(c); setDayClose(dc); setOpenFU(fu); setSettings(s);
  }, [today]);

  useEffect(() => {
    load();
    const ch = supabase.channel('mgr-daily')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cases', filter: `date_logged=eq.${today}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'day_closes', filter: `date=eq.${today}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load, today]);

  const sales = cases.filter(c => c.caseType === 'Sale');
  const followups = cases.filter(c => c.caseType === 'Follow-up');
  const lost = cases.filter(c => c.caseType === 'Lost Sale');
  const revenue = sales.reduce((s, c) => s + (c.amountKD || 0), 0);
  const totalVisitors = cases.reduce((s, c) => s + (c.visitorCount ?? 1), 0);
  const interactions = sales.length + followups.length + lost.length;
  const convRate = interactions > 0 ? Math.round((sales.length / interactions) * 100) : 0;
  const visitorConv = totalVisitors > 0 ? Math.round((sales.length / totalVisitors) * 100) : 0;
  const filteredCases = [...cases].filter(c => !staffFilter || c.staff === staffFilter).reverse();

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <DayStatusBadge closed={!!dayClose} closedAt={dayClose ? format(new Date(dayClose.closedAt), 'HH:mm') : undefined} />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiTile icon={<DollarSign className="w-5 h-5" />} label="Revenue Today" value={`${formatKDCompact(revenue)} KD`} color="brand" />
        <KpiTile icon={<TrendingUp className="w-5 h-5" />} label="Visitor Conv." value={`${visitorConv}%`} color="emerald" />
        <KpiTile icon={<Users className="w-5 h-5" />} label="Total Visitors" value={String(totalVisitors)} color="amber" />
        <KpiTile icon={<AlertCircle className="w-5 h-5" />} label="Open Follow-ups" value={String(openFU)} color="rose" />
        <KpiTile icon={<TrendingUp className="w-5 h-5" />} label="Close Rate" value={`${convRate}%`} color="brand" />
      </div>

      <div>
        <select value={staffFilter} onChange={e => setStaffFilter(e.target.value)} className="input text-sm py-2 max-w-xs">
          <option value="">All staff</option>
          {settings?.staffRoster.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Desktop table */}
      <div className="hidden lg:block card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100">
              {['Time', 'Staff', 'Type', 'Brand / Product', 'Customer', 'KD'].map(h => (
                <th key={h} className="text-left py-3 px-4 text-xs font-semibold text-slate-400 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredCases.map(c => (
              <tr key={c.id} className="border-b border-slate-50 hover:bg-slate-50">
                <td className="py-3 px-4 text-slate-400 font-mono text-xs">{c.timeLogged}</td>
                <td className="py-3 px-4 font-medium text-slate-700">{c.staff}</td>
                <td className="py-3 px-4"><CaseTypeBadge type={c.caseType} /></td>
                <td className="py-3 px-4 text-slate-800 max-w-[220px]">
                  {c.caseType === 'No Interaction' ? (
                    <span className="text-slate-300">—</span>
                  ) : (
                    <>
                      <span className="font-medium truncate block">{c.brand || c.product}</span>
                      {c.productType && <span className="text-xs text-slate-400">{c.productType}</span>}
                      {c.caseType === 'Follow-up' && c.notes && (
                        <span className="text-xs text-slate-400 italic truncate block" title={c.notes}>{c.notes}</span>
                      )}
                      {c.caseType === 'Lost Sale' && c.product && c.product !== c.brand && (
                        <span className="text-xs text-slate-400 truncate block" title={c.product}>{c.product}</span>
                      )}
                    </>
                  )}
                </td>
                <td className="py-3 px-4 text-slate-500">{c.customerName || '—'}</td>
                <td className="py-3 px-4 font-semibold text-emerald-700">{c.amountKD ? formatKD(c.amountKD) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredCases.length === 0 && (
          <p className="text-center py-8 text-slate-400 text-sm">No cases logged today.</p>
        )}
      </div>

      {/* Mobile cards */}
      <div className="lg:hidden space-y-2">
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
            {c.amountKD && <span className="text-sm font-bold text-emerald-700 shrink-0">{formatKD(c.amountKD)} KD</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

interface DrillDown { title: string; cases: Case[]; }

function WeeklyView() {
  const [rangeEnd] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [rangeStart, setRangeStart] = useState(format(subDays(new Date(), 6), 'yyyy-MM-dd'));
  const [cases, setCases] = useState<Case[]>([]);
  const [drillDown, setDrillDown] = useState<DrillDown | null>(null);

  function drillInto(title: string, filteredCases: Case[]) {
    setDrillDown({ title, cases: filteredCases });
  }

  const load = useCallback(async () => {
    const data = await getCasesForRange(rangeStart, rangeEnd);
    setCases(data);
  }, [rangeStart, rangeEnd]);

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

    const staffMap: Record<string, { cases: number; sales: number; kd: number; followupsOwed: number }> = {};
    for (const c of cases) {
      if (!staffMap[c.staff]) staffMap[c.staff] = { cases: 0, sales: 0, kd: 0, followupsOwed: 0 };
      staffMap[c.staff].cases++;
      if (c.caseType === 'Sale') { staffMap[c.staff].sales++; staffMap[c.staff].kd += c.amountKD || 0; }
      if (c.caseType === 'Follow-up' && c.status === 'Open') staffMap[c.staff].followupsOwed++;
    }
    const leaderboard = Object.entries(staffMap)
      .map(([name, d]) => ({ name, ...d, conv: d.cases > 0 ? Math.round((d.sales / d.cases) * 100) : 0 }))
      .sort((a, b) => b.kd - a.kd);

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
      leaderboard, lostReasons, brandSales, brandLost,
      topLostProducts: Object.entries(lostBrands).sort((a, b) => b[1] - a[1]).slice(0, 5),
      topFollowUpProducts: Object.entries(followUpBrands).sort((a, b) => b[1] - a[1]).slice(0, 5),
      openFollowUps: followups.filter(c => c.status === 'Open').length,
    };
  }, [cases]);

  const quickRanges = [{ label: '7 days', days: 6 }, { label: '14 days', days: 13 }, { label: '30 days', days: 29 }];

  return (
    <div className="space-y-6">
      <div className="card p-4">
        <div className="flex items-center gap-2 mb-3">
          <Calendar className="w-4 h-4 text-slate-400" />
          <span className="text-sm font-semibold text-slate-700">Date Range</span>
        </div>
        <div className="flex gap-2 mb-3">
          {quickRanges.map(({ label, days }) => (
            <button key={label} onClick={() => setRangeStart(format(subDays(new Date(), days), 'yyyy-MM-dd'))}
              className={`flex-1 py-2 rounded-xl text-xs font-semibold transition-colors ${
                rangeStart === format(subDays(new Date(), days), 'yyyy-MM-dd') ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-600'}`}>
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

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiTile icon={<DollarSign className="w-5 h-5" />} label="Total Revenue" value={`${formatKDCompact(stats.revenue)} KD`} color="brand" />
        <KpiTile icon={<TrendingUp className="w-5 h-5" />} label="Visitor Conv." value={`${stats.visitorConv}%`} color="emerald" />
        <KpiTile icon={<Users className="w-5 h-5" />} label="Total Visitors" value={String(stats.totalVisitors)} color="amber" />
        <KpiTile icon={<TrendingUp className="w-5 h-5" />} label="Interaction Rate" value={`${stats.interactionRate}%`} color="brand" />
        <KpiTile icon={<AlertCircle className="w-5 h-5" />} label="Open Follow-ups" value={String(stats.openFollowUps)} color="rose" />
      </div>

      {/* Desktop: two-column layout */}
      <div className="lg:grid lg:grid-cols-2 lg:gap-6 space-y-6 lg:space-y-0">
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-slate-900">Staff Leaderboard</h3>
            <span className="text-[10px] text-slate-400">Click to see cases ↗</span>
          </div>
          {stats.leaderboard.length === 0 ? (
            <p className="text-slate-400 text-sm">No data for this range.</p>
          ) : (
            <div className="space-y-1">
              {stats.leaderboard.map((s, i) => (
                <div key={s.name}
                  onClick={() => drillInto(`${s.name} — All Cases`, cases.filter(c => c.staff === s.name))}
                  className="flex items-center gap-3 rounded-xl px-2 py-2 -mx-2 cursor-pointer hover:bg-slate-50 transition-colors">
                  <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${i === 0 ? 'bg-amber-400 text-amber-900' : 'bg-slate-100 text-slate-500'}`}>{i + 1}</span>
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
                    <div className="mt-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full bg-brand-500 rounded-full" style={{ width: `${stats.leaderboard[0].kd > 0 ? (s.kd / stats.leaderboard[0].kd) * 100 : 0}%` }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
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

      {drillDown && (
        <DrillDownModal drillDown={drillDown} onClose={() => setDrillDown(null)} />
      )}
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
