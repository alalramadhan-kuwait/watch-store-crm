import { useState, useEffect, useCallback } from 'react';
import { format, isToday, isBefore, differenceInDays, startOfDay } from 'date-fns';
import { Phone, MessageCircle, AlertCircle, Clock, CheckCircle, XCircle, UserX, ChevronDown, Filter } from 'lucide-react';
import { getOpenFollowUps, getSettings, updateCase, insertCase, nextCaseId } from '../db';
import { supabase } from '../lib/supabase';
import { useAppStore } from '../store';
import { Modal } from './shared/Modal';
import type { Case, AppSettings } from '../types';

function followUpUrgency(c: Case): 'overdue' | 'today' | 'upcoming' | 'stale' {
  if (!c.promisedCallback) return 'upcoming';
  const cb = new Date(c.promisedCallback + 'T00:00:00');
  const now = startOfDay(new Date());
  if (isBefore(cb, now)) return 'overdue';
  if (isToday(cb)) return 'today';
  const daysSince = c.lastContactDate
    ? differenceInDays(now, new Date(c.lastContactDate + 'T00:00:00'))
    : differenceInDays(now, new Date(c.dateLogged + 'T00:00:00'));
  if (daysSince > 7) return 'stale';
  return 'upcoming';
}

const urgencyOrder = { overdue: 0, stale: 1, today: 2, upcoming: 3 };

