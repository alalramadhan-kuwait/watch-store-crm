import { Fragment, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { format, isToday, isBefore, differenceInDays, startOfDay } from 'date-fns';
import { Phone, MessageCircle, CheckCircle, XCircle, UserX, ChevronDown, Filter, BarChart2, TrendingUp, Pencil, Plus, ShieldAlert} from 'lucide-react';
import { getOpenFollowUps, getSettings, updateCase, insertCase, nextCaseId, getBrands } from '../db';
import { supabase } from '../lib/supabase';
import { useAppStore } from '../store';
import { useAuth } from '../context/AuthContext';
import { Modal } from './shared/Modal';
import { QuickEntryEdit } from './QuickEntryEdit';
import type { Case, AppSettings, Brand, ProductType } from '../types';
import { PRODUCT_TYPES } from '../types';

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

/** What a row's Actions menu can start. 'edit' opens the editor, the rest confirm. */
type FollowUpAction = 'contacted' | 'won' | 'lost' | 'no_response' | 'edit';

export function FollowUps() {
  const { showToast, activeOutlet } = useAppStore();
  const { salesName, role } = useAuth(); // audit entries name who acted, not who owns the case
  /* Who may see the whole shop's pipeline. Owners and the store manager, and
     the one shared shop account that several salespeople work from — nobody
     else. This used to be decided by "does this login have a DSR name", which
     described the shared account only by accident: a personal login created
     without one matched it too, and two salespeople were handed the entire
     board that way. */
  const canSeeEveryone = role === 'admin' || role === 'manager' || role === 'staff';
  const [followUps, setFollowUps] = useState<Case[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [staffFilter, setStaffFilter] = useState('');
  const [brandFilter, setBrandFilter] = useState('');
  const [productTypeFilter, setProductTypeFilter] = useState('');
  const [urgencyFilter, setUrgencyFilter] = useState('');
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [actionCase, setActionCase] = useState<Case | null>(null);
  const [actionType, setActionType] = useState<'contacted' | 'won' | 'lost' | 'no_response' | null>(null);
  // Editing reuses Today's Log's editor, so a follow-up is corrected the same
  // way everywhere. It stays available after the day is closed: a follow-up
  // outlives the day it was logged on, and so must fixing a wrong number.
  const [editCase, setEditCase] = useState<Case | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [nf, setNf] = useState({
    staff: '', brand: '', productType: 'Watch' as ProductType, product: '',
    customerName: '', contact: '', followUpAction: '', channel: '',
    promisedCallback: '', notes: '', outlet: '',
  });
  const [nfErrors, setNfErrors] = useState<Record<string, string>>({});
  /** Set one field and drop its error: a filled field must never still read red. */
  function setField<K extends keyof typeof nf>(key: K, value: (typeof nf)[K]) {
    setNf(prev => ({ ...prev, [key]: value }));
    setNfErrors(prev => (prev[key as string] ? { ...prev, [key as string]: '' } : prev));
  }
  const [nfSaving, setNfSaving] = useState(false);
  const [actionAmount, setActionAmount] = useState('');
  const [actionLostReason, setActionLostReason] = useState('');
  const [actionBumpDate, setActionBumpDate] = useState('');
  const [actionClosedDate, setActionClosedDate] = useState('');
  const [groupByBrand, setGroupByBrand] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [fu, s, b] = await Promise.all([getOpenFollowUps(), getSettings(), getBrands()]);
    setFollowUps(fu);
    setSettings(s);
    setBrands(b);
  }, []);

  useEffect(() => {
    load();
    const channel = supabase.channel('followups')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cases' }, load)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  // A personal login sees only the customers they are chasing; a manager sees
  // the whole board. Matched on the roster name, not created_by, so follow-ups
  // logged under the shared account before they had their own login still
  // belong to them.
  const scoped = useMemo(
    () => (canSeeEveryone ? followUps : followUps.filter(c => c.staff === salesName)),
    [followUps, salesName, canSeeEveryone],
  );
  /* A salesperson whose DSR name was never set matches no case, so the board is
     empty. Say why: silence reads as "no follow-ups" and someone would work a
     day believing they had none. */
  const missingDsrName = !canSeeEveryone && !salesName;

  // Analytics computed from the scoped list (regardless of the other filters)
  const overdue = useMemo(() => scoped.filter(c => followUpUrgency(c) === 'overdue').length, [scoped]);
  const dueToday = useMemo(() => scoped.filter(c => followUpUrgency(c) === 'today').length, [scoped]);

  const brandCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of scoped) {
      const brand = c.brand || c.product || 'Unknown';
      counts[brand] = (counts[brand] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [scoped]);

  const productTypeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of scoped) {
      const type = c.productType || 'Watch';
      counts[type] = (counts[type] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [scoped]);

  const topBrand = brandCounts[0]?.[0] ?? '—';
  const topProductType = productTypeCounts[0]?.[0] ?? '—';
  const demandSignals = brandCounts.filter(([, n]) => n >= 2);

  const availableBrands = useMemo(
    () => [...new Set(scoped.map(c => c.brand || c.product).filter((v): v is string => !!v))].sort(),
    [scoped],
  );
  const availableProductTypes = useMemo(
    () => [...new Set(scoped.map(c => c.productType).filter(Boolean))].sort() as string[],
    [scoped],
  );

  const filtered = useMemo(() => scoped
    .filter(c => !staffFilter || c.staff === staffFilter)
    .filter(c => !brandFilter || c.brand === brandFilter || c.product === brandFilter)
    .filter(c => !productTypeFilter || c.productType === productTypeFilter)
    .filter(c => !urgencyFilter || followUpUrgency(c) === urgencyFilter)
    .sort((a, b) => {
      const diff = urgencyOrder[followUpUrgency(a)] - urgencyOrder[followUpUrgency(b)];
      if (diff !== 0) return diff;
      return (a.promisedCallback || '').localeCompare(b.promisedCallback || '');
    }),
    [scoped, staffFilter, brandFilter, productTypeFilter, urgencyFilter],
  );

  /** Follow-ups as [group, items] — one group when off, one per brand when grouping is on. */
  const groupedFollowUps = useMemo<[string, Case[]][]>(() => {
    if (!groupByBrand) return [['all', filtered]];
    const map = new Map<string, Case[]>();
    for (const c of filtered) {
      const brand = c.brand || c.product || 'No brand';
      if (!map.has(brand)) map.set(brand, []);
      map.get(brand)!.push(c);
    }
    // biggest demand first, so the brands customers are waiting on lead
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [filtered, groupByBrand]);

  function openNew() {
    setNf({
      // a personal login always files under its own roster name
      staff: salesName ?? '',
      brand: '', productType: 'Watch', product: '',
      customerName: '', contact: '', followUpAction: '', channel: '',
      // tomorrow, like Quick Entry — a callback promised for today is unusual
      promisedCallback: format(new Date(Date.now() + 86400000), 'yyyy-MM-dd'),
      notes: '',
      // an entry with no outlet is invisible to every per-outlet report, so it
      // is asked for whenever the session has not already pinned one
      outlet: activeOutlet ?? '',
    });
    setNfErrors({});
    setNewOpen(true);
  }

  async function saveNew() {
    // the same required fields Quick Entry enforces, so both doors produce
    // follow-ups the shop can actually act on
    const errs: Record<string, string> = {};
    if (!nf.staff) errs.staff = 'Required';
    if (!nf.outlet) errs.outlet = 'Required';
    if (!nf.brand) errs.brand = 'Select a brand';
    if (!nf.followUpAction) errs.followUpAction = 'Select an action';
    if (!nf.contact.trim()) errs.contact = 'Required for follow-ups';
    if (!nf.promisedCallback) errs.promisedCallback = 'Required';
    if (!nf.notes.trim()) errs.notes = 'Describe what the customer needs';
    setNfErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setNfSaving(true);
    try {
      const now = new Date();
      const dateStr = format(now, 'yyyy-MM-dd');
      await insertCase({
        caseId: await nextCaseId(dateStr),
        dateLogged: dateStr,
        timeLogged: format(now, 'HH:mm'),
        staff: nf.staff,
        outlet: nf.outlet,
        caseType: 'Follow-up',
        brand: nf.brand,
        productType: nf.productType,
        product: nf.product.trim() || nf.brand,
        customerName: nf.customerName.trim() || undefined,
        contact: nf.contact.trim(),
        followUpAction: nf.followUpAction,
        channel: nf.channel || undefined,
        promisedCallback: nf.promisedCallback,
        notes: nf.notes.trim(),
        status: 'Open',
        dayLocked: false,
        auditLog: [{ timestamp: now.toISOString(), action: 'created', by: salesName ?? nf.staff }],
      });
      setNewOpen(false);
      showToast('Follow-up added.', 'success');
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not add the follow-up.', 'error');
    } finally {
      setNfSaving(false);
    }
  }

  function openAction(c: Case, type: FollowUpAction) {
    if (type === 'edit') { setEditCase(c); return; }
    setActionCase(c);
    setActionType(type);
    setActionAmount('');
    setActionLostReason('');
    setActionBumpDate(format(new Date(), 'yyyy-MM-dd'));
    setActionClosedDate(format(new Date(), 'yyyy-MM-dd'));
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
          auditLog: [...actionCase.auditLog, { timestamp: nowStr, action: 'contacted', by: salesName ?? actionCase.staff }],
        });
        showToast('Marked as contacted.', 'success');
      }

      if (actionType === 'won') {
        // closed date lets old sales be recorded on the day they actually closed
        const closedStr = actionClosedDate || todayStr;
        const saleId = await nextCaseId(closedStr);
        await insertCase({
          caseId: saleId,
          dateLogged: closedStr,
          timeLogged: format(now, 'HH:mm'),
          staff: actionCase.staff,
          outlet: actionCase.outlet,
          customerName: actionCase.customerName,
          contact: actionCase.contact,
          caseType: 'Sale',
          product: actionCase.product,
          amountKD: actionAmount ? Number(actionAmount) : undefined,
          status: 'Won',
          dayLocked: false,
          linkedCaseId: actionCase.caseId,
          auditLog: [{ timestamp: nowStr, action: 'converted', by: salesName ?? actionCase.staff, note: `From follow-up ${actionCase.caseId}${(actionClosedDate && actionClosedDate !== todayStr) ? ` · closed ${actionClosedDate}` : ''}` }],
        });
        await updateCase(actionCase.id, {
          status: 'Won',
          linkedCaseId: saleId,
          lastContactDate: actionClosedDate || todayStr,
          auditLog: [...actionCase.auditLog, { timestamp: nowStr, action: 'converted', by: salesName ?? actionCase.staff, note: `Closed — Won on ${actionClosedDate || todayStr}` }],
        });
        showToast('Converted to sale. It counts on the follow-up, not in today\u2019s figures.', 'success');
      }

      if (actionType === 'lost') {
        await updateCase(actionCase.id, {
          status: 'Lost',
          lostReason: actionLostReason || undefined,
          lastContactDate: actionClosedDate || todayStr,
          auditLog: [...actionCase.auditLog, { timestamp: nowStr, action: 'status_changed', by: salesName ?? actionCase.staff, note: `Closed — Lost on ${actionClosedDate || todayStr}` }],
        });
        showToast('Marked as lost.', 'info');
      }

      if (actionType === 'no_response') {
        await updateCase(actionCase.id, {
          status: 'No Response',
          auditLog: [...actionCase.auditLog, { timestamp: nowStr, action: 'status_changed', by: salesName ?? actionCase.staff, note: 'No Response' }],
        });
        showToast('Marked as no response.', 'info');
      }

      setActionCase(null);
      setActionType(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not update the follow-up.', 'error');
      load(); // immediate UI refresh
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-4 pt-6 pb-32 max-w-lg mx-auto lg:max-w-none lg:px-8">
      {/* Title */}
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-900">Follow-ups</h1>
          <p className="text-slate-500 text-sm mt-0.5">Open cases across all dates</p>
        </div>
        <button
          onClick={openNew}
          className="shrink-0 flex items-center gap-1.5 bg-brand-700 text-white text-sm font-semibold px-3.5 py-2 rounded-xl active:bg-brand-800 hover:bg-brand-800 transition-colors touch-manipulation"
        >
          <Plus className="w-4 h-4" /> New
        </button>
      </div>

      {/* KPI tiles */}
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4 lg:mx-0 lg:px-0 mb-4 scrollbar-none">
        {[
          { label: 'Total Open', value: String(scoped.length), color: 'bg-slate-100 text-slate-700' },
          { label: 'Overdue', value: String(overdue), color: overdue > 0 ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-400' },
          { label: 'Due Today', value: String(dueToday), color: dueToday > 0 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-400' },
          { label: 'Top Brand', value: topBrand, color: 'bg-brand-50 text-brand-700' },
          { label: 'Top Type', value: topProductType, color: 'bg-indigo-50 text-indigo-700' },
        ].map(({ label, value, color }) => (
          <div key={label} className={`${color} rounded-2xl px-4 py-3 text-center shrink-0 min-w-[88px] max-w-[130px]`}>
            <div className="font-bold text-sm leading-none truncate">{value}</div>
            <div className="text-[11px] font-medium mt-1 opacity-70 leading-tight">{label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        {canSeeEveryone && (
          <div className="flex items-center gap-2 flex-1 min-w-[130px]">
            <Filter className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <select value={staffFilter} onChange={e => setStaffFilter(e.target.value)} className="input py-1.5 text-sm flex-1 min-w-0">
              <option value="">All staff</option>
              {settings?.staffRoster.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
        {availableBrands.length > 0 && (
          <select value={brandFilter} onChange={e => setBrandFilter(e.target.value)} className="input py-1.5 text-sm flex-1 min-w-[110px]">
            <option value="">All brands</option>
            {availableBrands.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        )}
        {availableProductTypes.length > 0 && (
          <select value={productTypeFilter} onChange={e => setProductTypeFilter(e.target.value)} className="input py-1.5 text-sm flex-1 min-w-[110px]">
            <option value="">All types</option>
            {availableProductTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        <select value={urgencyFilter} onChange={e => setUrgencyFilter(e.target.value)} className="input py-1.5 text-sm flex-1 min-w-[110px]">
          <option value="">All status</option>
          <option value="overdue">Overdue</option>
          <option value="today">Due today</option>
          <option value="stale">Stale</option>
          <option value="upcoming">Upcoming</option>
        </select>
        {scoped.length > 0 && (
          <button
            onClick={() => setShowAnalytics(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors ${showAnalytics ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
          >
            <BarChart2 className="w-3.5 h-3.5" /> Analytics
          </button>
        )}
        {scoped.length > 0 && (
          <button
            onClick={() => setGroupByBrand(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors ${groupByBrand ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
          >
            Group by brand
          </button>
        )}
      </div>

      {/* Analytics panel */}
      {showAnalytics && (
        <div className="card p-4 mb-5 space-y-5">
          {brandCounts.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">By Brand</p>
              <div className="space-y-1">
                {brandCounts.slice(0, 10).map(([brand, count]) => (
                  <AnalyticsBar
                    key={brand}
                    label={brand}
                    count={count}
                    max={brandCounts[0][1]}
                    color="bg-brand-600"
                    onClick={() => setBrandFilter(brandFilter === brand ? '' : brand)}
                    active={brandFilter === brand}
                  />
                ))}
              </div>
            </div>
          )}

          {productTypeCounts.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">By Product Type</p>
              <div className="space-y-1">
                {productTypeCounts.map(([type, count]) => (
                  <AnalyticsBar
                    key={type}
                    label={type}
                    count={count}
                    max={productTypeCounts[0][1]}
                    color="bg-indigo-500"
                    onClick={() => setProductTypeFilter(productTypeFilter === type ? '' : type)}
                    active={productTypeFilter === type}
                  />
                ))}
              </div>
            </div>
          )}

          {demandSignals.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3 flex items-center gap-1.5">
                <TrendingUp className="w-3 h-3" /> Demand Signals
              </p>
              <div className="space-y-2">
                {demandSignals.map(([brand, count]) => (
                  <div key={brand} className="flex items-center gap-2 bg-rose-50 rounded-xl px-3 py-2.5">
                    <span className="font-semibold text-slate-800 text-sm truncate flex-1">{brand}</span>
                    <span className="text-rose-600 font-bold text-sm shrink-0">{count}×</span>
                    <span className="text-slate-400 text-xs shrink-0">open — unmet demand</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* List */}
      {missingDsrName ? (
        <div className="text-center py-16 px-6 text-slate-500">
          <ShieldAlert className="w-12 h-12 mx-auto mb-3 text-amber-400" />
          <p className="font-medium text-slate-700">Your DSR name isn&rsquo;t set yet.</p>
          <p className="text-sm mt-1 max-w-xs mx-auto">
            Until it is, this account can&rsquo;t be matched to your follow-ups. Ask an
            owner to set it on your account under Settings &rarr; Team Access.
          </p>
        </div>
      ) : filtered.length === 0 ? (
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
                  {['Status', 'Customer', 'Product', 'Staff', 'Action', 'Callback', 'Channel', 'Requirement', ''].map(h => (
                    <th key={h} className="text-left py-3 px-4 text-xs font-semibold text-slate-400 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groupedFollowUps.map(([brand, items]) => (
                  <Fragment key={brand}>
                    {groupByBrand && (
                      <tr className="bg-slate-50 border-b border-slate-200">
                        <td colSpan={9} className="py-1.5 px-4 text-xs font-bold text-slate-600 uppercase tracking-wide">
                          {brand}<span className="ml-2 font-normal text-slate-400 normal-case">{items.length} open</span>
                        </td>
                      </tr>
                    )}
                    {items.map(c => <FollowUpTableRow key={c.id} case_={c} onAction={openAction} />)}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="lg:hidden space-y-3">
            {groupedFollowUps.map(([brand, items]) => (
              <div key={brand} className="space-y-3">
                {groupByBrand && (
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wide pt-2">
                    {brand} <span className="font-normal text-slate-400 normal-case">({items.length})</span>
                  </p>
                )}
                {items.map(c => <FollowUpRow key={c.id} case_={c} onAction={openAction} />)}
              </div>
            ))}
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
            <div className="bg-slate-50 rounded-xl p-3 text-sm space-y-0.5">
              <p className="font-semibold text-slate-800">{actionCase.product}</p>
              <p className="text-slate-500">{actionCase.customerName} · {actionCase.staff}</p>
              {actionCase.notes && (
                <p className="text-slate-600 italic text-xs leading-snug">"{actionCase.notes}"</p>
              )}
            </div>
          )}
          {actionType === 'contacted' && (
            <div>
              <label className="label">Bump callback to</label>
              <input type="date" value={actionBumpDate} onChange={e => setActionBumpDate(e.target.value)} className="input" />
              <p className="text-xs text-slate-400 mt-1">Leave as today if no new date promised.</p>
            </div>
          )}
          {(actionType === 'won' || actionType === 'lost') && (
            <div>
              <label className="label">Closed date</label>
              <input type="date" value={actionClosedDate} max={format(new Date(), 'yyyy-MM-dd')}
                onChange={e => setActionClosedDate(e.target.value)} className="input" />
              <p className="text-xs text-slate-400 mt-1">Defaults to today — pick an earlier date for a sale that closed before it was updated here.</p>
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

      {/* Edit details — the same editor Today's Log uses, so one case is
          corrected the same way wherever it is opened from. */}
      <Modal
        open={!!editCase}
        onClose={() => setEditCase(null)}
        title="Edit Follow-up"
        size="lg"
      >
        {editCase && (
          <QuickEntryEdit
            case_={editCase}
            onDone={() => { setEditCase(null); showToast('Follow-up updated.', 'success'); load(); }}
            onCancel={() => setEditCase(null)}
          />
        )}
      </Modal>

      {/* New follow-up — the same required fields Quick Entry asks for */}
      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="New Follow-up"
        size="lg"
        footer={
          <>
            <button onClick={() => setNewOpen(false)} className="btn-ghost" disabled={nfSaving}>Cancel</button>
            <button onClick={saveNew} className="btn-primary" disabled={nfSaving}>{nfSaving ? 'Saving…' : 'Add Follow-up'}</button>
          </>
        }
      >
        <div className="space-y-4">
          {canSeeEveryone && (
            <div>
              <label className="label">Staff</label>
              <select value={nf.staff} onChange={e => setField('staff', e.target.value)} className="input">
                <option value="">— Select —</option>
                {settings?.staffRoster.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              {nfErrors.staff && <p className="text-xs text-rose-600 mt-1">{nfErrors.staff}</p>}
            </div>
          )}
          {!activeOutlet && (
            <div>
              <label className="label">Outlet</label>
              <select value={nf.outlet} onChange={e => setField('outlet', e.target.value)} className="input">
                <option value="">— Select —</option>
                {settings?.outlets.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
              {nfErrors.outlet && <p className="text-xs text-rose-600 mt-1">{nfErrors.outlet}</p>}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Brand</label>
              <select value={nf.brand} onChange={e => setField('brand', e.target.value)} className="input">
                <option value="">— Select —</option>
                {brands.filter(b => b.is_active).map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
              </select>
              {nfErrors.brand && <p className="text-xs text-rose-600 mt-1">{nfErrors.brand}</p>}
            </div>
            <div>
              <label className="label">Type</label>
              <select value={nf.productType} onChange={e => setField('productType', e.target.value as ProductType)} className="input">
                {PRODUCT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="label">Model / reference <span className="text-slate-400 font-normal">(optional)</span></label>
            <input value={nf.product} onChange={e => setField('product', e.target.value)} className="input" placeholder="e.g. Submariner 41mm" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Customer <span className="text-slate-400 font-normal">(optional)</span></label>
              <input value={nf.customerName} onChange={e => setField('customerName', e.target.value)} className="input" />
            </div>
            <div>
              <label className="label">Contact</label>
              <input value={nf.contact} onChange={e => setField('contact', e.target.value)} className="input" inputMode="tel" placeholder="Phone" />
              {nfErrors.contact && <p className="text-xs text-rose-600 mt-1">{nfErrors.contact}</p>}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Action</label>
              <select value={nf.followUpAction} onChange={e => setField('followUpAction', e.target.value)} className="input">
                <option value="">— Select —</option>
                {settings?.followUpActions.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              {nfErrors.followUpAction && <p className="text-xs text-rose-600 mt-1">{nfErrors.followUpAction}</p>}
            </div>
            <div>
              <label className="label">Channel <span className="text-slate-400 font-normal">(optional)</span></label>
              <select value={nf.channel} onChange={e => setField('channel', e.target.value)} className="input">
                <option value="">— Select —</option>
                {settings?.channels.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="label">Call back on</label>
            <input type="date" value={nf.promisedCallback} onChange={e => setField('promisedCallback', e.target.value)} className="input" />
            {nfErrors.promisedCallback && <p className="text-xs text-rose-600 mt-1">{nfErrors.promisedCallback}</p>}
          </div>

          <div>
            <label className="label">What the customer needs</label>
            <textarea value={nf.notes} onChange={e => setField('notes', e.target.value)} rows={3} className="input resize-none" placeholder="Wants it in rose gold, will decide after the weekend…" />
            {nfErrors.notes && <p className="text-xs text-rose-600 mt-1">{nfErrors.notes}</p>}
          </div>
        </div>
      </Modal>
    </div>
  );
}

function AnalyticsBar({ label, count, max, color, onClick, active }: {
  label: string; count: number; max: number; color: string;
  onClick?: () => void; active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-3 rounded-xl px-2 py-1.5 transition-colors text-left ${onClick ? 'hover:bg-slate-50' : 'cursor-default'} ${active ? 'bg-brand-50' : ''}`}
    >
      <span className="text-sm text-slate-700 w-32 truncate shrink-0">{label}</span>
      <div className="flex-1 bg-slate-100 rounded-full h-1.5">
        <div
          className={`${color} h-1.5 rounded-full transition-all duration-300`}
          style={{ width: `${Math.max(4, (count / max) * 100)}%` }}
        />
      </div>
      <span className="text-xs font-semibold text-slate-500 w-4 text-right shrink-0">{count}</span>
    </button>
  );
}

function FollowUpTableRow({ case_: c, onAction }: { case_: Case; onAction: (c: Case, type: FollowUpAction) => void }) {
  const urgency = followUpUrgency(c);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);

  const urgencyLabel = {
    overdue: { text: 'Overdue', class: 'text-rose-700 bg-rose-100' },
    today: { text: 'Due Today', class: 'text-amber-700 bg-amber-100' },
    upcoming: { text: c.promisedCallback ? format(new Date(c.promisedCallback + 'T12:00:00'), 'd MMM') : 'No date', class: 'text-slate-500 bg-slate-100' },
    stale: { text: 'Stale >7d', class: 'text-rose-700 bg-rose-100' },
  };
  const label = urgencyLabel[urgency];

  function openMenu() {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setMenuOpen(true);
  }

  const actions = [
    { icon: <Phone className="w-4 h-4" />, label: 'Mark Contacted', color: 'text-slate-700', type: 'contacted' as const },
    { icon: <CheckCircle className="w-4 h-4" />, label: 'Closed — Won', color: 'text-emerald-700', type: 'won' as const },
    { icon: <XCircle className="w-4 h-4" />, label: 'Closed — Lost', color: 'text-rose-600', type: 'lost' as const },
    { icon: <UserX className="w-4 h-4" />, label: 'No Response', color: 'text-slate-500', type: 'no_response' as const },
    { icon: <Pencil className="w-4 h-4" />, label: 'Edit Details', color: 'text-slate-600', type: 'edit' as const },
  ];

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
        <p className="font-semibold text-slate-900 text-sm truncate" title={c.product}>{c.product}</p>
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
      <td className="py-3 px-4 text-sm text-slate-600 max-w-[280px]">
        {c.notes
          ? <span className="break-words leading-snug">{c.notes}</span>
          : <span className="text-slate-300">—</span>}
      </td>
      <td className="py-3 px-4 w-28">
        <button ref={btnRef} onClick={openMenu}
          className="flex items-center gap-1 text-xs font-semibold text-brand-700 bg-brand-50 px-3 py-1.5 rounded-lg hover:bg-brand-100 transition-colors">
          Actions <ChevronDown className="w-3 h-3" />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div
              className="fixed z-50 bg-white rounded-2xl shadow-xl border border-slate-100 py-2 min-w-[180px]"
              style={{ top: menuPos.top, right: menuPos.right }}
            >
              {actions.map(item => (
                <button key={item.type} onClick={() => { setMenuOpen(false); onAction(c, item.type); }}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-sm font-medium ${item.color} hover:bg-slate-50 transition-colors`}>
                  {item.icon} {item.label}
                </button>
              ))}
            </div>
          </>
        )}
      </td>
    </tr>
  );
}

function FollowUpRow({ case_: c, onAction }: { case_: Case; onAction: (c: Case, type: FollowUpAction) => void }) {
  const urgency = followUpUrgency(c);
  const [sheetOpen, setSheetOpen] = useState(false);
  const urgencyStyles = { overdue: 'border-rose-200 bg-rose-50', today: 'border-amber-200 bg-amber-50', upcoming: 'border-slate-100 bg-white', stale: 'border-rose-200 bg-rose-50' };
  const urgencyLabel = {
    overdue: { text: 'Overdue', class: 'text-rose-600 bg-rose-100' },
    today: { text: 'Due today', class: 'text-amber-700 bg-amber-100' },
    upcoming: { text: c.promisedCallback ? format(new Date(c.promisedCallback + 'T12:00:00'), 'd MMM') : 'No date', class: 'text-slate-500 bg-slate-100' },
    stale: { text: 'Stale >7d', class: 'text-rose-600 bg-rose-100' },
  };
  const label = urgencyLabel[urgency];

  const sheetActions = [
    { icon: <Phone className="w-5 h-5" />, label: 'Mark Contacted', color: 'text-slate-800', type: 'contacted' as const },
    { icon: <Pencil className="w-5 h-5" />, label: 'Edit Details', color: 'text-slate-800', type: 'edit' as const },
    { icon: <CheckCircle className="w-5 h-5" />, label: 'Closed — Won', color: 'text-emerald-700', type: 'won' as const },
    { icon: <XCircle className="w-5 h-5" />, label: 'Closed — Lost', color: 'text-rose-600', type: 'lost' as const },
    { icon: <UserX className="w-5 h-5" />, label: 'No Response', color: 'text-slate-400', type: 'no_response' as const },
  ];

  return (
    <>
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
              {c.notes && <span className="italic text-slate-600 leading-snug">"{c.notes}"</span>}
            </div>
          </div>
          <button
            onClick={() => setSheetOpen(true)}
            className="shrink-0 flex items-center gap-1 text-xs font-semibold text-brand-700 bg-brand-50 px-3 py-2 rounded-xl active:bg-brand-100 transition-colors touch-manipulation"
          >
            Actions
          </button>
        </div>
      </div>

      {/* Bottom sheet */}
      {sheetOpen && (
        <>
          <div className="fixed inset-0 z-50 bg-black/40" onClick={() => setSheetOpen(false)} />
          <div className="fixed bottom-0 left-0 right-0 z-50 bg-white rounded-t-3xl shadow-2xl">
            {/* Handle */}
            <div className="w-10 h-1 bg-slate-200 rounded-full mx-auto mt-3 mb-1" />
            {/* Case context */}
            <div className="px-5 pt-2 pb-3 border-b border-slate-100">
              <p className="font-semibold text-slate-900 text-sm truncate">{c.product}</p>
              <p className="text-xs text-slate-400 mt-0.5">{c.customerName || c.caseId} · {c.staff}</p>
              {c.notes && (
                <p className="text-xs text-slate-500 italic mt-1 leading-snug">"{c.notes}"</p>
              )}
            </div>
            {/* Action rows */}
            <div className="px-4 pt-2">
              {sheetActions.map((item, i) => (
                <button
                  key={item.type}
                  onClick={() => { setSheetOpen(false); onAction(c, item.type); }}
                  className={`w-full flex items-center gap-4 px-2 py-4 text-[15px] font-semibold ${item.color} active:bg-slate-50 transition-colors touch-manipulation ${i < sheetActions.length - 1 ? 'border-b border-slate-100' : ''}`}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </div>
            {/* Cancel */}
            <div className="px-4 pt-2 pb-8">
              <button
                onClick={() => setSheetOpen(false)}
                className="w-full py-4 text-sm font-semibold text-slate-500 bg-slate-100 rounded-2xl active:bg-slate-200 transition-colors touch-manipulation"
              >
                Cancel
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
