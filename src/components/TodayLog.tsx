import { useState, useEffect, useCallback } from 'react';
import { format } from 'date-fns';
import { Edit2, Trash2, Lock, Share2, FileText } from 'lucide-react';
import { formatKD, formatKDCompact } from '../utils/formatKD';
import { getTodayCases, getDayClose, closeDay, getSettings, updateCase } from '../db';
import { generatePDF, shareReport } from '../utils/report';
import { useAppStore } from '../store';
import { supabase } from '../lib/supabase';
import { CaseTypeBadge, DayStatusBadge } from './shared/Badge';
import { Modal, ConfirmModal } from './shared/Modal';
import type { Case, AppSettings, DayClose } from '../types';
import { QuickEntryEdit } from './QuickEntryEdit';

const today = format(new Date(), 'yyyy-MM-dd');

export function TodayLog() {
  const { showToast } = useAppStore();
  const [cases, setCases] = useState<Case[]>([]);
  const [dayClose, setDayClose] = useState<DayClose | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  const [editCase, setEditCase] = useState<Case | null>(null);
  const [deleteCase, setDeleteCase] = useState<Case | null>(null);
  const [closeDayOpen, setCloseDayOpen] = useState(false);
  const [closeDayPreview, setCloseDayPreview] = useState<{ summary: string; pdfUri: string } | null>(null);
  const [closingDay, setClosingDay] = useState(false);
  const [closerName, setCloserName] = useState('');

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

  const isClosed = !!dayClose;
  const sales = cases.filter(c => c.caseType === 'Sale');
  const followups = cases.filter(c => c.caseType === 'Follow-up');
  const lost = cases.filter(c => c.caseType === 'Lost Sale');
  const revenue = sales.reduce((s, c) => s + (c.amountKD || 0), 0);
  const total = sales.length + lost.length;
  const convRate = total > 0 ? Math.round((sales.length / total) * 100) : 0;

  async function handleDelete() {
    if (!deleteCase?.id) return;
    await updateCase(deleteCase.id, {
      deleted: true,
      auditLog: [...deleteCase.auditLog, { timestamp: new Date().toISOString(), action: 'deleted', by: deleteCase.staff }],
    });
    setDeleteCase(null);
    showToast('Entry removed.', 'info');
  }

  async function handleOpenCloseDay() {
    if (!cases.length) { showToast('No cases logged today.', 'info'); return; }
    const summary = buildPreviewSummary(cases);
    const pdfUri = generatePDF(today, cases);
    setCloseDayPreview({ summary, pdfUri });
    setCloseDayOpen(true);
  }

  function buildPreviewSummary(cases: Case[]) {
    const s = cases.filter(c => c.caseType === 'Sale');
    const f = cases.filter(c => c.caseType === 'Follow-up');
    const l = cases.filter(c => c.caseType === 'Lost Sale');
    const rev = s.reduce((sum, c) => sum + (c.amountKD || 0), 0);
    const tot = s.length + l.length;
    const conv = tot > 0 ? Math.round((s.length / tot) * 100) : 0;
    const staffSales: Record<string, { count: number; kd: number }> = {};
    for (const c of s) {
      if (!staffSales[c.staff]) staffSales[c.staff] = { count: 0, kd: 0 };
      staffSales[c.staff].count++;
      staffSales[c.staff].kd += c.amountKD || 0;
    }
    let topStaff = ''; let topKD = 0;
    for (const [name, data] of Object.entries(staffSales)) {
      if (data.kd > topKD) { topKD = data.kd; topStaff = name; }
    }
    return (
      `📊 Daily Report — ${format(new Date(today + 'T12:00:00'), 'd MMM yyyy')}\n` +
      `Total Sales: ${formatKD(rev)} KD (${s.length} sale${s.length !== 1 ? 's' : ''})\n` +
      `Follow-ups: ${f.length} | Lost: ${l.length}\n` +
      `Conversion: ${conv}%\n` +
      (topStaff ? `Top: ${topStaff} — ${formatKD(topKD)} KD (${staffSales[topStaff].count} sales)\n` : '')
    );
  }

  async function handleConfirmClose() {
    setClosingDay(true);
    try {
      const closer = closerName || settings?.staffRoster[0] || 'Manager';
      const summary = await closeDay(today, closer);
      if (closeDayPreview) {
        const result = await shareReport(summary, closeDayPreview.pdfUri);
        showToast(result === 'shared' ? 'Report shared!' : 'Report copied to clipboard.', 'success');
      }
      setCloseDayOpen(false);
      setCloseDayPreview(null);
    } finally {
      setClosingDay(false);
    }
  }

  const sortedCases = [...cases].reverse();

  return (
    <div className="px-4 pt-6 pb-32 max-w-lg mx-auto lg:max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Today's Log</h1>
          <p className="text-slate-500 text-sm mt-0.5">{format(new Date(), 'EEEE, d MMMM yyyy')}</p>
        </div>
        <DayStatusBadge
          closed={isClosed}
          closedAt={dayClose ? format(new Date(dayClose.closedAt), 'HH:mm') : undefined}
        />
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-4 gap-2 mb-5 lg:grid-cols-5 lg:gap-3">
        {[
          { label: 'Sales', value: String(sales.length), color: 'text-emerald-700 bg-emerald-50' },
          { label: 'KD', value: formatKDCompact(revenue), color: 'text-emerald-700 bg-emerald-50' },
          { label: 'Follow-ups', value: String(followups.length), color: 'text-amber-700 bg-amber-50' },
          { label: 'Lost', value: String(lost.length), color: 'text-rose-700 bg-rose-50' },
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
          <div className="hidden lg:block card overflow-hidden mb-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  {['Time', 'Staff', 'Type', 'Product', 'Customer', 'KD', ''].map(h => (
                    <th key={h} className="text-left py-3 px-4 text-xs font-semibold text-slate-400 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedCases.map(c => (
                  <tr key={c.id} className="border-b border-slate-50 hover:bg-slate-25 group">
                    <td className="py-3 px-4 text-slate-400 font-mono text-xs">{c.timeLogged}</td>
                    <td className="py-3 px-4 font-medium text-slate-700">{c.staff}</td>
                    <td className="py-3 px-4"><CaseTypeBadge type={c.caseType} /></td>
                    <td className="py-3 px-4 text-slate-800 max-w-[180px] truncate">{c.product}</td>
                    <td className="py-3 px-4 text-slate-500">{c.customerName || '—'}</td>
                    <td className="py-3 px-4 text-right font-semibold text-emerald-700">{c.amountKD ? formatKD(c.amountKD) : '—'}</td>
                    <td className="py-3 px-4 w-16">
                      {!isClosed && (
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={() => setEditCase(c)} className="p-1.5 rounded-lg text-slate-400 hover:text-brand-700 hover:bg-brand-50"><Edit2 className="w-3.5 h-3.5" /></button>
                          <button onClick={() => setDeleteCase(c)} className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      )}
                      {isClosed && <Lock className="w-3.5 h-3.5 text-slate-300 mx-auto" />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="lg:hidden space-y-3 mb-6">
            {sortedCases.map(c => (
              <CaseCard key={c.id} case_={c} locked={isClosed} onEdit={() => setEditCase(c)} onDelete={() => setDeleteCase(c)} />
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
            <Lock className="w-5 h-5" /> Close Day & Share Report
          </button>
          <p className="text-center text-xs text-slate-400 mt-2">Locks today's entries and sends the daily report</p>
        </div>
      )}

      {/* Edit modal */}
      {editCase && (
        <Modal open={!!editCase} onClose={() => setEditCase(null)} title="Edit Entry" size="lg">
          <QuickEntryEdit case_={editCase} onDone={() => { setEditCase(null); showToast('Updated.', 'success'); }} onCancel={() => setEditCase(null)} />
        </Modal>
      )}

      <ConfirmModal open={!!deleteCase} onClose={() => setDeleteCase(null)} onConfirm={handleDelete}
        title="Remove Entry" message={`Remove case ${deleteCase?.caseId}? This action is logged.`} confirmLabel="Remove" danger />

      <Modal open={closeDayOpen} onClose={() => { if (!closingDay) setCloseDayOpen(false); }} title="Close Day & Share Report" size="lg"
        footer={<>
          <button onClick={() => setCloseDayOpen(false)} className="btn-ghost" disabled={closingDay}>Cancel</button>
          <button onClick={handleConfirmClose} className="btn-primary" disabled={closingDay}>{closingDay ? 'Closing…' : 'Confirm & Share'}</button>
        </>}>
        <div className="space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm text-amber-800">
            <strong>Once closed, today's sales and lost entries can't be edited.</strong><br />
            Follow-ups will remain open on the tracker.
          </div>
          {closeDayPreview && (
            <div className="bg-slate-50 rounded-2xl p-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Report Preview</p>
              <pre className="text-sm text-slate-700 whitespace-pre-wrap font-mono leading-relaxed">{closeDayPreview.summary}</pre>
            </div>
          )}
          <div>
            <label className="label">Closing staff name</label>
            <select value={closerName} onChange={e => setCloserName(e.target.value)} className="input">
              <option value="">— Select —</option>
              {settings?.staffRoster.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          {closeDayPreview && (
            <a href={closeDayPreview.pdfUri} download={`report-${today}.pdf`}
              className="flex items-center gap-2 text-sm text-brand-700 font-medium hover:underline">
              <FileText className="w-4 h-4" /> Download PDF
            </a>
          )}
        </div>
      </Modal>
    </div>
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
          <p className="font-semibold text-slate-900 text-sm truncate">{c.product}</p>
          <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
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
