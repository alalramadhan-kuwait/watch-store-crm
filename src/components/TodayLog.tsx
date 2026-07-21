import React, { useState, useEffect, useCallback } from 'react';
import { format } from 'date-fns';
import { Edit2, Trash2, Lock, Share2, FileText, ShieldAlert, ChevronDown, ChevronUp, Layers } from 'lucide-react';
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
  const { showToast, refreshLog, activeOutlet } = useAppStore();
  const { role, profile } = useAuth();
  const [cases, setCases] = useState<Case[]>([]);
  const [dayClose, setDayClose] = useState<DayClose | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  const [editCase, setEditCase] = useState<Case | null>(null);
  const [deleteCase, setDeleteCase] = useState<Case | null>(null);
  const [detailCase, setDetailCase] = useState<Case | null>(null);
  const [closeDayOpen, setCloseDayOpen] = useState(false);
  const [closeDaySummary, setCloseDaySummary] = useState<string | null>(null);
  const [closingDay, setClosingDay] = useState(false);
  const [closerName, setCloserName] = useState('');
  const [pdfUri, setPdfUri] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  // past-day report (staff can only get their own outlet; admin follows the outlet filter)
  const [pastDate, setPastDate] = useState(format(new Date(Date.now() - 86400000), 'yyyy-MM-dd'));
  const [pastBusy, setPastBusy] = useState(false);
  const [sharingPdf, setSharingPdf] = useState(false);

  const load = useCallback(async () => {
    const outlet = role === 'staff' ? (activeOutlet ?? '') : ''; // eslint-disable-line react-hooks/exhaustive-deps
    const [c, dc, s] = await Promise.all([getTodayCases(), getDayClose(today, outlet), getSettings()]);
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
  // Real browsing headcount (visitor_count sums groups logged in one entry)
  const browsingHeadcount = noInteraction.reduce((s, c) => s + (c.visitorCount ?? 1), 0);
  const total = sales.length + lost.length;
  const convRate = total > 0 ? Math.round((sales.length / total) * 100) : 0;

  // Outlet for PDF: staff always use their outlet; manager uses filter if set
  const pdfOutlet = role === 'staff' ? (activeOutlet ?? '') : outletFilter;
  // Cases for PDF: match what is shown on screen (already outlet-filtered)
  const pdfCases = filteredCases;

  // Signature that changes when any case is added, removed, or its amount/status/type changes
  const casesSig = pdfCases.map(c => `${c.id}:${c.amountKD}:${c.status}:${c.caseType}`).join('|');

  // Generate (or regenerate) the PDF whenever the day is closed AND case data changes
  useEffect(() => {
    if (isClosed && pdfCases.length > 0) {
      try {
        setPdfUri(generatePDF(today, pdfCases, pdfOutlet || undefined));
        setPdfError(null);
      } catch (err) {
        setPdfUri(null);
        setPdfError(err instanceof Error ? err.message : 'Could not build the PDF');
      }
    }
  }, [isClosed, casesSig, pdfOutlet]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Rebuild the PDF on demand (used by the retry button). */
  function buildPdfNow() {
    try {
      setPdfUri(generatePDF(today, pdfCases, pdfOutlet || undefined));
      setPdfError(null);
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'Could not build the PDF');
    }
  }

  async function handleSharePdf() {
    if (!pdfUri) return;
    setSharingPdf(true);
    try {
      const result = await shareReport(today, pdfUri, pdfOutlet || undefined);
      if (result === 'cancelled') return; // user dismissed the share sheet
      showToast(result === 'shared' ? 'Report shared!' : 'PDF downloaded.', 'success');
    } finally {
      setSharingPdf(false);
    }
  }

  function handleDownloadPdf() {
    if (!pdfUri) return;
    downloadReport(today, pdfUri, pdfOutlet || undefined);
  }

  /** Build and share/download the report for an earlier day, scoped to this user's outlet. */
  async function handlePastReport(mode: 'share' | 'download') {
    if (!pastDate || pastBusy) return;
    setPastBusy(true);
    try {
      const all = await getCasesByDate(pastDate);
      const scoped = pdfOutlet ? all.filter(c => !c.outlet || c.outlet === pdfOutlet) : all;
      if (scoped.length === 0) {
        showToast(`No entries for ${pastDate}${pdfOutlet ? ` at ${pdfOutlet}` : ''}.`, 'info');
        return;
      }
      const uri = generatePDF(pastDate, scoped, pdfOutlet || undefined);
      if (mode === 'download') {
        downloadReport(pastDate, uri, pdfOutlet || undefined);
        showToast('PDF downloaded.', 'success');
        return;
      }
      const result = await shareReport(pastDate, uri, pdfOutlet || undefined);
      if (result === 'cancelled') return;
      showToast(result === 'shared' ? 'Report shared!' : 'PDF downloaded.', 'success');
    } catch {
      showToast('Could not build that report.', 'error');
    } finally {
      setPastBusy(false);
    }
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
      await rebuildDaySummary(today, dayClose?.outlet ?? '');
      // regenerate PDF from fresh filtered data
      const fresh = await getCasesByDate(today);
      const freshFiltered = pdfOutlet ? fresh.filter(c => !c.outlet || c.outlet === pdfOutlet) : fresh;
      if (freshFiltered.length > 0) setPdfUri(generatePDF(today, freshFiltered, pdfOutlet || undefined));
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
      const outlet = role === 'staff' ? (activeOutlet ?? '') : '';
      await closeDay(today, closer, outlet);
      showToast('Day closed. Report ready to share.', 'success');
      setCloseDayOpen(false);
      setCloseDaySummary(null);
    } finally {
      setClosingDay(false);
    }
  }

  const sortedCases = [...filteredCases].reverse();
  const canEditHelper = (_c: Case) => !isClosed || role === 'admin';
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  function toggleExpand(id: string) {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const outerClass = panelMode
    ? 'px-5 pt-5 pb-8'
    : 'px-4 pt-6 pb-32 max-w-lg mx-auto lg:max-w-none lg:px-8';

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
          { label: 'Browsing', value: String(browsingHeadcount), color: 'text-slate-600 bg-slate-100 hidden lg:block' },
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
          <div className="hidden lg:block card mb-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  {['Time', 'Type', 'Staff', 'Brand / Product', 'Customer', 'KD', 'Action / Reason', 'Status', ''].map(h => (
                    <th key={h} className="text-left py-3 px-4 text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedCases.map(c => {
                  const isNoInt = c.caseType === 'No Interaction';
                  const isMultiItem = c.caseType === 'Sale' && c.saleItems && c.saleItems.length > 1;
                  const isExpanded = c.id ? expandedRows.has(c.id) : false;
                  const reasonAction = c.lostReason || c.followUpAction;
                  const canEdit = !isClosed || role === 'admin';
                  return (
                    <React.Fragment key={c.id}>
                      <tr className="border-b border-slate-50 hover:bg-slate-50 cursor-pointer group"
                        onClick={() => setDetailCase(c)}>
                        <td className="py-3 px-4 text-slate-400 font-mono text-xs whitespace-nowrap">{c.timeLogged}</td>
                        <td className="py-3 px-4"><CaseTypeBadge type={c.caseType} /></td>
                        <td className="py-3 px-4 font-medium text-slate-700 text-sm">{c.staff}</td>
                        <td className="py-3 px-4 text-sm text-slate-800 max-w-[180px]">
                          {isNoInt ? (
                            <span className="text-slate-400">—</span>
                          ) : isMultiItem ? (
                            <span className="flex items-center gap-1.5 text-brand-700 font-medium">
                              <Layers className="w-3.5 h-3.5 shrink-0" />
                              {c.saleItems!.length} items
                            </span>
                          ) : (
                            <>
                              <span className="font-semibold truncate block">{c.brand || '—'}</span>
                              <span className="text-xs text-slate-400">{c.productType || ''}</span>
                              {c.caseType === 'Lost Sale' && c.product && c.product !== c.brand && (
                                <span className="text-xs text-slate-400 truncate block">{c.product}</span>
                              )}
                            </>
                          )}
                        </td>
                        <td className="py-3 px-4 text-sm text-slate-600 max-w-[140px]">
                          <span className="truncate block">{c.customerName || <span className="text-slate-300">—</span>}</span>
                        </td>
                        <td className="py-3 px-4 text-right text-sm font-semibold text-emerald-700 whitespace-nowrap">
                          {c.amountKD ? formatKD(c.amountKD) : <span className="text-slate-300 font-normal">—</span>}
                        </td>
                        <td className="py-3 px-4 text-sm text-slate-500 max-w-[160px]">
                          {reasonAction
                            ? <span className="truncate block">{reasonAction}</span>
                            : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="py-3 px-4">
                          <StatusBadge status={c.status} />
                        </td>
                        <td className="py-3 px-4 w-16">
                          <div className="flex items-center gap-1">
                            {isMultiItem && (
                              <button onClick={e => { e.stopPropagation(); if (c.id) toggleExpand(c.id); }}
                                className="p-1.5 rounded-lg text-slate-400 hover:text-brand-700 hover:bg-brand-50">
                                {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                              </button>
                            )}
                            {canEdit ? (
                              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button onClick={e => { e.stopPropagation(); setEditCase(c); }} className="p-1.5 rounded-lg text-slate-400 hover:text-brand-700 hover:bg-brand-50" title={isClosed ? 'Manager edit' : 'Edit'}>
                                  {isClosed ? <ShieldAlert className="w-3.5 h-3.5 text-amber-500" /> : <Edit2 className="w-3.5 h-3.5" />}
                                </button>
                                <button onClick={e => { e.stopPropagation(); setDeleteCase(c); }} className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50" title={isClosed ? 'Manager delete' : 'Delete'}>
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ) : (
                              <Lock className="w-3.5 h-3.5 text-slate-300 mx-auto" />
                            )}
                          </div>
                        </td>
                      </tr>
                      {/* Expanded sale items sub-rows */}
                      {isMultiItem && isExpanded && c.saleItems!.map((item, idx) => (
                        <tr key={`${c.id}-item-${idx}`} className="bg-brand-50/40 border-b border-brand-50">
                          <td className="py-1.5 px-4 text-slate-300 text-xs">↳</td>
                          <td colSpan={2} />
                          <td className="py-1.5 px-4 text-xs">
                            <span className="font-medium text-slate-700">{item.brand || '—'}</span>
                            {item.productType && <span className="text-slate-400 ml-1.5">{item.productType}</span>}
                            {item.product && <span className="text-slate-400 italic ml-1.5">{item.product}</span>}
                          </td>
                          <td colSpan={2} />
                          <td className="py-1.5 px-4 text-right text-xs font-semibold text-emerald-700 whitespace-nowrap">
                            {formatKD(item.amountKD)}
                          </td>
                          <td colSpan={2} />
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="lg:hidden space-y-3 mb-6">
            {sortedCases.map(c => (
              <CaseCard key={c.id} case_={c} locked={isClosed && role !== 'admin'} onEdit={() => setEditCase(c)} onDelete={() => setDeleteCase(c)} onDetail={() => setDetailCase(c)} />
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
          {pdfError && (
            <div className="mb-3 px-3 py-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm flex items-center gap-2 flex-wrap">
              <span className="flex-1">Couldn’t build the PDF: {pdfError}</span>
              <button onClick={buildPdfNow} className="font-semibold underline shrink-0">Try again</button>
            </div>
          )}
          {!pdfUri && !pdfError && (
            <p className="mb-3 text-xs text-slate-400">Preparing the PDF…</p>
          )}
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

      {/* Report for an earlier day — available to staff too (scoped to their outlet) */}
      <div className="mt-6">
        <div className="h-px bg-slate-200 mb-4" />
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
          Earlier day report{pdfOutlet ? ` — ${pdfOutlet}` : ''}
        </p>
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-xs flex-1 min-w-[140px]">
            <span className="block text-slate-500 mb-1">Date</span>
            <input
              type="date"
              value={pastDate}
              max={today}
              onChange={e => setPastDate(e.target.value)}
              className="input py-1.5 text-sm w-full"
            />
          </label>
          <button
            onClick={() => handlePastReport('share')}
            disabled={pastBusy}
            className="flex items-center justify-center gap-1.5 bg-brand-700 text-white font-semibold text-sm px-4 py-2 rounded-xl disabled:opacity-40"
          >
            <Share2 className="w-4 h-4" /> {pastBusy ? 'Working…' : 'Share PDF'}
          </button>
          <button
            onClick={() => handlePastReport('download')}
            disabled={pastBusy}
            className="flex items-center justify-center gap-1.5 border-2 border-brand-700 text-brand-700 font-semibold text-sm px-4 py-2 rounded-xl disabled:opacity-40"
          >
            <FileText className="w-4 h-4" /> Download
          </button>
        </div>
        <p className="text-xs text-slate-400 mt-2">
          Pick any past date to get that day's report{pdfOutlet ? ` for ${pdfOutlet}` : ''} — works whether or not the day was closed.
        </p>
      </div>

      {/* Case detail modal */}
      {detailCase && (
        <CaseDetailModal
          case_={detailCase}
          onClose={() => setDetailCase(null)}
          onEdit={canEditHelper(detailCase) ? () => { setDetailCase(null); setEditCase(detailCase); } : undefined}
          onDelete={canEditHelper(detailCase) ? () => { setDetailCase(null); setDeleteCase(detailCase); } : undefined}
          isClosed={isClosed}
        />
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
                await rebuildDaySummary(today, dayClose?.outlet ?? '');
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

function CaseCard({ case_: c, locked, onEdit, onDelete, onDetail }: {
  case_: Case; locked: boolean; onEdit: () => void; onDelete: () => void; onDetail: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isMultiItem = c.caseType === 'Sale' && c.saleItems && c.saleItems.length > 1;

  return (
    <div className="card p-4 active:bg-slate-50 cursor-pointer" onClick={onDetail}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <CaseTypeBadge type={c.caseType} />
            <span className="text-xs text-slate-400 font-mono">{c.caseId}</span>
            <span className="text-xs text-slate-400">{c.timeLogged}</span>
          </div>
          {isMultiItem ? (
            <button
              type="button"
              onClick={e => { e.stopPropagation(); setExpanded(p => !p); }}
              className="flex items-center gap-1.5 font-semibold text-brand-700 text-sm"
            >
              <Layers className="w-3.5 h-3.5 shrink-0" />
              {c.saleItems!.length} items
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          ) : (
            <p className="font-semibold text-slate-900 text-sm truncate">
              {c.caseType === 'No Interaction' ? (
                <span className="text-slate-400 font-normal flex items-center gap-1.5">
                  No Interaction
                  {(c.visitorCount ?? 1) > 1 && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded-full">{c.visitorCount} visitors</span>
                  )}
                </span>
              ) : (c.brand || c.product)}
            </p>
          )}
          <div className="flex items-center gap-3 mt-0.5 text-xs text-slate-500 flex-wrap">
            {!isMultiItem && c.productType && <span className="text-slate-400">{c.productType}</span>}
            <span>{c.staff}</span>
            {c.customerName && <span>· {c.customerName}</span>}
            {c.amountKD && <span className="font-semibold text-emerald-700">{formatKD(c.amountKD)} KD</span>}
            {c.lostReason && <span className="text-rose-600">· {c.lostReason}</span>}
            {c.caseType === 'Lost Sale' && c.product && c.product !== c.brand && (
              <span className="text-slate-500">· {c.product}</span>
            )}
            {c.followUpAction && <span className="text-amber-700">· {c.followUpAction}</span>}
          </div>
          {c.caseType === 'Follow-up' && c.notes && (
            <p className="text-[11px] text-slate-500 italic mt-1 leading-snug">"{c.notes}"</p>
          )}
          {c.caseType === 'Lost Sale' && c.notes && (
            <p className="text-[11px] text-slate-400 italic mt-1 leading-snug">"{c.notes}"</p>
          )}

          {/* Expanded items list */}
          {isMultiItem && expanded && (
            <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
              {c.saleItems!.map((item, i) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="text-slate-600 font-medium">{item.brand || '—'} · {item.productType || '—'}{item.product ? ` · ${item.product}` : ''}</span>
                  <span className="text-emerald-700 font-semibold shrink-0 ml-2">{formatKD(item.amountKD)} KD</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {!locked && (
          <div className="flex gap-1 shrink-0">
            <button onClick={e => { e.stopPropagation(); onEdit(); }} className="p-2 rounded-xl text-slate-400 hover:text-brand-700 hover:bg-brand-50 transition-colors"><Edit2 className="w-4 h-4" /></button>
            <button onClick={e => { e.stopPropagation(); onDelete(); }} className="p-2 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"><Trash2 className="w-4 h-4" /></button>
          </div>
        )}
        {locked && <Lock className="w-4 h-4 text-slate-300 shrink-0 mt-1" />}
      </div>
    </div>
  );
}

function CaseDetailModal({ case_: c, onClose, onEdit, onDelete, isClosed }: {
  case_: Case;
  onClose: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  isClosed: boolean;
}) {
  const isFollowUp = c.caseType === 'Follow-up';
  const isLostSale = c.caseType === 'Lost Sale';
  const isSale = c.caseType === 'Sale';
  const isMultiItem = isSale && c.saleItems && c.saleItems.length > 1;

  return (
    <Modal
      open
      onClose={onClose}
      title=""
      size="lg"
      footer={
        <div className="flex items-center justify-between w-full">
          <button onClick={onClose} className="btn-ghost">Close</button>
          {(onEdit || onDelete) && (
            <div className="flex gap-2">
              {onDelete && (
                <button onClick={onDelete}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-rose-600 border border-rose-200 rounded-xl hover:bg-rose-50 transition-colors">
                  <Trash2 className="w-3.5 h-3.5" />
                  {isClosed ? 'Manager Delete' : 'Delete'}
                </button>
              )}
              {onEdit && (
                <button onClick={onEdit}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-brand-700 text-white rounded-xl hover:bg-brand-800 transition-colors">
                  {isClosed ? <ShieldAlert className="w-3.5 h-3.5" /> : <Edit2 className="w-3.5 h-3.5" />}
                  {isClosed ? 'Manager Edit' : 'Edit'}
                </button>
              )}
            </div>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3 flex-wrap">
          <CaseTypeBadge type={c.caseType} />
          <span className="font-mono text-sm font-semibold text-slate-700">{c.caseId}</span>
          <span className="text-sm text-slate-400">{format(new Date(c.dateLogged + 'T12:00:00'), 'd MMM yyyy')} · {c.timeLogged}</span>
          <StatusBadge status={c.status} />
        </div>

        {/* Staff & Outlet */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Staff</p>
            <p className="text-sm font-semibold text-slate-800">{c.staff}</p>
          </div>
          {c.outlet && (
            <div>
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Outlet</p>
              <p className="text-sm font-semibold text-brand-700">{c.outlet}</p>
            </div>
          )}
        </div>

        {/* Multi-item sale items */}
        {isMultiItem && (
          <div>
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Sale Items</p>
            <div className="space-y-1.5">
              {c.saleItems!.map((item, i) => (
                <div key={i} className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2">
                  <div className="text-sm">
                    <span className="font-semibold text-slate-800">{item.brand || '—'}</span>
                    {item.productType && <span className="text-slate-400 ml-1.5">· {item.productType}</span>}
                    {item.product && <span className="text-slate-500 ml-1.5 italic">{item.product}</span>}
                    {item.quantity > 1 && <span className="text-slate-400 ml-1.5">× {item.quantity}</span>}
                  </div>
                  <span className="text-sm font-bold text-emerald-700 shrink-0 ml-3">{formatKD(item.amountKD)} KD</span>
                </div>
              ))}
              <div className="flex justify-between px-3 py-2 bg-emerald-50 rounded-xl">
                <span className="text-sm font-semibold text-emerald-800">Total</span>
                <span className="text-sm font-bold text-emerald-700">{formatKD(c.amountKD ?? 0)} KD</span>
              </div>
            </div>
          </div>
        )}

        {/* Single-item brand/product info */}
        {!isMultiItem && c.caseType !== 'No Interaction' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Brand</p>
              <p className="text-sm font-semibold text-slate-800">{c.brand || '—'}</p>
            </div>
            {c.productType && (
              <div>
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Product Type</p>
                <p className="text-sm text-slate-700">{c.productType}</p>
              </div>
            )}
            {c.product && c.product !== c.brand && (
              <div className="col-span-2">
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">
                  {isSale ? 'Model / Reference' : 'Item Details'}
                </p>
                <p className="text-sm text-slate-700">{c.product}</p>
              </div>
            )}
            {c.amountKD != null && (
              <div>
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Amount</p>
                <p className="text-sm font-bold text-emerald-700">{formatKD(c.amountKD)} KD</p>
              </div>
            )}
          </div>
        )}

        {/* Lost Sale reason */}
        {isLostSale && c.lostReason && (
          <div>
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Lost Reason</p>
            <span className="inline-flex px-2.5 py-1 bg-rose-50 text-rose-700 rounded-xl text-sm font-semibold">{c.lostReason}</span>
          </div>
        )}

        {/* Follow-up specifics */}
        {isFollowUp && (
          <div className="grid grid-cols-2 gap-3">
            {c.followUpAction && (
              <div>
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Action</p>
                <span className="inline-flex px-2.5 py-1 bg-amber-50 text-amber-700 rounded-xl text-sm font-semibold">{c.followUpAction}</span>
              </div>
            )}
            {c.promisedCallback && (
              <div>
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Callback Date</p>
                <p className="text-sm font-semibold text-slate-800">{format(new Date(c.promisedCallback + 'T12:00:00'), 'd MMM yyyy')}</p>
              </div>
            )}
            {c.channel && (
              <div>
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Channel</p>
                <p className="text-sm text-slate-700">{c.channel}</p>
              </div>
            )}
            {c.lastContactDate && (
              <div>
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Last Contact</p>
                <p className="text-sm text-slate-700">{format(new Date(c.lastContactDate + 'T12:00:00'), 'd MMM yyyy')}</p>
              </div>
            )}
          </div>
        )}

        {/* Customer */}
        {(c.customerName || c.contact) && (
          <div className="grid grid-cols-2 gap-3">
            {c.customerName && (
              <div>
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Customer</p>
                <p className="text-sm font-semibold text-slate-800">{c.customerName}</p>
              </div>
            )}
            {c.contact && (
              <div>
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Contact</p>
                <p className="text-sm text-slate-700">{c.contact}</p>
              </div>
            )}
          </div>
        )}

        {/* Notes / Customer Requirement — prominent */}
        {c.notes && (
          <div className={`rounded-2xl p-4 ${isFollowUp ? 'bg-amber-50 border border-amber-100' : isLostSale ? 'bg-rose-50 border border-rose-100' : 'bg-slate-50'}`}>
            <p className={`text-[10px] font-semibold uppercase tracking-wide mb-1 ${isFollowUp ? 'text-amber-600' : isLostSale ? 'text-rose-600' : 'text-slate-400'}`}>
              {isFollowUp ? 'Customer Requirement' : isLostSale ? 'Details / What They Wanted' : 'Notes'}
            </p>
            <p className="text-sm text-slate-800 leading-relaxed">{c.notes}</p>
          </div>
        )}

        {/* Browsing tags */}
        {c.browsingTags && c.browsingTags.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Browsing Tags</p>
            <div className="flex flex-wrap gap-1.5">
              {c.browsingTags.map(tag => (
                <span key={tag} className="px-2.5 py-1 bg-slate-100 text-slate-600 rounded-xl text-xs font-medium">{tag}</span>
              ))}
            </div>
          </div>
        )}

        {/* Audit log */}
        {c.auditLog && c.auditLog.length > 0 && (
          <div className="border-t border-slate-100 pt-3">
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">History</p>
            <div className="space-y-1.5">
              {[...c.auditLog].reverse().map((entry, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-slate-500">
                  <span className="shrink-0 font-mono text-slate-300">
                    {format(new Date(entry.timestamp), 'd MMM HH:mm')}
                  </span>
                  <span>
                    <span className="font-semibold text-slate-600 capitalize">{entry.action}</span>
                    {' '}by {entry.by}
                    {entry.note && <span className="text-slate-400"> — {entry.note}</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
