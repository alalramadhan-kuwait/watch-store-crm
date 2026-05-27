import { useState, useEffect, useRef } from 'react';
import { format, addDays } from 'date-fns';
import { ShoppingBag, Clock, TrendingDown, Users, ChevronDown, CheckCircle, Plus } from 'lucide-react';
import { getSettings, getBrands, insertCase, nextCaseId } from '../db';
import { useAppStore } from '../store';
import type { CaseType, AppSettings, Brand, ProductType } from '../types';
import { PRODUCT_TYPES, LOST_REASONS_QUICK, FOLLOWUP_ACTIONS_QUICK, BROWSING_TAGS } from '../types';

// ── Brand selector combobox ───────────────────────────────────────────────────

function BrandSelector({ brands, value, onChange, error }: {
  brands: Brand[];
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const filtered = brands.filter(b =>
    b.name.toLowerCase().includes(search.toLowerCase())
  );

  function select(name: string) {
    onChange(name);
    setOpen(false);
    setSearch('');
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`input text-left flex items-center justify-between w-full ${error ? 'input-error' : ''}`}
      >
        <span className={value ? 'text-slate-900 font-medium' : 'text-slate-400'}>
          {value || 'Select brand…'}
        </span>
        <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-50 w-full bg-white border border-slate-200 rounded-2xl shadow-xl mt-1 overflow-hidden">
          <div className="p-2 border-b border-slate-100">
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search brands…"
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-xl outline-none focus:border-brand-500"
            />
          </div>
          <div className="max-h-52 overflow-y-auto">
            {filtered.map(b => (
              <button
                key={b.id}
                type="button"
                onClick={() => select(b.name)}
                className={`w-full text-left px-4 py-2.5 text-sm flex items-center justify-between hover:bg-slate-50 transition-colors ${
                  value === b.name ? 'bg-brand-50 text-brand-700 font-semibold' : 'text-slate-700'
                }`}
              >
                <span>{b.name}</span>
                {(b.usageCount ?? 0) > 0 && (
                  <span className="text-xs text-slate-400 shrink-0 ml-2">{b.usageCount}</span>
                )}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="text-slate-400 text-sm text-center py-6">No brands found</p>
            )}
          </div>
        </div>
      )}

      {error && <p className="text-rose-500 text-xs mt-1">{error}</p>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function QuickEntry({ panelMode = false }: { panelMode?: boolean }) {
  const { lastStaff, setLastStaff, showToast, bumpRefreshLog, activeOutlet } = useAppStore();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);

  const [staff, setStaff] = useState(lastStaff || '');
  const [entryType, setEntryType] = useState<CaseType | ''>('');
  const [brand, setBrand] = useState('');
  const [productType, setProductType] = useState<ProductType>('Watch');
  const [lostReason, setLostReason] = useState('');
  const [followUpAction, setFollowUpAction] = useState('');
  const [promisedCallback, setPromisedCallback] = useState(
    format(addDays(new Date(), 1), 'yyyy-MM-dd')
  );
  const [customerName, setCustomerName] = useState('');
  const [contact, setContact] = useState('');
  const [amountKD, setAmountKD] = useState('');
  const [browsingTags, setBrowsingTags] = useState<string[]>([]);
  const [showBrowsingOptional, setShowBrowsingOptional] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    getSettings().then(s => {
      setSettings(s);
      if (!staff && s.staffRoster[0]) setStaff(s.staffRoster[0]);
    });
    getBrands().then(setBrands);
  }, []);

  function resetForm() {
    setEntryType('');
    setBrand('');
    setProductType('Watch');
    setLostReason('');
    setFollowUpAction('');
    setCustomerName('');
    setContact('');
    setAmountKD('');
    setBrowsingTags([]);
    setShowBrowsingOptional(false);
    setShowNotes(false);
    setNotes('');
    setErrors({});
    setPromisedCallback(format(addDays(new Date(), 1), 'yyyy-MM-dd'));
  }

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!staff) errs.staff = 'Required';
    if (!entryType) errs.entryType = 'Select an entry type';
    if (entryType && entryType !== 'No Interaction') {
      if (!brand) errs.brand = 'Select a brand';
      if (entryType === 'Sale' && (!amountKD || isNaN(Number(amountKD)) || Number(amountKD) <= 0))
        errs.amountKD = 'Enter a valid amount';
      if (entryType === 'Lost Sale' && !lostReason)
        errs.lostReason = 'Select a reason';
      if (entryType === 'Follow-up') {
        if (!followUpAction) errs.followUpAction = 'Select an action';
        if (!contact.trim()) errs.contact = 'Required for follow-ups';
        if (!promisedCallback) errs.promisedCallback = 'Required';
      }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      const now = new Date();
      const dateStr = format(now, 'yyyy-MM-dd');
      const caseId = await nextCaseId(dateStr);
      const productLabel = brand || (entryType === 'No Interaction' ? 'No Interaction' : productType);

      await insertCase({
        caseId,
        dateLogged: dateStr,
        timeLogged: format(now, 'HH:mm'),
        staff,
        outlet: activeOutlet ?? undefined,
        caseType: entryType as CaseType,
        brand: brand || undefined,
        productType: (entryType !== 'No Interaction' ? productType : undefined),
        product: productLabel,
        amountKD: amountKD ? Number(amountKD) : undefined,
        lostReason: lostReason || undefined,
        followUpAction: followUpAction || undefined,
        promisedCallback: entryType === 'Follow-up' ? promisedCallback : undefined,
        customerName: customerName.trim() || undefined,
        contact: contact.trim() || undefined,
        browsingTags: browsingTags.length > 0 ? browsingTags : undefined,
        status: entryType === 'No Interaction' ? 'Closed' : 'Open',
        dayLocked: false,
        auditLog: [{ timestamp: now.toISOString(), action: 'created', by: staff }],
      });

      setLastStaff(staff);
      getBrands().then(setBrands);
      bumpRefreshLog();
      showToast('Logged!', 'success');
      resetForm();
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string; details?: string };
      console.error('[QuickEntry] Save failed:', err);
      const msg = e?.message ? `Save failed: ${e.message}` : 'Failed to save. Check connection.';
      showToast(msg, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  function toggleBrowsingTag(tag: string) {
    setBrowsingTags(prev =>
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    );
  }

  if (!settings) return <div className="flex-1 flex items-center justify-center text-slate-400">Loading…</div>;

  const isNoInteraction = entryType === 'No Interaction';
  const isRegular = entryType && !isNoInteraction;
  const outerClass = panelMode ? 'px-4 pt-4 pb-8' : 'px-4 pt-6 pb-32 max-w-lg mx-auto lg:max-w-xl lg:px-8 lg:pb-12';

  return (
    <div className={outerClass}>
      {/* Header */}
      <div className="mb-5">
        <h1 className={`font-bold text-slate-900 ${panelMode ? 'text-xl' : 'text-2xl'}`}>Quick Entry</h1>
        <p className="text-slate-500 text-sm mt-0.5">{format(new Date(), 'EEEE, d MMMM yyyy')}</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">

        {/* Staff */}
        <div>
          <label className="label">Staff <span className="text-rose-500">*</span></label>
          <select value={staff} onChange={e => setStaff(e.target.value)}
            className={`input ${errors.staff ? 'input-error' : ''}`}>
            <option value="">— Select staff —</option>
            {settings.staffRoster.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {/* Entry Type */}
        <div>
          <label className="label">Entry Type <span className="text-rose-500">*</span></label>
          {panelMode ? (
            /* Desktop panel: single column, compact horizontal buttons */
            <div className="flex flex-col gap-1.5">
              {([
                { type: 'Sale',           icon: ShoppingBag,  cls: 'sale'    },
                { type: 'Follow-up',      icon: Clock,        cls: 'followup'},
                { type: 'Lost Sale',      icon: TrendingDown, cls: 'lost'    },
                { type: 'No Interaction', icon: Users,        cls: 'neutral' },
              ] as const).map(({ type, icon: Icon, cls }) => (
                <button key={type} type="button"
                  onClick={() => setEntryType(type as CaseType)}
                  className={`flex items-center gap-3 px-4 py-2.5 rounded-xl border-2 font-semibold text-sm transition-all duration-150 active:scale-95 select-none touch-manipulation w-full
                    ${entryType === type ? `type-btn-${cls}-active` : `type-btn-${cls}`}`}>
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{type}</span>
                </button>
              ))}
            </div>
          ) : (
            /* Mobile: 2×2 grid */
            <div className="grid grid-cols-2 gap-2">
              {([
                { type: 'Sale',           icon: ShoppingBag,  cls: 'sale'    },
                { type: 'Follow-up',      icon: Clock,        cls: 'followup'},
                { type: 'Lost Sale',      icon: TrendingDown, cls: 'lost'    },
                { type: 'No Interaction', icon: Users,        cls: 'neutral' },
              ] as const).map(({ type, icon: Icon, cls }) => (
                <button key={type} type="button"
                  onClick={() => setEntryType(type as CaseType)}
                  className={`type-btn ${entryType === type ? `type-btn-${cls}-active` : `type-btn-${cls}`}`}>
                  <Icon className="w-5 h-5" />
                  <span className="whitespace-nowrap text-xs">{type}</span>
                </button>
              ))}
            </div>
          )}
          {errors.entryType && <p className="text-rose-500 text-xs mt-1">{errors.entryType}</p>}
        </div>

        {/* ── No Interaction flow ─────────────────────────────────────── */}
        {isNoInteraction && (
          <div className="space-y-4">
            <button type="button"
              onClick={() => setShowBrowsingOptional(v => !v)}
              className="flex items-center gap-1.5 text-sm text-brand-700 font-medium">
              <Plus className="w-4 h-4" />
              {showBrowsingOptional ? 'Hide optional details' : 'Add optional details'}
            </button>

            {showBrowsingOptional && (
              <div className="space-y-4 p-4 bg-slate-50 rounded-2xl">
                <div>
                  <label className="label">Brand (optional)</label>
                  <BrandSelector brands={brands} value={brand} onChange={setBrand} />
                </div>
                <div>
                  <label className="label">Browsing tags (optional)</label>
                  <div className="flex flex-wrap gap-2">
                    {BROWSING_TAGS.map(tag => (
                      <button key={tag} type="button"
                        onClick={() => toggleBrowsingTag(tag)}
                        className={`quick-btn ${browsingTags.includes(tag) ? 'quick-btn-active' : ''}`}>
                        {tag}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <button type="submit" disabled={submitting || !staff}
              className="btn-primary w-full flex items-center justify-center gap-2 py-4 text-base disabled:opacity-40">
              <CheckCircle className="w-5 h-5" />
              {submitting ? 'Saving…' : 'Log No Interaction'}
            </button>
          </div>
        )}

        {/* ── Regular flow: Sale / Follow-up / Lost Sale ──────────────── */}
        {isRegular && (
          <div className="space-y-5">

            {/* Brand */}
            <div>
              <label className="label">Brand <span className="text-rose-500">*</span></label>
              <BrandSelector brands={brands} value={brand} onChange={setBrand} error={errors.brand} />
            </div>

            {/* Product Type */}
            <div>
              <label className="label">Product Type</label>
              <div className="grid grid-cols-3 gap-2">
                {PRODUCT_TYPES.map(pt => (
                  <button key={pt} type="button"
                    onClick={() => setProductType(pt)}
                    className={`quick-btn text-center ${productType === pt ? 'quick-btn-active' : ''}`}>
                    {pt}
                  </button>
                ))}
              </div>
            </div>

            {/* Amount — Sale required, others optional */}
            {(entryType === 'Sale' || entryType === 'Follow-up' || entryType === 'Lost Sale') && (
              <div>
                <label className="label">
                  Amount (KD)
                  {entryType === 'Sale'
                    ? <span className="text-rose-500"> *</span>
                    : <span className="text-slate-400 font-normal ml-1">(optional)</span>}
                </label>
                <div className="relative">
                  <input value={amountKD} onChange={e => setAmountKD(e.target.value)}
                    placeholder="0.000" type="number" inputMode="decimal" step="0.001" min="0"
                    className={`input pr-12 ${errors.amountKD ? 'input-error' : ''}`} />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 font-medium text-sm">KD</span>
                </div>
                {errors.amountKD && <p className="text-rose-500 text-xs mt-1">{errors.amountKD}</p>}
              </div>
            )}

            {/* Lost Reason */}
            {entryType === 'Lost Sale' && (
              <div>
                <label className="label">Reason <span className="text-rose-500">*</span></label>
                <div className="flex flex-wrap gap-2">
                  {LOST_REASONS_QUICK.map(r => (
                    <button key={r} type="button"
                      onClick={() => setLostReason(r)}
                      className={`quick-btn ${lostReason === r ? 'quick-btn-active' : ''}`}>
                      {r}
                    </button>
                  ))}
                </div>
                {errors.lostReason && <p className="text-rose-500 text-xs mt-1">{errors.lostReason}</p>}
              </div>
            )}

            {/* Follow-up Action */}
            {entryType === 'Follow-up' && (
              <div>
                <label className="label">Action <span className="text-rose-500">*</span></label>
                <div className="flex flex-wrap gap-2">
                  {FOLLOWUP_ACTIONS_QUICK.map(a => (
                    <button key={a} type="button"
                      onClick={() => setFollowUpAction(a)}
                      className={`quick-btn ${followUpAction === a ? 'quick-btn-active' : ''}`}>
                      {a}
                    </button>
                  ))}
                </div>
                {errors.followUpAction && <p className="text-rose-500 text-xs mt-1">{errors.followUpAction}</p>}
              </div>
            )}

            {/* Callback Date */}
            {entryType === 'Follow-up' && (
              <div>
                <label className="label">Callback Date <span className="text-rose-500">*</span></label>
                <input type="date" value={promisedCallback}
                  onChange={e => setPromisedCallback(e.target.value)}
                  min={format(new Date(), 'yyyy-MM-dd')}
                  className={`input ${errors.promisedCallback ? 'input-error' : ''}`} />
                {errors.promisedCallback && <p className="text-rose-500 text-xs mt-1">{errors.promisedCallback}</p>}
              </div>
            )}

            {/* Customer Details */}
            <div className="space-y-3">
              <div>
                <label className="label">
                  Customer Name
                  <span className="text-slate-400 font-normal ml-1">(optional)</span>
                </label>
                <input value={customerName} onChange={e => setCustomerName(e.target.value)}
                  placeholder="Full name" className="input" />
              </div>
              <div>
                <label className="label">
                  Contact
                  {entryType === 'Follow-up'
                    ? <span className="text-rose-500"> *</span>
                    : <span className="text-slate-400 font-normal ml-1">(optional)</span>}
                </label>
                <input value={contact} onChange={e => setContact(e.target.value)}
                  placeholder="Phone / WhatsApp" type="tel" inputMode="tel"
                  className={`input ${errors.contact ? 'input-error' : ''}`} />
                {errors.contact && <p className="text-rose-500 text-xs mt-1">{errors.contact}</p>}
              </div>
            </div>

            {/* Notes toggle */}
            {!showNotes ? (
              <button type="button" onClick={() => setShowNotes(true)}
                className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-600 transition-colors">
                <Plus className="w-3.5 h-3.5" /> Add note
              </button>
            ) : (
              <div>
                <label className="label">Notes (optional)</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)}
                  placeholder="Any additional details…"
                  rows={2}
                  className="input resize-none" />
              </div>
            )}

            {/* Submit */}
            <button type="submit" disabled={submitting}
              className="btn-primary w-full flex items-center justify-center gap-2 py-4 text-base disabled:opacity-40">
              <CheckCircle className="w-5 h-5" />
              {submitting ? 'Saving…' : `Log ${entryType}`}
            </button>

          </div>
        )}

      </form>
    </div>
  );
}
