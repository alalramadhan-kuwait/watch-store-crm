import { useState, useEffect, useMemo } from 'react';
import { format } from 'date-fns';
import {
  FileText, Share2, Download, Calendar, ChevronDown, ChevronUp,
  Clock, User, Loader2, ShieldAlert, Trash2, Store, Layers,
} from 'lucide-react';
import { getAllDayCloses, getCasesByDate, updateCase, rebuildDaySummary, getSettings, deleteFullDayReport } from '../db';
import { generatePDF, downloadReport, shareReport } from '../utils/report';
import { formatKD } from '../utils/formatKD';
import { useAppStore } from '../store';
import { useAuth } from '../context/AuthContext';
import { CaseTypeBadge } from './shared/Badge';
import { Modal, ConfirmModal } from './shared/Modal';
import { QuickEntryEdit } from './QuickEntryEdit';
import type { DayClose, Case } from '../types';

export function Reports() {
  const { showToast } = useAppStore();
  const [reports, setReports] = useState<DayClose[]>([]);
  const [loading, setLoading] = useState(true);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [outletFilter, setOutletFilter] = useState('');
  const [outlets, setOutlets] = useState<string[]>(['Avenues', 'TimeGallery']);
  const [generating, setGenerating] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deletingReport, setDeletingReport] = useState<DayClose | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);

  async function reload() {
    const r = await getAllDayCloses();
    setReports(r);
    setLoading(false);
  }

  useEffect(() => {
    reload();
    getSettings().then(s => { if (s.outlets?.length) setOutlets(s.outlets); });
  }, []);

  const filtered = useMemo(() => reports.filter(r => {
    if (fromDate && r.date < fromDate) return false;
    if (toDate && r.date > toDate) return false;
    if (outletFilter && r.outlet !== outletFilter) return false;
    return true;
  }), [reports, fromDate, toDate, outletFilter]);

  async function handleDownload(date: string, outlet: string) {
    if (generating) return;
    setGenerating(date);
    try {
      const allCases = await getCasesByDate(date);
      const filteredForPDF = outlet ? allCases.filter(c => !c.outlet || c.outlet === outlet) : allCases;
      const pdfUri = generatePDF(date, filteredForPDF, outlet || undefined);
      downloadReport(date, pdfUri, outlet || undefined);
    } catch {
      showToast('Failed to generate PDF.', 'error');
    } finally {
      setGenerating(null);
    }
  }

  async function handleDeleteReport() {
    if (!deletingReport) return;
    setDeletingAll(true);
    try {
      await deleteFullDayReport(deletingReport.date, deletingReport.outlet);
      setDeletingReport(null);
      setExpanded(null);
      await reload();
      showToast('Report deleted.', 'info');
    } catch {
      showToast('Failed to delete report.', 'error');
    } finally {
      setDeletingAll(false);
    }
  }

  async function handleShare(date: string, outlet: string) {
    if (generating) return;
    setGenerating(date);
    try {
      const allCases = await getCasesByDate(date);
      const filteredForPDF = outlet ? allCases.filter(c => !c.outlet || c.outlet === outlet) : allCases;
      const pdfUri = generatePDF(date, filteredForPDF, outlet || undefined);
      const result = await shareReport(date, pdfUri, outlet || undefined);
      showToast(result === 'shared' ? 'Report shared!' : 'PDF downloaded.', 'success');
    } catch {
      showToast('Failed to generate PDF.', 'error');
    } finally {
      setGenerating(null);
    }
  }

  return (
    <div className="px-4 pt-6 pb-32 max-w-lg mx-auto lg:max-w-none lg:px-8">
      {/* Header */}
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-slate-900">Reports History</h1>
        <p className="text-slate-500 text-sm mt-0.5">All closed daily reports — download or share any day</p>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <Calendar className="w-4 h-4 text-slate-400 shrink-0" />
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
            className="input py-1.5 text-sm flex-1" placeholder="From" />
          <span className="text-slate-400 text-sm">—</span>
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
            className="input py-1.5 text-sm flex-1" placeholder="To" />
        </div>
        <select value={outletFilter} onChange={e => setOutletFilter(e.target.value)}
          className="input py-1.5 text-sm min-w-[130px]">
          <option value="">All Outlets</option>
          {outlets.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
        {(fromDate || toDate || outletFilter) && (
          <button onClick={() => { setFromDate(''); setToDate(''); setOutletFilter(''); }}
            className="text-xs text-slate-400 hover:text-slate-600 font-medium">Clear</button>
        )}
      </div>

      {!loading && (
        <p className="text-xs text-slate-400 mb-4">
          {filtered.length} report{filtered.length !== 1 ? 's' : ''}
          {(fromDate || toDate) ? ' in range' : ' total'}
        </p>
      )}

      {loading && (
        <div className="flex items-center justify-center py-16 text-slate-400">
          <Loader2 className="w-6 h-6 animate-spin mr-2" />
          <span className="text-sm">Loading reports…</span>
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="text-center py-16 text-slate-400">
          <FileText className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">No reports yet.</p>
          <p className="text-sm">Close a day to generate your first report.</p>
        </div>
      )}

      <ConfirmModal
        open={!!deletingReport}
        onClose={() => setDeletingReport(null)}
        onConfirm={handleDeleteReport}
        title="Delete Entire Day Report"
        message={`Permanently delete the report for ${deletingReport ? format(new Date(deletingReport.date + 'T12:00:00'), 'd MMMM yyyy') : ''}? All entries for that day will be removed and the report will disappear from history. This cannot be undone.`}
        confirmLabel={deletingAll ? 'Deleting…' : 'Delete Report'}
        danger
      />

      {!loading && filtered.length > 0 && (
        <div className="space-y-3">
          {filtered.map(report => (
            <ReportCard
              key={report.id}
              report={report}
              generating={generating === report.date}
              expanded={expanded === report.date}
              onToggle={() => setExpanded(expanded === report.date ? null : report.date)}
              onDownload={() => handleDownload(report.date, report.outlet)}
              onShare={() => handleShare(report.date, report.outlet)}
              onDeleteReport={() => setDeletingReport(report)}
              onSummaryChanged={reload}
              outletFilter={outletFilter}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── ReportCard ────────────────────────────────────────────────────────────────

function ReportCard({
  report, generating, expanded, onToggle, onDownload, onShare, onDeleteReport, onSummaryChanged, outletFilter,
}: {
  report: DayClose;
  generating: boolean;
  expanded: boolean;
  onToggle: () => void;
  onDownload: () => void;
  onShare: () => void;
  onDeleteReport: () => void;
  onSummaryChanged: () => void;
  outletFilter: string;
}) {
  const displayDate = format(new Date(report.date + 'T12:00:00'), 'EEEE, d MMMM yyyy');
  const closedTime = format(new Date(report.closedAt), 'HH:mm');
  const isToday = report.date === format(new Date(), 'yyyy-MM-dd');

  const summaryLines = (report.reportSummary ?? '').split('\n').filter(Boolean);
  const revenueLine = summaryLines.find(l => l.includes('Total Sales:'));
  const visitorLine = summaryLines.find(l => l.includes('Total Visitors:'));

  return (
    <div className="card overflow-hidden">
      <div className="p-4">
        <div className="flex items-start gap-3">
          {/* Date block */}
          <div className="shrink-0 w-12 text-center">
            <div className="text-xs font-medium text-slate-400 uppercase leading-none">
              {format(new Date(report.date + 'T12:00:00'), 'MMM')}
            </div>
            <div className="text-2xl font-bold text-slate-900 leading-none mt-0.5">
              {format(new Date(report.date + 'T12:00:00'), 'd')}
            </div>
            <div className="text-xs text-slate-400 leading-none mt-0.5">
              {format(new Date(report.date + 'T12:00:00'), 'yyyy')}
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-slate-900 text-sm">{displayDate}</span>
              {isToday && <span className="text-[10px] font-semibold px-1.5 py-0.5 bg-brand-50 text-brand-700 rounded-md">Today</span>}
              {report.autoClosed && <span className="text-[10px] font-semibold px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded-md">Auto-closed</span>}
              <span className="flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded-md">
                <Store className="w-2.5 h-2.5" />
                {report.outlet || 'All Outlets'}
              </span>
            </div>
            <div className="flex items-center gap-3 mt-1 text-xs text-slate-400">
              <span className="flex items-center gap-1"><User className="w-3 h-3" /> {report.closedBy}</span>
              <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {closedTime}</span>
            </div>
            {revenueLine && (
              <p className="text-xs text-emerald-700 font-semibold mt-1.5">
                {revenueLine.replace('Total Sales:', '').trim()}
              </p>
            )}
            {visitorLine && (
              <p className="text-xs text-slate-500 mt-0.5">{visitorLine}</p>
            )}
          </div>

          {/* Expand toggle */}
          <button onClick={onToggle}
            className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-colors">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 mt-3">
          <button onClick={onShare} disabled={generating}
            className="flex-1 flex items-center justify-center gap-1.5 bg-brand-700 text-white text-xs font-semibold py-2.5 rounded-xl active:scale-[0.98] transition-all disabled:opacity-50">
            {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Share2 className="w-3.5 h-3.5" />}
            {generating ? 'Generating…' : 'Share PDF'}
          </button>
          <button onClick={onDownload} disabled={generating}
            className="flex-1 flex items-center justify-center gap-1.5 border-2 border-brand-700 text-brand-700 text-xs font-semibold py-2.5 rounded-xl active:scale-[0.98] transition-all disabled:opacity-50">
            {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            {generating ? 'Generating…' : 'Download PDF'}
          </button>
          <button onClick={onDeleteReport} disabled={generating}
            className="flex items-center justify-center p-2.5 border-2 border-rose-200 text-rose-400 rounded-xl active:scale-[0.98] transition-all hover:border-rose-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-50"
            title="Delete entire report">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Expanded: individual case list with manager controls */}
      {expanded && (
        <ExpandedDayView
          date={report.date}
          outlet={report.outlet}
          reportSummary={report.reportSummary}
          onSummaryChanged={onSummaryChanged}
          outletFilter={outletFilter}
        />
      )}
    </div>
  );
}

// ── ExpandedDayView ───────────────────────────────────────────────────────────

function ExpandedDayView({
  date, outlet, reportSummary, onSummaryChanged, outletFilter,
}: {
  date: string;
  outlet: string;
  reportSummary?: string;
  onSummaryChanged: () => void;
  outletFilter: string;
}) {
  const { showToast } = useAppStore();
  const { role, profile } = useAuth();
  const [cases, setCases] = useState<Case[]>([]);
  const [loadingCases, setLoadingCases] = useState(true);
  const [editCase, setEditCase] = useState<Case | null>(null);
  const [deleteCase, setDeleteCase] = useState<Case | null>(null);

  const isAdmin = role === 'admin';

  async function load() {
    setLoadingCases(true);
    const c = await getCasesByDate(date);
    setCases(c);
    setLoadingCases(false);
  }

  useEffect(() => { load(); }, [date]); // eslint-disable-line react-hooks/exhaustive-deps

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
          by: managerName,
          note: 'Manager adjustment on closed day',
        },
      ],
    });
    setDeleteCase(null);
    showToast('Entry removed.', 'info');
    await load();
    await rebuildDaySummary(date, outlet);
    onSummaryChanged();
  }

  return (
    <div className="border-t border-slate-100 bg-slate-50">
      {/* Manager notice */}
      {isAdmin && (
        <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-100">
          <ShieldAlert className="w-3.5 h-3.5 text-amber-500 shrink-0" />
          <p className="text-xs text-amber-700 font-medium">
            Manager view — edits and deletions will be logged as adjustments
          </p>
        </div>
      )}

      {/* Case table */}
      {loadingCases ? (
        <div className="flex items-center justify-center py-6 text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
          <span className="text-xs">Loading entries…</span>
        </div>
      ) : cases.length === 0 ? (
        <p className="text-xs text-slate-400 text-center py-6">No entries for this day.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[620px]">
            <thead>
              <tr className="border-b border-slate-200">
                {['Time', 'Type', 'Staff', 'Brand / Product', 'KD', 'Notes / Requirement', 'Status', isAdmin ? '' : null]
                  .filter(Boolean)
                  .map(h => (
                    <th key={h} className="text-left py-2 px-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">
                      {h}
                    </th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {[...cases].reverse().filter(c => !outletFilter || c.outlet === outletFilter).map(c => (
                <tr key={c.id} className="border-b border-slate-100 hover:bg-white group">
                  <td className="py-2 px-3 text-slate-400 font-mono whitespace-nowrap">{c.timeLogged}</td>
                  <td className="py-2 px-3"><CaseTypeBadge type={c.caseType} /></td>
                  <td className="py-2 px-3 text-slate-700 font-medium whitespace-nowrap">{c.staff}</td>
                  <td className="py-2 px-3 text-slate-600 max-w-[120px]">
                    {c.caseType === 'Sale' && c.saleItems && c.saleItems.length > 1 ? (
                      <span className="flex items-center gap-1 text-brand-700 font-medium">
                        <Layers className="w-3 h-3 shrink-0" />
                        {c.saleItems.length} items
                      </span>
                    ) : (
                      <>
                        <span className="truncate block">{c.brand || '—'}</span>
                        {c.caseType === 'Lost Sale' && c.product && c.product !== c.brand && (
                          <span className="text-slate-400 text-[10px] truncate block" title={c.product}>{c.product}</span>
                        )}
                      </>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right font-semibold text-emerald-700 whitespace-nowrap">
                    {c.amountKD ? formatKD(c.amountKD) : <span className="text-slate-300 font-normal">—</span>}
                  </td>
                  <td className="py-2 px-3 text-slate-500 max-w-[160px]">
                    {c.notes
                      ? <span className="truncate block" title={c.notes}>{c.notes}</span>
                      : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="py-2 px-3 text-slate-500 whitespace-nowrap">{c.status}</td>
                  {isAdmin && (
                    <td className="py-2 px-3 w-16">
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => setEditCase(c)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-amber-600 hover:bg-amber-50"
                          title="Manager edit">
                          <ShieldAlert className="w-3.5 h-3.5 text-amber-500" />
                        </button>
                        <button onClick={() => setDeleteCase(c)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                          title="Manager delete">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Raw summary text */}
      {reportSummary && (
        <div className="px-4 py-3 border-t border-slate-100">
          <pre className="text-xs text-slate-500 whitespace-pre-wrap font-mono leading-relaxed">{reportSummary}</pre>
        </div>
      )}

      {/* Edit modal */}
      {editCase && (
        <Modal open={!!editCase} onClose={() => setEditCase(null)}
          title="Manager Adjustment — Edit Entry" size="lg">
          <QuickEntryEdit
            case_={editCase}
            onDone={async () => {
              setEditCase(null);
              showToast('Updated.', 'success');
              await load();
              await rebuildDaySummary(date, outlet);
              onSummaryChanged();
            }}
            onCancel={() => setEditCase(null)}
          />
        </Modal>
      )}

      {/* Delete confirm modal */}
      <ConfirmModal
        open={!!deleteCase}
        onClose={() => setDeleteCase(null)}
        onConfirm={handleDelete}
        title="Manager Adjustment — Remove Entry"
        message={`Remove case ${deleteCase?.caseId} from a closed day? This will be logged as a manager adjustment and the daily report will be recalculated.`}
        confirmLabel="Remove"
        danger
      />
    </div>
  );
}
