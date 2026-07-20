import { useState, useEffect, useRef } from 'react';
import { format, addDays } from 'date-fns';
import { ShoppingBag, Clock, TrendingDown, Users, ChevronDown, CheckCircle, Plus, Store, Trash2 } from 'lucide-react';
import { getSettings, getBrands, insertCase, insertSaleItems, nextCaseId } from '../db';
import { useAppStore } from '../store';
import { useAuth } from '../context/AuthContext';
import type { CaseType, AppSettings, Brand, ProductType } from '../types';
import { PRODUCT_TYPES, LOST_REASONS_QUICK, FOLLOWUP_ACTIONS_QUICK, BROWSING_SECTIONS, BROWSING_BEHAVIOURS } from '../types';
import { formatKD } from '../utils/formatKD';

// ── Brand selector combobox ───────────────────────────────────────────────────

function BrandSelector({ brands, value, onChange, error, compact = false }: {
  brands: Brand[];
  value: string;
  onChange: (v: string) => void;
  error?: string;
  compact?: boolean;
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
        className={`input text-left flex items-center justify-between w-full ${error ? 'input-error' : ''} ${compact ? 'py-2 text-sm' : ''}`}
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

// ── Sale item draft type ──────────────────────────────────────────────────────

interface SaleItemDraft {
  brand: string;
  productType: ProductType;
  product: string;
  quantity: string;
  amountKD: string;
}

function blankItem(): SaleItemDraft {
  return { brand: '', productType: 'Watch', product: '', quantity: '1', amountKD: '' };
}

// ── Sale items editor ─────────────────────────────────────────────────────────

function SaleItemsEditor({ items, onChange, brands, errors }: {
  items: SaleItemDraft[];
  onChange: (items: SaleItemDraft[]) => void;
  brands: Brand[];
  errors: Record<string, string>;
}) {
  function update(index: number, patch: Partial<SaleItemDraft>) {
    onChange(items.map((item, i) => i === index ? { ...item, ...patch } : item));
  }

  function remove(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  const total = items.reduce((sum, item) => {
    const v = parseFloat(item.amountKD);
    return sum + (isNaN(v) ? 0 : v);
  }, 0);

  return (
    <div className="space-y-3">
      {items.map((item, i) => (
        <div key={i} className="bg-slate-50 rounded-2xl p-3 space-y-2.5 relative">
          {/* Item header */}
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
              Item {i + 1}
            </span>
            {items.length > 1 && (
              <button
                type="button"
                onClick={() => remove(i)}
                className="p-1 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Brand */}
          <div>
            <label className="label text-xs">Brand <span className="text-rose-500">*</span></label>
            <BrandSelector
              brands={brands}
              value={item.brand}
              onChange={v => update(i, { brand: v })}
              error={errors[`item_${i}_brand`]}
              compact
            />
          </div>

          {/* Product Type */}
          <div>
            <label className="label text-xs">Product Type</label>
            <div className="grid grid-cols-3 gap-1.5">
              {PRODUCT_TYPES.map(pt => (
                <button key={pt} type="button"
                  onClick={() => update(i, { productType: pt })}
                  className={`quick-btn text-center text-xs py-1.5 ${item.productType === pt ? 'quick-btn-active' : ''}`}>
                  {pt}
                </button>
              ))}
            </div>
          </div>

          {/* Model (optional) */}
          <div>
            <label className="label text-xs">Model / Reference <span className="text-slate-400 font-normal">(optional)</span></label>
            <input
              value={item.product}
              onChange={e => update(i, { product: e.target.value })}
              placeholder="e.g. Submariner, ref. 126610LN"
              className="input text-sm py-2"
            />
          </div>

          {/* Qty + Amount row */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label text-xs">Qty</label>
              <input
                value={item.quantity}
                onChange={e => update(i, { quantity: e.target.value })}
                type="number" inputMode="numeric" min="1" step="1"
                className="input text-sm py-2"
              />
            </div>
            <div>
              <label className="label text-xs">Line Total (KD) <span className="text-rose-500">*</span></label>
              <div className="relative">
                <input
                  value={item.amountKD}
                  onChange={e => update(i, { amountKD: e.target.value })}
                  placeholder="0.000"
                  type="number" inputMode="decimal" step="0.001" min="0"
                  className={`input text-sm py-2 pr-10 ${errors[`item_${i}_amount`] ? 'input-error' : ''}`}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">KD</span>
              </div>
              {errors[`item_${i}_amount`] && (
                <p className="text-rose-500 text-xs mt-1">{errors[`item_${i}_amount`]}</p>
              )}
            </div>
          </div>
        </div>
      ))}

      {/* Add item */}
      <button
        type="button"
        onClick={() => onChange([...items, blankItem()])}
        className="flex items-center gap-1.5 text-sm text-brand-700 font-medium hover:text-brand-800 transition-colors"
      >
        <Plus className="w-4 h-4" /> Add another item
      </button>

      {/* Running total (only when > 1 item) */}
      {items.length > 1 && (
        <div className="flex items-center justify-between px-3 py-2 bg-emerald-50 rounded-xl border border-emerald-100">
          <span className="text-sm font-semibold text-emerald-800">Transaction Total</span>
          <span className="text-sm font-bold text-emerald-700">{formatKD(total)} KD</span>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function QuickEntry({ panelMode = false }: { panelMode?: boolean }) {
  const { lastStaff, setLastStaff, showToast, bumpRefreshLog, activeOutlet, setActiveOutlet } = useAppStore();
  const { role } = useAuth();
  const [showOutletPicker, setShowOutletPicker] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);

  const [staff, setStaff] = useState(lastStaff || '');
  const [entryType, setEntryType] = useState<CaseType | ''>('');

  // ── Sale items state (multi-item) ────────────────────────────────────────
  const [saleItems, setSaleItems] = useState<SaleItemDraft[]>([blankItem()]);

  // ── Non-sale fields ──────────────────────────────────────────────────────
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
  const [lostProduct, setLostProduct] = useState('');
  const [strapWidth, setStrapWidth] = useState('');
  const [browsingTags, setBrowsingTags] = useState<string[]>([]);
  const [browsingBehaviour, setBrowsingBehaviour] = useState('');
  const [visitorCount, setVisitorCount] = useState(1);
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
    setSaleItems([blankItem()]);
    setBrand('');
    setProductType('Watch');
    setLostReason('');
    setFollowUpAction('');
    setCustomerName('');
    setContact('');
    setAmountKD('');
    setLostProduct('');
    setStrapWidth('');
    setBrowsingTags([]);
    setBrowsingBehaviour('');
    setVisitorCount(1);
    setShowNotes(false);
    setNotes('');
    setErrors({});
    setPromisedCallback(format(addDays(new Date(), 1), 'yyyy-MM-dd'));
  }

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!staff) errs.staff = 'Required';
    if (!entryType) errs.entryType = 'Select an entry type';

    if (entryType === 'Sale') {
      // Validate each sale item
      for (let i = 0; i < saleItems.length; i++) {
        const item = saleItems[i];
        if (!item.brand) errs[`item_${i}_brand`] = 'Select a brand';
        if (!item.amountKD || isNaN(Number(item.amountKD)) || Number(item.amountKD) <= 0) {
          errs[`item_${i}_amount`] = 'Enter a valid amount';
        }
      }
    } else if (entryType && entryType !== 'No Interaction') {
      if (!brand) errs.brand = 'Select a brand';
      if (entryType === 'Lost Sale' && !lostReason)
        errs.lostReason = 'Select a reason';
      if (entryType === 'Follow-up') {
        if (!followUpAction) errs.followUpAction = 'Select an action';
        if (!contact.trim()) errs.contact = 'Required for follow-ups';
        if (!promisedCallback) errs.promisedCallback = 'Required';
        if (!notes.trim()) errs.notes = 'Describe what the customer needs';
      }
      if (entryType === 'Lost Sale' && !notes.trim())
        errs.notes = 'Describe what the customer was looking for';
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

      if (entryType === 'Sale') {
        // Multi-item sale: total is sum of all line totals
        const totalKD = saleItems.reduce((s, item) => s + (parseFloat(item.amountKD) || 0), 0);
        const firstItem = saleItems[0];
        const productLabel = firstItem.brand || firstItem.productType || 'Sale';

        const savedCase = await insertCase({
          caseId,
          dateLogged: dateStr,
          timeLogged: format(now, 'HH:mm'),
          staff,
          outlet: activeOutlet ?? undefined,
          caseType: 'Sale',
          // top-level fields reflect first item (for backward compat display)
          brand: firstItem.brand || undefined,
          productType: firstItem.productType || undefined,
          product: saleItems.length > 1 ? `${productLabel} +${saleItems.length - 1} more` : (firstItem.product || productLabel),
          amountKD: totalKD,
          customerName: customerName.trim() || undefined,
          contact: contact.trim() || undefined,
          notes: notes.trim() || undefined,
          status: 'Open',
          dayLocked: false,
          auditLog: [{ timestamp: now.toISOString(), action: 'created', by: staff }],
        });

        // Insert sale_items
        await insertSaleItems(savedCase.id!, saleItems.map((item, i) => ({
          brand: item.brand || undefined,
          productType: item.productType || undefined,
          product: item.product.trim() || undefined,
          quantity: parseInt(item.quantity) || 1,
          amountKD: parseFloat(item.amountKD) || 0,
          sortOrder: i,
        })));

      } else {
        let productLabel: string;
        if (entryType === 'Lost Sale') {
          const parts = [lostProduct.trim(), strapWidth].filter(Boolean);
          productLabel = parts.length > 0 ? parts.join(' — ') : (brand || productType);
        } else {
          productLabel = brand || (entryType === 'No Interaction' ? 'No Interaction' : productType);
        }

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
          browsingTags: (() => {
            const all = [...browsingTags, ...(browsingBehaviour ? [browsingBehaviour] : [])];
            return all.length > 0 ? all : undefined;
          })(),
          notes: notes.trim() || undefined,
          visitorCount: entryType === 'No Interaction' ? visitorCount : undefined,
          status: entryType === 'No Interaction' ? 'Closed' : 'Open',
          dayLocked: false,
          auditLog: [{ timestamp: now.toISOString(), action: 'created', by: staff }],
        });
      }

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
  const isSale = entryType === 'Sale';
  const isRegularNonSale = entryType && !isNoInteraction && !isSale;
  const outerClass = panelMode ? 'px-4 pt-4 pb-8' : 'px-4 pt-6 pb-32 max-w-lg mx-auto lg:max-w-xl lg:px-8 lg:pb-12';

  return (
    <div className={outerClass}>
      {/* Header */}
      <div className="mb-5">
        <h1 className={`font-bold text-slate-900 ${panelMode ? 'text-xl' : 'text-2xl'}`}>Quick Entry</h1>
        <div className="flex items-center gap-3 mt-0.5">
          <p className="text-slate-500 text-sm">{format(new Date(), 'EEEE, d MMMM yyyy')}</p>
          {role === 'staff' && activeOutlet && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowOutletPicker(p => !p)}
                className="flex items-center gap-1.5 px-2.5 py-1 bg-brand-50 border border-brand-200 rounded-full text-xs font-semibold text-brand-700 hover:bg-brand-100 transition-colors"
              >
                <Store className="w-3 h-3" />
                {activeOutlet}
                <ChevronDown className="w-3 h-3" />
              </button>
              {showOutletPicker && settings && (
                <div className="absolute left-0 top-full mt-1 bg-white border border-slate-200 rounded-xl shadow-lg z-50 min-w-[140px] overflow-hidden">
                  {settings.outlets.map(o => (
                    <button
                      key={o}
                      type="button"
                      onClick={() => { setActiveOutlet(o); setShowOutletPicker(false); }}
                      className={`w-full text-left px-4 py-2.5 text-sm font-medium transition-colors ${
                        o === activeOutlet
                          ? 'bg-brand-50 text-brand-700'
                          : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {o === activeOutlet && <span className="mr-1.5">✓</span>}{o}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
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

            {/* Visitor count */}
            <div>
              <label className="label">
                How many visitors?
              </label>
              <div className="grid grid-cols-4 gap-2">
                {([1, 2, 3, 4] as const).map(n => (
                  <button key={n} type="button"
                    onClick={() => setVisitorCount(n)}
                    className={`quick-btn text-center py-3 text-base font-bold ${visitorCount === n ? 'quick-btn-active' : ''}`}>
                    {n === 4 ? '4+' : n}
                  </button>
                ))}
              </div>
            </div>

            {/* Brand */}
            <div>
              <label className="label">
                Brand they looked at
                <span className="text-slate-400 font-normal ml-1">(optional)</span>
              </label>
              <BrandSelector brands={brands} value={brand} onChange={setBrand} />
            </div>

            {/* Section — what they looked at (multi-select) */}
            <div>
              <label className="label">What section?</label>
              <div className="flex flex-wrap gap-2">
                {BROWSING_SECTIONS.map(tag => (
                  <button key={tag} type="button"
                    onClick={() => toggleBrowsingTag(tag)}
                    className={`quick-btn ${browsingTags.includes(tag) ? 'quick-btn-active' : ''}`}>
                    {tag}
                  </button>
                ))}
              </div>
            </div>

            {/* Behaviour — single select */}
            <div>
              <label className="label">Behaviour</label>
              <div className="flex flex-wrap gap-2">
                {BROWSING_BEHAVIOURS.map(b => (
                  <button key={b} type="button"
                    onClick={() => setBrowsingBehaviour(prev => prev === b ? '' : b)}
                    className={`quick-btn ${browsingBehaviour === b ? 'quick-btn-active' : ''}`}>
                    {b}
                  </button>
                ))}
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="label">
                What were they looking at?
                <span className="text-slate-400 font-normal ml-1">(optional)</span>
              </label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="e.g. Rolex display, asked about strap prices but left…"
                rows={2}
                className="input resize-none" />
            </div>

            <button type="submit" disabled={submitting || !staff}
              className="btn-primary w-full flex items-center justify-center gap-2 py-4 text-base disabled:opacity-40">
              <CheckCircle className="w-5 h-5" />
              {submitting ? 'Saving…' : 'Log No Interaction'}
            </button>
          </div>
        )}

        {/* ── Sale flow (multi-item) ─────────────────────────────────── */}
        {isSale && (
          <div className="space-y-5">

            <SaleItemsEditor
              items={saleItems}
              onChange={setSaleItems}
              brands={brands}
              errors={errors}
            />

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
                  <span className="text-slate-400 font-normal ml-1">(optional)</span>
                </label>
                <input value={contact} onChange={e => setContact(e.target.value)}
                  placeholder="Phone / WhatsApp" type="tel" inputMode="tel"
                  className="input" />
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
              {submitting ? 'Saving…' : 'Log Sale'}
            </button>

          </div>
        )}

        {/* ── Regular flow: Follow-up / Lost Sale ────────────────────── */}
        {isRegularNonSale && (
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

            {/* Amount — optional for non-sale */}
            {(entryType === 'Follow-up' || entryType === 'Lost Sale') && (
              <div>
                <label className="label">
                  Amount (KD)
                  <span className="text-slate-400 font-normal ml-1">(optional)</span>
                </label>
                <div className="relative">
                  <input value={amountKD} onChange={e => setAmountKD(e.target.value)}
                    placeholder="0.000" type="number" inputMode="decimal" step="0.001" min="0"
                    className="input pr-12" />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 font-medium text-sm">KD</span>
                </div>
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

            {/* Model / Item Details (Lost Sale only) */}
            {entryType === 'Lost Sale' && (
              <div>
                <label className="label">
                  Model / Item Details
                  <span className="text-slate-400 font-normal ml-1">(optional — be specific)</span>
                </label>
                <input value={lostProduct} onChange={e => setLostProduct(e.target.value)}
                  placeholder={productType === 'Strap'
                    ? 'e.g. 20mm black leather, for Submariner'
                    : 'e.g. Seamaster 41mm blue dial'}
                  className="input" />
              </div>
            )}

            {/* Strap Width — shown for Lost Sale when product type is Strap */}
            {entryType === 'Lost Sale' && productType === 'Strap' && (
              <div>
                <label className="label">Strap Width</label>
                <div className="flex flex-wrap gap-2">
                  {(['18mm', '20mm', '22mm', '24mm', 'Other'] as const).map(size => (
                    <button key={size} type="button"
                      onClick={() => setStrapWidth(prev => prev === size ? '' : size)}
                      className={`quick-btn ${strapWidth === size ? 'quick-btn-active' : ''}`}>
                      {size}
                    </button>
                  ))}
                </div>
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

            {/* Customer Requirement (Follow-up — required) or Details (Lost Sale — optional) */}
            {entryType === 'Follow-up' ? (
              <div>
                <label className="label">
                  Customer Requirement <span className="text-rose-500">*</span>
                </label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)}
                  placeholder="What does the customer want? What was discussed? What's the next step?"
                  rows={3}
                  className={`input resize-none ${errors.notes ? 'input-error' : ''}`} />
                {errors.notes && <p className="text-rose-500 text-xs mt-1">{errors.notes}</p>}
              </div>
            ) : (
              <div>
                <label className="label">
                  Details / What did they want? <span className="text-rose-500">*</span>
                </label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)}
                  placeholder="e.g. black NATO for Rolex, price too high, wanted it under 15 KD…"
                  rows={2}
                  className={`input resize-none ${errors.notes ? 'input-error' : ''}`} />
                {errors.notes && <p className="text-rose-500 text-xs mt-1">{errors.notes}</p>}
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
