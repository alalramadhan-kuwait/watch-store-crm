import { useState, useEffect, useCallback } from 'react';
import { format } from 'date-fns';
import { Edit2, Trash2, Lock, Share2, FileText, ShieldAlert } from 'lucide-react';
import { formatKD, formatKDCompact } from '../utils/formatKD';
import { getTodayCases, getDayClose, closeDay, getSettings, updateCase, rebuildDaySummary, getCasesByDate } from '../db';
import { generatePDF, shareReport, downloadReport, buildDailyStats } from '../utils/report';
import { useAppStore } from '../store';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { CaseTypeBadge, DayStatusBadge } from './shared/Badge';
import { Modal, ConfirmModal } from './shared/Modal';
import type { Case, AppSettings, DayClose, CaseStatus } from '../types';
import { QuickEntryEdit } from './QuickEntryEdit';

const today = format(new Date(), 'yyyy-MM-dd');

export function TodayLog({ panelMode = false }: { panelMode?: boolean }) {
  const { showToast, refreshLog } = useAppStore();
  const { role, profile } = useAuth();
  const [cases, setCases] = useState<Case[]>([]);
  const [dayClose, setDayClose] = useState<DayClose | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  const [editCase, setEditCase] = useState<Case | null>(null);
  const [deleteCase, setDeleteCase] = useState<Case | null>(null);
  const [closeDayOpen, setCloseDayOpen] = useState(false);
  const [closeDaySummary, setCloseDaySummary] = useState<string | null>(null);
  const [closingDay, setClosingDay] = useState(false);
  const [closerName, setCloserName] = useState('');
  const [pdfUri, setPdfUri] = useState<string | null>(null);
  const [sharingPdf, setSharingPdf] = useState(false);

  const load = useCallback(async () => {
    const [c, dc, s] = await Promise.all([getTodayCases(), getDayClose(today), getSettings()]);
    setCases(c);
    setDayClose(dc);
    setSettings(s);
  }, []);

  useEffect(() => {
    load();
    const channel = supabase.channel('today-log')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cases', filter: `date_logged=eq.${today}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'day_closes', filter: `date=eq.${today}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  // Re-load immediately when QuickEntry saves (split-view sync)
  useEffect(() => {
    if (refreshLog > 0) load();
  }, [refreshLog]); // eslint-disable-line react-hooks/exhaustive-deps

  const isClosed = !!dayClose;

  const { activeOutlet } = useAppStore();
  const [outletFilter, setOutletFilter] = useState<string>('');

  // Staff see only their outlet; manager can filter or see all
  const filteredCases = cases.filter(c => {
    if (role === 'admin' && outletFilter) return c.outlet === outletFilter;
    if (role !== 'admin' && activeOutlet) return !c.outlet || c.outlet === activeOutlet;
    return true;
  });

  const sales = filteredCases.filter(c => c.caseType === 'Sale');
  const followups = filteredCases.filter(c => c.caseType === 'Follow-up');
  const lost = filteredCases.filter(c => c.caseType === 'Lost Sale');
  const noInteraction = filteredCases.filter(c => c.caseType === 'No Interaction');
  const revenue = sales.reduce((s, c) => s + (c.amountKD || 0), 0);
  const total = sales.length + lost.length;
  const convRate = total > 0 ? Math.round((sales.length / total) * 100) : 0;

  // Signature that changes when any case is added, removed, or its amount/status/type changes
  const casesSig = cases.map(c => `${c.id}:${c.amountKD}:${c.status}:${c.caseType}`).join('|');

  // Generate (or regenerate) the PDF whenever the day is closed AND case data changes
  useEffect(() => {
    if (isClosed && cases.length > 0) {
      setPdfUri(generatePDF(today, cases));
    }
  }, [isClosed, casesSig]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSharePdf() {
    if (!pdfUri) return;
    setSharingPdf(true);
    try {
      const result = await shareReport(today, pdfUri);
      showToast(result === 'shared' ? 'Report shared!' : 'PDF downloaded.', 'success');
    } finally {
      setSharingPdf(false);
    }
  }

  function handleDownloadPdf() {
    if (!pdfUri) return;
    downloadReport(today, pdfUri);
  }

  async function handleDelete() {
    if (!deleteCase?.id) return;
    const managerName = profile?.full_name || 'Manager';
    await updateCase(deleteCase.id, {
      deleted: true,
      auditLog: [
        ...deleteCase.auditLog,
        {
          timestamp: new Date().toISOString(),
          action: 'deleted',
          by: isClosed ? managerName : deleteCase.staff,
          note: isClosed ? 'Manager adjustment on closed day' : undefined,
        },
      ],
    });
    setDeleteCase(null);
    showToast('Entry removed.', 'info');
    await load(); // immediately update KPIs and list
    // If the day is already closed, rebuild the stored summary to exclude deleted entries
    if (isClosed) {
      await rebuildDaySummary(today);
      // regenerate PDF from fresh data
      const fresh = await getCasesByDate(today);
      if (fresh.length > 0) setPdfUri(generatePDF(today, fresh));
    }
  }

  async function handleOpenCloseDay() {
    if (!cases.length) { showToast('No cases logged today.', 'info'); return; }
    setCloseDaySummary(buildPreviewSummary(cases));
    setCloseDayOpen(true);
  }

  function buildPreviewSummary(allCases: Case[]) {
    const { sales: s, followups: f, lost: l, browsing: b, revenue: rev, convRate: conv, staffMap } =
      buildDailyStats(allCases);
    let topStaff = ''; let topKD = 0;
    for (const [name, data] of Object.entries(staffMap)) {
      if (data.kd > topKD) { topKD = data.kd; topStaff = name; }
    }
    return (
      `📊 Daily Report — ${format(new Date(today + 'T12:00:00'), 'd MMM yyyy')}\n` +
      `Revenue: ${formatKD(rev)} KD\n` +
      `Sales: ${s.length}  |  Follow-ups: ${f.length}  |  Lost: ${l.length}  |  Browsing: ${b.length}\n` +
      `Conversion: ${conv}%\n` +
      (topStaff ? `Top Performer: ${topStaff} — ${formatKD(topKD)} KD (${staffMap[topStaff].sales} sales)\n` : '')
    );
  }

  async function handleConfirmClose() {
    setClosingDay(true);
    try {
      const closer = closerName || settings?.staffRoster[0] || 'Manager';
      await closeDay(today, closer);
      showToast('Day closed. Report ready to share.', 'success');
      setCloseDayOpen(false);
      setCloseDaySummary(null);
    } finally {
      setClosingDay(false);
    }
  }

  const sortedCases = [...filteredCases].reverse();

  const outerClass = panelMode
    ? 'px-5 pt-5 pb-8'
    : 'px-4 pt-6 pb-32 max-w-lg mx-auto lg:max-w-3xl';

  return (
    <div className={outerClass}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h1 className={`font-bold text-slate-900 ${panelMode ? 'text-xl' : 'text-2xl'}`}>Today's Log</h1>
          <p className="text-slate-500 text-sm mt-0.5">{format(new Date(), 'EEEE, d MMMM yyyy')}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Outlet filter — admin only */}
          {role === 'admin' && settings?.outlets?.length && (
            <select
              value={outletFilter}
              onChange={e => setOutletFilter(e.target.value)}
              className="input text-sm py-1.5 pr-8 min-w-[130px]"
            >
              <option value="">All Outlets</option>
              {settings.outlets.map(o => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          )}
          {/* Active outlet badge — staff */}
          {role !== 'admin' && activeOutlet && (
            <span className="text-xs font-semibold px-2.5 py-1 bg-brand-50 text-brand-700 rounded-lg border border-brand-100">
              {activeOutlet}
            </span>
          )}
          <DayStatusBadge
            closed={isClosed}
            closedAt={dayClose ? format(new Date(dayClose.closedAt), 'HH:mm') : undefined}
          />
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-4 gap-2 mb-5 lg:grid-cols-6 lg:gap-3">
        {[
          { label: 'Sales', value: String(sales.length), color: 'text-emerald-700 bg-emerald-50' },
          { label: 'KD', value: formatKDCompact(revenue), color: 'text-emerald-700 bg-emerald-50' },
          { label: 'Follow-ups', value: String(followups.length), color: 'text-amber-700 bg-amber-50' },
          { label: 'Lost', value: String(lost.length), color: 'text-rose-700 bg-rose-50' },
          { label: 'Browsing', value: String(noInteraction.length), color: 'text-slate-600 bg-slate-100 hidden lg:block' },
          { label: 'Conv.', value: `${convRate}%`, color: 'text-brand-700 bg-brand-50 hidden lg:block' },
        ].map(({ label, value, color }) => (
          <div key={label} className={`${color} rounded-2xl p-3 text-center overflow-hidden`}>
            <div className={`font-bold leading-none truncate ${value.length > 6 ? 'text-xs' : value.length > 4 ? 'text-base' : 'text-lg'}`}>{value}</div>
            <div className="text-xs font-medium mt-1 opacity-80 leading-tight">{label}</div>
          </div>
        ))}
      </div>

      {/* Case list */}
      {sortedCases.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <FileText className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">No cases logged yet today.</p>
          <p className="text-sm">Use Quick Entry to log your first case.</p>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden lg:block card overflow-x-auto mb-6">
            <table className="w-full text-sm min-w-[900px]">
              <thead>
                <tr className="border-b border-slate-100">
                  {['Time', 'Type', 'Staff', 'Outlet', 'Brand', 'Prod. Type', 'Customer', 'Phone', 'KD', 'Reason / Action', 'FU Date', 'Status', ''].map(h => (
                    <th key={h} className="text-left py-3 px-3 text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedCases.map(c => {
                  const isNoInt = c.caseType === 'No Interaction';
                  const reasonAction = c.lostReason || c.followUpAction;
                  const canEdit = !isClosed || role === 'admin';
                  return (
                    <tr key={c.id} className="border-b border-slate-50 hover:bg-slate-25 group">
                      <td className="py-2.5 px-3 text-slate-400 font-mono text-xs whitespace-nowrap">{c.timeLogged}</td>
                      <td className="py-2.5 px-3"><CaseTypeBadge type={c.caseType} /></td>
                      <td className="py-2.5 px-3 font-medium text-slate-700 text-xs">{c.staff}</td>
                      <td className="py-2.5 px-3 text-xs">
                        {c.outlet
                          ? <span className="px-1.5 py-0.5 rounded-md bg-brand-50 text-brand-700 font-medium whitespace-nowrap">{c.outlet}</span>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="py-2.5 px-3 text-xs text-slate-800 max-w-[110px]">
                        {isNoInt ? <span className="text-slate-300">—</span> : (
                          <span className="font-medium truncate block">{c.brand || '—'}</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-xs text-slate-500">
                        {isNoInt ? <span className="text-slate-300">—</span> : (c.productType || '—')}
                      </td>
                      <td className="py-2.5 px-3 text-xs text-slate-600 max-w-[100px]">
                        <span className="truncate block">{c.customerName || <span className="text-slate-300">—</span>}</span>
                      </td>
                      <td className="py-2.5 px-3 text-xs text-slate-500 whitespace-nowrap">
                        {c.contact || <span className="text-slate-300">—</span>}
                      </td>
                      <td className="py-2.5 px-3 text-right text-xs font-semibold text-emerald-700 whitespace-nowrap">
                        {c.amountKD ? formatKD(c.amountKD) : <span className="text-slate-300 font-normal">—</span>}
                      </td>
                      <td className="py-2.5 px-3 text-xs text-slate-500 max-w-[110px]">
                        {reasonAction ? <span className="truncate block">{reasonAction}</span> : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="py-2.5 px-3 text-xs text-slate-500 whitespace-nowrap">
                        {c.promisedCallback
                          ? format(new Date(c.promisedCallback + 'T12:00:00'), 'd MMM')
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="py-2.5 px-3">
                        <StatusBadge status={c.status} />
                      </td>
                      <td className="py-2.5 px-3 w-14">
                        {canEdit ? (
                          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onClick={() => setEditCase(c)} className="p-1.5 rounded-lg text-slate-400 hover:text-brand-700 hover:bg-brand-50" title={isClosed ? 'Manager edit' : 'Edit'}>
                              {isClosed ? <ShieldAlert className="w-3.5 h-3.5 text-amber-500" /> : <Edit2 className="w-3.5 h-3.5" />}
                            </button>
                            <button onClick={() => setDeleteCase(c)} className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50" title={isClosed ? 'Manager delete' : 'Delete'}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <Lock className="w-3.5 h-3.5 text-slate-300 mx-auto" />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="lg:hidden space-y-3 mb-6">
            {sortedCases.map(c => (
              <CaseCard key={c.id} case_={c} locked={isClosed && role !== 'admin'} onEdit={() => setEditCase(c)} onDelete={() => setDeleteCase(c)} />
            ))}
          </div>
        </>
      )}

      {/* Close Day */}
      {!isClosed && cases.length > 0 && (
        <div className="mt-6">
          <div className="h-px bg-slate-200 mb-6" />
          <button onClick={handleOpenCloseDay}
            className="w-full flex items-center justify-center gap-3 bg-brand-700 text-white font-bold text-base py-5 rounded-2xl shadow-lg shadow-brand-700/20 active:scale-[0.98] transition-all duration-150">
            <Lock className="w-5 h-5" /> Close Day
          </button>
          <p className="text-center text-xs text-slate-400 mt-2">Locks today's entries — report will be ready to share</p>
        </div>
      )}

      {/* Share / Download report (shown after close) */}
      {isClosed && cases.length > 0 && (
        <div className="mt-6">
          <div className="h-px bg-slate-200 mb-4" />
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Daily Report</p>
          <div className={`flex gap-3 ${panelMode ? 'flex-col' : 'grid grid-cols-2'}`}>
            <button
              onClick={handleSharePdf}
              disabled={!pdfUri || sharingPdf}
              className="flex items-center justify-center gap-2 bg-brand-700 text-white font-semibold text-sm py-4 rounded-2xl shadow-md shadow-brand-700/10 active:scale-[0.98] transition-all disabled:opacity-40"
            >
              <Share2 className="w-4 h-4" />
              {sharingPdf ? 'Sharing…' : 'Share PDF'}
            </button>
            <button
              onClick={handleDownloadPdf}
              disabled={!pdfUri}
              className="flex items-center justify-center gap-2 border-2 border-brand-700 text-brand-700 font-semibold text-sm py-4 rounded-2xl active:scale-[0.98] transition-all disabled:opacity-40"
            >
              <FileText className="w-4 h-4" />
              Download PDF
            </button>
          </div>
        </div>
      )}

      {/* Edit modal */}
      {editCase && (
        <Modal
          open={!!editCase}
          onClose={() => setEditCase(null)}
          title={isClosed ? 'Manager Adjustment — Edit Entry' : 'Edit Entry'}
          size="lg"
        >
          <QuickEntryEdit
            case_={editCase}
            onDone={async () => {
              setEditCase(null);
              showToast('Updated.', 'success');
              // If editing on a closed day, rebuild the stored summary so Reports History stays accurate
              if (isClosed) {
                await rebuildDaySummary(today);
              }
            }}
            onCancel={() => setEditCase(null)}
          />
        </Modal>
      )}

      <ConfirmModal open={!!deleteCase} onClose={() => setDeleteCase(null)} onConfirm={handleDelete}
        title={isClosed ? 'Manager Adjustment — Remove Entry' : 'Remove Entry'}
        message={isClosed
          ? `Remove case ${deleteCase?.caseId} from a closed day? This will be logged as a manager adjustment and the daily report will be recalculated.`
          : `Remove case ${deleteCase?.caseId}? This action is logged.`}
        confirmLabel="Remove" danger />

      <Modal open={closeDayOpen} onClose={() => { if (!closingDay) setCloseDayOpen(false); }} title="Close Day" size="lg"
        footer={<>
          <button onClick={() => setCloseDayOpen(false)} className="btn-ghost" disabled={closingDay}>Cancel</button>
          <button onClick={handleConfirmClose} className="btn-primary" disabled={closingDay}>{closingDay ? 'Closing…' : 'Confirm & Close'}</button>
        </>}>
        <div className="space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm text-amber-800">
            <strong>Once closed, today's sales and lost entries can't be edited.</strong><br />
            Follow-ups will remain open on the tracker.
          </div>
          {closeDaySummary && (
            <div className="bg-slate-50 rounded-2xl p-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Report Preview</p>
              <pre className="text-sm text-slate-700 whitespace-pre-wrap font-mono leading-relaxed">{closeDaySummary}</pre>
            </div>
          )}
          <div>
            <label className="label">Closing staff name</label>
            <select value={closerName} onChange={e => setCloserName(e.target.value)} className="input">
              <option value="">— Select —</option>
              {settings?.staffRoster.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function StatusBadge({ status }: { status: CaseStatus }) {
  const styles: Record<CaseStatus, string> = {
    Open: 'bg-amber-100 text-amber-700',
    Won: 'bg-emerald-100 text-emerald-700',
    Lost: 'bg-rose-100 text-rose-700',
    'No Response': 'bg-slate-100 text-slate-500',
    Closed: 'bg-slate-100 text-slate-500',
  };
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap ${styles[status] ?? styles.Open}`}>
      {status}
    </span>
  );
}

function CaseCard({ case_: c, locked, onEdit, onDelete }: { case_: Case; locked: boolean; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <CaseTypeBadge type={c.caseType} />
            <span className="text-xs text-slate-400 font-mono">{c.caseId}</span>
            <span className="text-xs text-slate-400">{c.timeLogged}</span>
          </div>
          <p className="font-semibold text-slate-900 text-sm truncate">
            {c.caseType === 'No Interaction' ? <span className="text-slate-400 font-normal">No Interaction</span> : (c.brand || c.product)}
          </p>
          <div className="flex items-center gap-3 mt-0.5 text-xs text-slate-500 flex-wrap">
            {c.productType && <span className="text-slate-400">{c.productType}</span>}
            <span>{c.staff}</span>
            {c.customerName && <span>· {c.customerName}</span>}
            {c.amountKD && <span className="font-semibold text-emerald-700">{formatKD(c.amountKD)} KD</span>}
            {c.lostReason && <span className="text-rose-600">· {c.lostReason}</span>}
            {c.followUpAction && <span className="text-amber-700">· {c.followUpAction}</span>}
          </div>
        </div>
        {!locked && (
          <div className="flex gap-1 shrink-0">
            <button onClick={onEdit} className="p-2 rounded-xl text-slate-400 hover:text-brand-700 hover:bg-brand-50 transition-colors"><Edit2 className="w-4 h-4" /></button>
            <button onClick={onDelete} className="p-2 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"><Trash2 className="w-4 h-4" /></button>
          </div>
        )}
        {locked && <Lock className="w-4 h-4 text-slate-300 shrink-0 mt-1" />}
      </div>
    </div>
  );
}