export function FollowUps() {
  const { showToast } = useAppStore();
  const [followUps, setFollowUps] = useState<Case[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [staffFilter, setStaffFilter] = useState('');
  const [actionCase, setActionCase] = useState<Case | null>(null);
  const [actionType, setActionType] = useState<'contacted' | 'won' | 'lost' | 'no_response' | null>(null);
  const [actionAmount, setActionAmount] = useState('');
  const [actionLostReason, setActionLostReason] = useState('');
  const [actionBumpDate, setActionBumpDate] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [fu, s] = await Promise.all([getOpenFollowUps(), getSettings()]);
    setFollowUps(fu);
    setSettings(s);
  }, []);

  useEffect(() => {
    load();
    const channel = supabase.channel('followups')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cases' }, load)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  const filtered = followUps
    .filter(c => !staffFilter || c.staff === staffFilter)
    .sort((a, b) => {
      const diff = urgencyOrder[followUpUrgency(a)] - urgencyOrder[followUpUrgency(b)];
      if (diff !== 0) return diff;
      return (a.promisedCallback || '').localeCompare(b.promisedCallback || '');
    });

  const overdue = filtered.filter(c => followUpUrgency(c) === 'overdue').length;
  const dueToday = filtered.filter(c => followUpUrgency(c) === 'today').length;

  function openAction(c: Case, type: typeof actionType) {
    setActionCase(c);
    setActionType(type);
    setActionAmount('');
    setActionLostReason('');
    setActionBumpDate(format(new Date(), 'yyyy-MM-dd'));
  }

  async function handleAction() {
    if (!actionCase?.id || !actionType) return;
    setSaving(true);
    try {
      const now = new Date();
      const nowStr = now.toISOString();
      const todayStr = format(now, 'yyyy-MM-dd');

      if (actionType === 'contacted') {
        await updateCase(actionCase.id, {
          lastContactDate: todayStr,
          promisedCallback: actionBumpDate || actionCase.promisedCallback,
          auditLog: [...actionCase.auditLog, { timestamp: nowStr, action: 'contacted', by: actionCase.staff }],
        });
        showToast('Marked as contacted.', 'success');
      }

      if (actionType === 'won') {
        const saleId = await nextCaseId(todayStr);
        await insertCase({
          caseId: saleId,
          dateLogged: todayStr,
          timeLogged: format(now, 'HH:mm'),
          staff: actionCase.staff,
          customerName: actionCase.customerName,
          contact: actionCase.contact,
          caseType: 'Sale',
          product: actionCase.product,
          amountKD: actionAmount ? Number(actionAmount) : undefined,
          status: 'Won',
          dayLocked: false,
          linkedCaseId: actionCase.caseId,
          auditLog: [{ timestamp: nowStr, action: 'converted', by: actionCase.staff, note: `From follow-up ${actionCase.caseId}` }],
        });
        await updateCase(actionCase.id, {
          status: 'Won',
          linkedCaseId: saleId,
          auditLog: [...actionCase.auditLog, { timestamp: nowStr, action: 'converted', by: actionCase.staff, note: 'Closed — Won' }],
        });
        showToast("Converted to sale! Entry added to today's log.", 'success');
      }

      if (actionType === 'lost') {
        await updateCase(actionCase.id, {
          status: 'Lost',
          lostReason: actionLostReason || undefined,
          auditLog: [...actionCase.auditLog, { timestamp: nowStr, action: 'status_changed', by: actionCase.staff, note: 'Closed — Lost' }],
        });
        showToast('Marked as lost.', 'info');
      }

      if (actionType === 'no_response') {
        await updateCase(actionCase.id, {
          status: 'No Response',
          auditLog: [...actionCase.auditLog, { timestamp: nowStr, action: 'status_changed', by: actionCase.staff, note: 'No Response' }],
        });
        showToast('Marked as no response.', 'info');
      }

      setActionCase(null);
      setActionType(null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-4 pt-6 pb-32 max-w-lg mx-auto lg:max-w-5xl lg:px-8">
      {/* Header row with filter on desktop */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Follow-ups</h1>
          <p className="text-slate-500 text-sm mt-0.5">Open cases across all dates</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {overdue > 0 && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-rose-100 text-rose-700 rounded-full text-xs font-semibold">
              <AlertCircle className="w-3 h-3" /> {overdue} Overdue
            </span>
          )}
          {dueToday > 0 && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-semibold">
              <Clock className="w-3 h-3" /> {dueToday} Due Today
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-slate-100 text-slate-600 rounded-full text-xs font-semibold">
            {filtered.length} Total Open
          </span>
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-slate-400 shrink-0" />
            <select value={staffFilter} onChange={e => setStaffFilter(e.target.value)} className="input py-2 text-sm">
              <option value="">All staff</option>
              {settings?.staffRoster.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <CheckCircle className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">No open follow-ups.</p>
          <p className="text-sm">All caught up!</p>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden lg:block card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  {['Status', 'Customer', 'Product', 'Staff', 'Action', 'Callback', 'Channel', ''].map(h => (
                    <th key={h} className="text-left py-3 px-4 text-xs font-semibold text-slate-400 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => <FollowUpTableRow key={c.id} case_={c} onAction={openAction} />)}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="lg:hidden space-y-3">
            {filtered.map(c => <FollowUpRow key={c.id} case_={c} onAction={openAction} />)}
          </div>
        </>
      )}

      <Modal
        open={!!actionCase && !!actionType}
        onClose={() => { setActionCase(null); setActionType(null); }}
        title={actionType === 'contacted' ? 'Mark Contacted' : actionType === 'won' ? 'Close — Won' : actionType === 'lost' ? 'Close — Lost' : 'No Response'}
        size="sm"
        footer={<>
          <button onClick={() => { setActionCase(null); setActionType(null); }} className="btn-ghost" disabled={saving}>Cancel</button>
          <button onClick={handleAction} className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Confirm'}</button>
        </>}
      >
        <div className="space-y-4">
          {actionCase && (
            <div className="bg-slate-50 rounded-xl p-3 text-sm">
              <p className="font-semibold text-slate-800">{actionCase.product}</p>
              <p className="text-slate-500">{actionCase.customerName} · {actionCase.staff}</p>
            </div>
          )}
          {actionType === 'contacted' && (
            <div>
              <label className="label">Bump callback to</label>
              <input type="date" value={actionBumpDate} onChange={e => setActionBumpDate(e.target.value)} className="input" />
              <p className="text-xs text-slate-400 mt-1">Leave as today if no new date promised.</p>
            </div>
          )}
          {actionType === 'won' && (
            <div>
              <label className="label">Sale Amount (KD)</label>
              <div className="relative">
                <input value={actionAmount} onChange={e => setActionAmount(e.target.value)} type="number" step="0.001" min="0" placeholder="0.000" className="input pr-12" />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">KD</span>
              </div>
            </div>
          )}
          {actionType === 'lost' && (
            <div>
              <label className="label">Lost Reason</label>
              <select value={actionLostReason} onChange={e => setActionLostReason(e.target.value)} className="input">
                <option value="">— Select —</option>
                {settings?.lostReasons.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          )}
          {actionType === 'no_response' && (
            <p className="text-slate-600 text-sm">Customer will be marked as "No Response" and removed from the active tracker.</p>
          )}
        </div>
      </Modal>
    </div>
  );
}

function FollowUpTableRow({ case_: c, onAction }: { case_: Case; onAction: (c: Case, type: 'contacted' | 'won' | 'lost' | 'no_response') => void }) {
  const urgency = followUpUrgency(c);
  const [menuOpen, setMenuOpen] = useState(false);
  const urgencyLabel = {
    overdue: { text: 'Overdue', class: 'text-rose-700 bg-rose-100' },
    today: { text: 'Due Today', class: 'text-amber-700 bg-amber-100' },
    upcoming: { text: c.promisedCallback ? format(new Date(c.promisedCallback + 'T12:00:00'), 'd MMM') : 'No date', class: 'text-slate-500 bg-slate-100' },
    stale: { text: 'Stale >7d', class: 'text-rose-700 bg-rose-100' },
  };
  const label = urgencyLabel[urgency];
  return (
    <tr className="border-b border-slate-50 hover:bg-slate-25 group">
      <td className="py-3 px-4">
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${label.class}`}>{label.text}</span>
      </td>
      <td className="py-3 px-4">
        <p className="font-medium text-slate-800 text-sm">{c.customerName || <span className="text-slate-400">—</span>}</p>
        {c.contact && <p className="text-xs text-slate-400">{c.contact}</p>}
      </td>
      <td className="py-3 px-4 max-w-[180px]">
        <p className="font-semibold text-slate-900 text-sm truncate">{c.product}</p>
        <p className="text-xs text-slate-400 font-mono">{c.caseId}</p>
      </td>
      <td className="py-3 px-4 text-sm font-medium text-brand-700">{c.staff}</td>
      <td className="py-3 px-4 text-sm text-slate-600">{c.followUpAction || '—'}</td>
      <td className="py-3 px-4 text-sm text-slate-600">{c.promisedCallback ? format(new Date(c.promisedCallback + 'T12:00:00'), 'd MMM yyyy') : '—'}</td>
      <td className="py-3 px-4 text-sm text-slate-500">
        {c.channel ? (
          <span className="flex items-center gap-1">
            {c.channel === 'WhatsApp' ? <MessageCircle className="w-3.5 h-3.5" /> : <Phone className="w-3.5 h-3.5" />}
            {c.channel}
          </span>
        ) : '—'}
      </td>
      <td className="py-3 px-4 w-28">
        <div className="relative">
          <button onClick={() => setMenuOpen(v => !v)}
            className="flex items-center gap-1 text-xs font-semibold text-brand-700 bg-brand-50 px-3 py-1.5 rounded-lg hover:bg-brand-100 transition-colors">
            Actions <ChevronDown className="w-3 h-3" />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-20 bg-white rounded-2xl shadow-xl border border-slate-100 py-2 min-w-[180px]">
                {([
                  { icon: <Phone className="w-4 h-4" />, label: 'Mark Contacted', color: 'text-slate-700', type: 'contacted' as const },
                  { icon: <CheckCircle className="w-4 h-4" />, label: 'Closed — Won', color: 'text-emerald-700', type: 'won' as const },
                  { icon: <XCircle className="w-4 h-4" />, label: 'Closed — Lost', color: 'text-rose-600', type: 'lost' as const },
                  { icon: <UserX className="w-4 h-4" />, label: 'No Response', color: 'text-slate-500', type: 'no_response' as const },
                ]).map(item => (
                  <button key={item.type} onClick={() => { setMenuOpen(false); onAction(c, item.type); }}
                    className={`w-full flex items-center gap-3 px-4 py-3 text-sm font-medium ${item.color} hover:bg-slate-50 transition-colors`}>
                    {item.icon} {item.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

function FollowUpRow({ case_: c, onAction }: { case_: Case; onAction: (c: Case, type: 'contacted' | 'won' | 'lost' | 'no_response') => void }) {
  const urgency = followUpUrgency(c);
  const [menuOpen, setMenuOpen] = useState(false);
  const urgencyStyles = { overdue: 'border-rose-200 bg-rose-50', today: 'border-amber-200 bg-amber-50', upcoming: 'border-slate-100 bg-white', stale: 'border-rose-200 bg-rose-50' };
  const urgencyLabel = {
    overdue: { text: 'Overdue', class: 'text-rose-600 bg-rose-100' },
    today: { text: 'Due today', class: 'text-amber-700 bg-amber-100' },
    upcoming: { text: c.promisedCallback ? format(new Date(c.promisedCallback + 'T12:00:00'), 'd MMM') : 'No date', class: 'text-slate-500 bg-slate-100' },
    stale: { text: 'Stale >7d', class: 'text-rose-600 bg-rose-100' },
  };
  const label = urgencyLabel[urgency];

  return (
    <div className={`rounded-2xl border-2 p-4 ${urgencyStyles[urgency]}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${label.class}`}>{label.text}</span>
            <span className="text-xs text-slate-400 font-mono">{c.caseId}</span>
          </div>
          <p className="font-semibold text-slate-900 text-sm">{c.product}</p>
          <div className="flex flex-col gap-0.5 mt-1.5 text-xs text-slate-500">
            <span>
              {c.customerName && <><strong>{c.customerName}</strong> · </>}
              {c.contact && <>{c.contact} · </>}
              <span className="text-brand-700 font-medium">{c.staff}</span>
            </span>
            {c.followUpAction && <span>Action: {c.followUpAction}</span>}
            {c.channel && <span className="flex items-center gap-1">{c.channel === 'WhatsApp' ? <MessageCircle className="w-3 h-3" /> : <Phone className="w-3 h-3" />}{c.channel}</span>}
            {c.lastContactDate && <span>Last contact: {format(new Date(c.lastContactDate + 'T12:00:00'), 'd MMM yyyy')}</span>}
          </div>
        </div>
        <div className="relative shrink-0">
          <button onClick={() => setMenuOpen(v => !v)}
            className="flex items-center gap-1 text-xs font-semibold text-brand-700 bg-brand-50 px-3 py-2 rounded-xl active:bg-brand-100 transition-colors">
            Actions <ChevronDown className="w-3 h-3" />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-20 bg-white rounded-2xl shadow-xl border border-slate-100 py-2 min-w-[180px]">
                {([
                  { icon: <Phone className="w-4 h-4" />, label: 'Mark Contacted', color: 'text-slate-700', type: 'contacted' as const },
                  { icon: <CheckCircle className="w-4 h-4" />, label: 'Closed — Won', color: 'text-emerald-700', type: 'won' as const },
                  { icon: <XCircle className="w-4 h-4" />, label: 'Closed — Lost', color: 'text-rose-600', type: 'lost' as const },
                  { icon: <UserX className="w-4 h-4" />, label: 'No Response', color: 'text-slate-500', type: 'no_response' as const },
                ]).map(item => (
                  <button key={item.type} onClick={() => { setMenuOpen(false); onAction(c, item.type); }}
                    className={`w-full flex items-center gap-3 px-4 py-3 text-sm font-medium ${item.color} hover:bg-slate-50 transition-colors`}>
                    {item.icon} {item.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
