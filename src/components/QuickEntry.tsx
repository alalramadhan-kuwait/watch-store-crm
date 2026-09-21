import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { canActForOtherStaff } from '../utils/roles';
import { readDraft, writeDraft, clearDraft } from '../lib/drafts';
import { format, addDays } from 'date-fns';
import { ShoppingBag, Clock, TrendingDown, Users, ChevronDown, CheckCircle, Plus, Store, Trash2, ShieldAlert} from 'lucide-react';
import { getSettings, getBrands, insertCase, insertSaleItems, nextCaseId, lookupCustomerByPhone, createCustomer, type PhoneLookup } from '../db';
import { normalizePhone, displayPhone } from '../shared/phoneRules';
import { caseLabel } from '../shared/caseLabels';
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

/* The draft is per visit. The same VISIT id means the app is still going —
   switching to Today and back should simply find the form as you left it. A
   draft from a different id means the app was closed and reopened, which is
   worth saying out loud. */
const VISIT = Math.random().toString(36).slice(2);
const DRAFT = 'quick-entry';

/** A datetime-local value for an instant, in the phone's own zone. */
const localStamp = (d: Date) => format(d, "yyyy-MM-dd'T'HH:mm");

// ── Main component ────────────────────────────────────────────────────────────

/**
 * Customer Visit.
 *
 * One screen for what happened when a customer came in: who served them, when,
 * and how it ended — Browsing, Interested, or a Lost Opportunity — with Manual
 * Sale kept alongside for the transition. The stored kinds are what they always
 * were (No Interaction, Follow-up, Lost Sale, Sale); only the words changed.
 *
 * The number is the customer's identity. It is normalised as it is typed, and
 * the database is asked whether it is known: a customer of yours comes back
 * with a name and a line of history, a customer of somebody else's as
 * "recognised" and nothing more, until this visit is saved and the
 * relationship exists.
 */
export function QuickEntry({ panelMode = false }: { panelMode?: boolean }) {
  const { lastStaff, setLastStaff, showToast, bumpRefreshLog, activeOutlet, setActiveOutlet } = useAppStore();
  const { role, salesName, onFloor } = useAuth();
  /* A personal login logs under its own name and nobody else's. The staff
     dropdown belongs to the accounts that speak for the shop. */
  const canPickStaff = canActForOtherStaff(role);
  const [showOutletPicker, setShowOutletPicker] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);

  // a personal login always logs as itself; the shared login remembers its last pick
  const [staff, setStaff] = useState(canPickStaff ? (lastStaff || '') : (salesName || ''));
  useEffect(() => {
    if (!canPickStaff) setStaff(salesName || '');
  }, [canPickStaff, salesName]);
  const [entryType, setEntryType] = useState<CaseType | ''>('');

  /* When the customer was actually here. Defaults to now and is left alone
     nearly always; after a rush, somebody logging three visits at once can
     put each at its real time, and the hourly traffic figures stay true. */
  const [when, setWhen] = useState(() => localStamp(new Date()));
  const [whenTouched, setWhenTouched] = useState(false);

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
  const [contactDeclined, setContactDeclined] = useState(false);
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
  const [restored, setRestored] = useState(false);

  /* ── the number, as it is typed ──────────────────────────────────────────
     Normalised on every keystroke so the person sees what will be stored, and
     looked up once it settles so they hear whether we know this customer. */
  const contactE164 = normalizePhone(contact);
  const [lookup, setLookup] = useState<PhoneLookup | null>(null);
  useEffect(() => {
    if (!contactE164) { setLookup(null); return; }
    let live = true;
    const t = setTimeout(() => {
      lookupCustomerByPhone(contactE164).then((r) => { if (live) setLookup(r); }).catch(() => { if (live) setLookup(null); });
    }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [contactE164]);

  /* ── the draft ──────────────────────────────────────────────────────────
     Everything above that a person types, kept as they type it. Until Save,
     a visit exists nowhere but this phone. */
  const { user } = useAuth();
  const snapshot = () => ({
    visit: VISIT, entryType, saleItems, brand, productType, lostReason, followUpAction,
    promisedCallback, customerName, contact, contactDeclined, amountKD, lostProduct, strapWidth,
    browsingTags, browsingBehaviour, visitorCount, showNotes, notes, when, whenTouched,
  });
  type Draft = ReturnType<typeof snapshot>;
  const worthKeeping = (d: Draft) =>
    !!d.entryType || !!d.brand || !!d.customerName || !!d.contact || !!d.amountKD ||
    !!d.lostProduct || !!d.strapWidth || !!d.browsingBehaviour || !!d.notes ||
    d.browsingTags.length > 0 || d.visitorCount !== 1 ||
    d.saleItems.some((i) => i.brand || i.amountKD || i.product || i.productType !== 'Watch');

  const applyDraft = (d: Draft) => {
    setEntryType(d.entryType); setSaleItems(d.saleItems); setBrand(d.brand);
    setProductType(d.productType); setLostReason(d.lostReason); setFollowUpAction(d.followUpAction);
    setPromisedCallback(d.promisedCallback); setCustomerName(d.customerName); setContact(d.contact);
    setContactDeclined(!!d.contactDeclined);
    setAmountKD(d.amountKD); setLostProduct(d.lostProduct); setStrapWidth(d.strapWidth);
    setBrowsingTags(d.browsingTags); setBrowsingBehaviour(d.browsingBehaviour);
    setVisitorCount(d.visitorCount); setShowNotes(d.showNotes); setNotes(d.notes);
    // a time that was set on purpose comes back; one that was only "now" is now again
    if (d.whenTouched && d.when) { setWhen(d.when); setWhenTouched(true); }
  };

  /* Opened from a customer's page: the number and name are already known,
     so they arrive filled in and the form starts at the outcome. A draft
     for somebody else is not restored over them. */
  const [params, setParams] = useSearchParams();
  const prefill = useRef({ contact: params.get('contact') ?? '', name: params.get('name') ?? '' });
  useEffect(() => {
    const p = prefill.current;
    if (!p.contact && !p.name) return;
    if (p.contact) setContact(displayPhone(normalizePhone(p.contact) ?? p.contact) ?? p.contact);
    if (p.name) setCustomerName(p.name);
    setParams({}, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    if (prefill.current.contact || prefill.current.name) { loaded.current = true; return; }
    loaded.current = true;
    const d = readDraft<Draft>(user?.id, DRAFT);
    if (!d || !worthKeeping(d)) return;
    applyDraft(d);
    if (d.visit !== VISIT) setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    if (!loaded.current) return;
    const d = snapshot();
    if (worthKeeping(d)) writeDraft(user?.id, DRAFT, d);
    else clearDraft(user?.id, DRAFT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryType, saleItems, brand, productType, lostReason, followUpAction, promisedCallback,
      customerName, contact, contactDeclined, amountKD, lostProduct, strapWidth, browsingTags,
      browsingBehaviour, visitorCount, showNotes, notes, when, whenTouched, user?.id]);

  useEffect(() => {
    getSettings().then(s => {
      setSettings(s);
      if (!staff && canPickStaff && s.staffRoster[0]) setStaff(s.staffRoster[0]);
    });
    getBrands().then(setBrands);
  }, []);

  function resetForm() {
    clearDraft(user?.id, DRAFT);
    setRestored(false);
    setEntryType('');
    setSaleItems([blankItem()]);
    setBrand('');
    setProductType('Watch');
    setLostReason('');
    setFollowUpAction('');
    setCustomerName('');
    setContact('');
    setContactDeclined(false);
    setAmountKD('');
    setLostProduct('');
    setStrapWidth('');
    setBrowsingTags([]);
    setBrowsingBehaviour('');
    setVisitorCount(1);
    setShowNotes(false);
    setNotes('');
    setErrors({});
    setLookup(null);
    setWhen(localStamp(new Date()));
    setWhenTouched(false);
    setPromisedCallback(format(addDays(new Date(), 1), 'yyyy-MM-dd'));
  }

  /* The rules, as approved: Interested needs a name and a number we can match
     on; a Lost Opportunity takes them when the customer gives them and is
     saved honestly when they decline; Browsing takes no customer at all. */
  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!staff) errs.staff = 'Required';
    if (!entryType) errs.entryType = 'Choose what happened';
    const whenDate = new Date(when);
    if (isNaN(whenDate.getTime())) errs.when = 'Enter a valid time';
    else if (whenDate.getTime() > Date.now() + 5 * 60_000) errs.when = 'A visit cannot be in the future';

    if (entryType === 'Sale') {
      for (let i = 0; i < saleItems.length; i++) {
        const item = saleItems[i];
        if (!item.brand) errs[`item_${i}_brand`] = 'Select a brand';
        if (!item.amountKD || isNaN(Number(item.amountKD)) || Number(item.amountKD) <= 0) {
          errs[`item_${i}_amount`] = 'Enter a valid amount';
        }
      }
      if (contact.trim() && !contactE164) errs.contact = 'Not a number we can match on';
    } else if (entryType && entryType !== 'No Interaction') {
      if (!brand) errs.brand = 'Select a brand';
      if (entryType === 'Follow-up') {
        if (!customerName.trim()) errs.customerName = 'Required — who are we following up with?';
        if (!contact.trim()) errs.contact = 'Required — a number to reach them on';
        else if (!contactE164) errs.contact = 'Not a number we can match on';
        if (!followUpAction) errs.followUpAction = 'Select an action';
        if (!promisedCallback) errs.promisedCallback = 'Required';
        if (!notes.trim()) errs.notes = 'Describe what the customer needs';
      }
      if (entryType === 'Lost Sale') {
        if (!lostReason) errs.lostReason = 'Select a reason';
        if (!notes.trim()) errs.notes = 'Describe what the customer was looking for';
        if (!contactDeclined) {
          if (!customerName.trim()) errs.customerName = 'Name, or tick "customer declined"';
          if (!contact.trim()) errs.contact = 'Number, or tick "customer declined"';
          else if (!contactE164) errs.contact = 'Not a number we can match on';
        } else if (contact.trim() && !contactE164) {
          errs.contact = 'Not a number we can match on — clear it or fix it';
        }
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
      const at = whenTouched ? new Date(when) : new Date();
      const dateStr = format(at, 'yyyy-MM-dd');
      const timeStr = format(at, 'HH:mm');
      const caseId = await nextCaseId(dateStr);
      const savedAt = new Date().toISOString();
      const declined = entryType === 'Lost Sale' && contactDeclined;
      const storedContact = declined ? undefined : (contactE164 ? displayPhone(contactE164) ?? undefined : undefined);
      const storedName = declined && !customerName.trim() ? undefined : (customerName.trim() || undefined);

      /* A number nobody has logged before becomes a customer record now, so
         this visit links to it and the relationship follows. A known number
         links on its own. */
      if (storedContact && lookup && lookup.valid && !lookup.known) {
        await createCustomer(storedContact, storedName);
      }

      const common = {
        caseId, dateLogged: dateStr, timeLogged: timeStr, interactionAt: at.toISOString(),
        staff, outlet: activeOutlet ?? undefined,
        customerName: storedName, contact: storedContact, contactDeclined: declined,
        notes: notes.trim() || undefined,
        dayLocked: false,
        auditLog: [{ timestamp: savedAt, action: 'created' as const, by: staff }],
      };

      if (entryType === 'Sale') {
        const totalKD = saleItems.reduce((s, item) => s + (parseFloat(item.amountKD) || 0), 0);
        const firstItem = saleItems[0];
        const productLabel = firstItem.brand || firstItem.productType || 'Sale';
        const savedCase = await insertCase({
          ...common,
          caseType: 'Sale',
          brand: firstItem.brand || undefined,
          productType: firstItem.productType || undefined,
          product: saleItems.length > 1 ? `${productLabel} +${saleItems.length - 1} more` : (firstItem.product || productLabel),
          amountKD: totalKD,
          status: 'Open',
        });
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
          ...common,
          caseType: entryType as CaseType,
          brand: brand || undefined,
          productType: (entryType !== 'No Interaction' ? productType : undefined),
          product: productLabel,
          amountKD: amountKD ? Number(amountKD) : undefined,
          lostReason: lostReason || undefined,
          followUpAction: followUpAction || undefined,
          promisedCallback: entryType === 'Follow-up' ? promisedCallback : undefined,
          browsingTags: (() => {
            const all = [...browsingTags, ...(browsingBehaviour ? [browsingBehaviour] : [])];
            return all.length > 0 ? all : undefined;
          })(),
          visitorCount: entryType === 'No Interaction' ? visitorCount : undefined,
          status: entryType === 'No Interaction' ? 'Closed' : 'Open',
        });
      }

      if (canPickStaff) setLastStaff(staff);
      getBrands().then(setBrands);
      bumpRefreshLog();
      showToast(`${caseLabel(entryType)} logged`, 'success');
      resetForm();
    } catch (err: unknown) {
      const e = err as { message?: string };
      console.error('[CustomerVisit] Save failed:', err);
      showToast(e?.message ? `Save failed: ${e.message}` : 'Failed to save. Check connection.', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  function toggleBrowsingTag(tag: string) {
    setBrowsingTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  }

  if (!settings) return <div className="flex-1 flex items-center justify-center text-slate-400">Loading…</div>;

  if (!canPickStaff && !salesName) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16">
        <ShieldAlert className="w-12 h-12 mb-3 text-amber-400" />
        <p className="font-medium text-slate-700">Your DSR name isn&rsquo;t set yet.</p>
        <p className="text-sm text-slate-500 mt-1 max-w-xs">
          Visits have to be logged under a name from the staff roster, and this account
          has none. Ask an owner to set it under Settings &rarr; Team Access.
        </p>
      </div>
    );
  }

  const isNoInteraction = entryType === 'No Interaction';
  const isSale = entryType === 'Sale';
  const isRegularNonSale = entryType && !isNoInteraction && !isSale;
  const outerClass = panelMode ? 'px-4 pt-4 pb-8' : 'px-4 pt-6 pb-32 max-w-lg mx-auto lg:max-w-xl lg:px-8 lg:pb-12';

  /* What the form says about the number, under the field. */
  const phoneNote = (() => {
    if (!contact.trim()) return null;
    if (!contactE164) return { tone: 'warn', text: 'Not a number we can match on — check it' };
    const country = contactE164.startsWith('+965') ? 'Kuwait' : `international ${contactE164.slice(0, 4)}…`;
    if (!lookup) return { tone: 'muted', text: `${country} · ${displayPhone(contactE164)}` };
    if (!lookup.known) return { tone: 'muted', text: `${country} · new customer` };
    if (!lookup.mine) return { tone: 'info', text: 'Existing customer recognised — this visit will be linked' };
    const bits = [`Known: ${lookup.name || 'no name yet'}`];
    if (lookup.visits) bits.push(`${lookup.visits} visit${lookup.visits === 1 ? '' : 's'}`);
    if (lookup.last_purchase) bits.push(`last bought ${format(new Date(lookup.last_purchase + 'T12:00:00'), 'd MMM yyyy')}`);
    if (lookup.open_followups) bits.push(`${lookup.open_followups} open follow-up${lookup.open_followups === 1 ? '' : 's'}`);
    return { tone: 'good', text: bits.join(' · ') };
  })();
  const noteClass: Record<string, string> = {
    warn: 'text-amber-700', muted: 'text-slate-400', info: 'text-brand-700', good: 'text-emerald-700',
  };

  const customerFields = (nameRequired: boolean, contactRequired: boolean, allowDecline: boolean) => (
    <div className="space-y-3">
      <div>
        <label className="label">
          Customer Name
          {nameRequired && !contactDeclined ? <span className="text-rose-500"> *</span>
            : <span className="text-slate-400 font-normal ml-1">(optional)</span>}
        </label>
        <input value={customerName} onChange={e => setCustomerName(e.target.value)}
          placeholder="Full name" className={`input ${errors.customerName ? 'input-error' : ''}`}
          onFocus={() => { if (lookup?.mine && lookup.name && !customerName) setCustomerName(lookup.name); }} />
        {errors.customerName && <p className="text-rose-500 text-xs mt-1">{errors.customerName}</p>}
      </div>
      <div>
        <label className="label">
          Mobile
          {contactRequired && !contactDeclined ? <span className="text-rose-500"> *</span>
            : <span className="text-slate-400 font-normal ml-1">(optional)</span>}
        </label>
        <input value={contact} onChange={e => setContact(e.target.value)}
          placeholder="Phone / WhatsApp" type="tel" inputMode="tel" autoComplete="off"
          className={`input ${errors.contact ? 'input-error' : ''}`} />
        {errors.contact
          ? <p className="text-rose-500 text-xs mt-1">{errors.contact}</p>
          : phoneNote && <p className={`text-xs mt-1 ${noteClass[phoneNote.tone]}`}>{phoneNote.text}</p>}
      </div>
      {allowDecline && (
        <label className="flex items-start gap-2.5 text-sm text-slate-600 cursor-pointer select-none">
          <input type="checkbox" checked={contactDeclined} onChange={e => setContactDeclined(e.target.checked)}
            className="mt-0.5 w-4 h-4 rounded border-slate-300 text-brand-700 focus:ring-brand-500" />
          <span>Customer declined to give their details<span className="block text-xs text-slate-400">Saved honestly, with no name or number. Better than a made-up one.</span></span>
        </label>
      )}
    </div>
  );

  return (
    <div className={outerClass}>
      {restored && (
        <div className="mb-4 flex items-center gap-3 px-3 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm">
          <span className="flex-1">An unfinished visit was put back.</span>
          <button type="button" onClick={resetForm} className="shrink-0 font-semibold underline">Discard</button>
        </div>
      )}
      {/* Header */}
      <div className="mb-5">
        <h1 className={`font-bold text-slate-900 ${panelMode ? 'text-xl' : 'text-2xl'}`}>Customer Visit</h1>
        <div className="flex items-center gap-3 mt-0.5">
          <p className="text-slate-500 text-sm">{format(new Date(), 'EEEE, d MMMM yyyy')}</p>
          {onFloor && activeOutlet && (
            <div className="relative">
              <button type="button" onClick={() => setShowOutletPicker(p => !p)}
                className="flex items-center gap-1.5 px-2.5 py-1 bg-brand-50 border border-brand-200 rounded-full text-xs font-semibold text-brand-700 hover:bg-brand-100 transition-colors">
                <Store className="w-3 h-3" />
                {activeOutlet}
                <ChevronDown className="w-3 h-3" />
              </button>
              {showOutletPicker && settings && (
                <div className="absolute left-0 top-full mt-1 bg-white border border-slate-200 rounded-xl shadow-lg z-50 min-w-[140px] overflow-hidden">
                  {settings.outlets.map(o => (
                    <button key={o} type="button"
                      onClick={() => { setActiveOutlet(o); setShowOutletPicker(false); }}
                      className={`w-full text-left px-4 py-2.5 text-sm font-medium transition-colors ${o === activeOutlet ? 'bg-brand-50 text-brand-700' : 'text-slate-700 hover:bg-slate-50'}`}>
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

        {/* Who served them, and when */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Served by <span className="text-rose-500">*</span></label>
            {!canPickStaff ? (
              <div className="input bg-slate-50 text-slate-700 flex items-center justify-between gap-3">
                <span className="font-medium truncate">{salesName}</span>
                <span className="text-[11px] text-slate-400 shrink-0 whitespace-nowrap">your account</span>
              </div>
            ) : (
              <select value={staff} onChange={e => setStaff(e.target.value)}
                className={`input ${errors.staff ? 'input-error' : ''}`}>
                <option value="">— Select staff —</option>
                {settings.staffRoster.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
          </div>
          <div>
            <label className="label flex items-center justify-between">
              <span>Visit time</span>
              {whenTouched && (
                <button type="button" onClick={() => { setWhen(localStamp(new Date())); setWhenTouched(false); }}
                  className="text-[11px] font-semibold text-brand-700">Now</button>
              )}
            </label>
            <input type="datetime-local" value={when} max={localStamp(new Date())}
              onChange={e => { setWhen(e.target.value); setWhenTouched(true); }}
              className={`input ${errors.when ? 'input-error' : ''}`} />
            {errors.when
              ? <p className="text-rose-500 text-xs mt-1">{errors.when}</p>
              : <p className="text-[11px] text-slate-400 mt-1">{whenTouched ? 'Logged at its real time' : 'Now — change it if you are logging this late'}</p>}
          </div>
        </div>

        {/* What happened */}
        <div>
          <label className="label">What happened? <span className="text-rose-500">*</span></label>
          <div className={panelMode ? 'flex flex-col gap-1.5' : 'grid grid-cols-3 gap-2'}>
            {([
              { type: 'No Interaction', icon: Users,        cls: 'neutral'  },
              { type: 'Follow-up',      icon: Clock,        cls: 'followup' },
              { type: 'Lost Sale',      icon: TrendingDown, cls: 'lost'     },
            ] as const).map(({ type, icon: Icon, cls }) => (
              <button key={type} type="button" onClick={() => setEntryType(type as CaseType)}
                className={panelMode
                  ? `flex items-center gap-3 px-4 py-2.5 rounded-xl border-2 font-semibold text-sm transition-all duration-150 active:scale-95 select-none touch-manipulation w-full ${entryType === type ? `type-btn-${cls}-active` : `type-btn-${cls}`}`
                  : `type-btn ${entryType === type ? `type-btn-${cls}-active` : `type-btn-${cls}`}`}>
                <Icon className={panelMode ? 'w-4 h-4 shrink-0' : 'w-5 h-5'} />
                <span className={panelMode ? '' : 'whitespace-nowrap text-xs'}>{caseLabel(type)}</span>
              </button>
            ))}
          </div>
          {/* Manual Sale stays, off the main path, for the transition */}
          <button type="button" onClick={() => setEntryType('Sale')}
            className={`mt-2 w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl border text-xs font-semibold transition-colors
              ${entryType === 'Sale' ? 'type-btn-sale-active border-2' : 'border-dashed border-slate-300 text-slate-500 hover:bg-slate-50'}`}>
            <ShoppingBag className="w-3.5 h-3.5" /> {caseLabel('Sale')}
            <span className="font-normal text-slate-400">· until POS matching is live</span>
          </button>
          {errors.entryType && <p className="text-rose-500 text-xs mt-1">{errors.entryType}</p>}
        </div>

        {/* ── Browsing ─────────────────────────────────────────────────── */}
        {isNoInteraction && (
          <div className="space-y-4">
            <div>
              <label className="label">How many visitors?</label>
              <div className="grid grid-cols-4 gap-2">
                {([1, 2, 3, 4] as const).map(n => (
                  <button key={n} type="button" onClick={() => setVisitorCount(n)}
                    className={`quick-btn text-center py-3 text-base font-bold ${visitorCount === n ? 'quick-btn-active' : ''}`}>
                    {n === 4 ? '4+' : n}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Brand they looked at <span className="text-slate-400 font-normal ml-1">(optional)</span></label>
              <BrandSelector brands={brands} value={brand} onChange={setBrand} />
            </div>
            <div>
              <label className="label">What section?</label>
              <div className="flex flex-wrap gap-2">
                {BROWSING_SECTIONS.map(tag => (
                  <button key={tag} type="button" onClick={() => toggleBrowsingTag(tag)}
                    className={`quick-btn ${browsingTags.includes(tag) ? 'quick-btn-active' : ''}`}>{tag}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Behaviour</label>
              <div className="flex flex-wrap gap-2">
                {BROWSING_BEHAVIOURS.map(b => (
                  <button key={b} type="button" onClick={() => setBrowsingBehaviour(prev => prev === b ? '' : b)}
                    className={`quick-btn ${browsingBehaviour === b ? 'quick-btn-active' : ''}`}>{b}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">What were they looking at? <span className="text-slate-400 font-normal ml-1">(optional)</span></label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="e.g. Rolex display, asked about strap prices but left…" rows={2} className="input resize-none" />
            </div>
            <button type="submit" disabled={submitting || !staff}
              className="btn-primary w-full flex items-center justify-center gap-2 py-4 text-base disabled:opacity-40">
              <CheckCircle className="w-5 h-5" />
              {submitting ? 'Saving…' : 'Log Browsing'}
            </button>
          </div>
        )}

        {/* ── Manual Sale ──────────────────────────────────────────────── */}
        {isSale && (
          <div className="space-y-5">
            <SaleItemsEditor items={saleItems} onChange={setSaleItems} brands={brands} errors={errors} />
            {customerFields(false, false, false)}
            {!showNotes ? (
              <button type="button" onClick={() => setShowNotes(true)}
                className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-600 transition-colors">
                <Plus className="w-3.5 h-3.5" /> Add note
              </button>
            ) : (
              <div>
                <label className="label">Notes (optional)</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Any additional details…" rows={2} className="input resize-none" />
              </div>
            )}
            <button type="submit" disabled={submitting}
              className="btn-primary w-full flex items-center justify-center gap-2 py-4 text-base disabled:opacity-40">
              <CheckCircle className="w-5 h-5" />
              {submitting ? 'Saving…' : 'Log Manual Sale'}
            </button>
          </div>
        )}

        {/* ── Interested / Lost Opportunity ────────────────────────────── */}
        {isRegularNonSale && (
          <div className="space-y-5">
            <div>
              <label className="label">Brand <span className="text-rose-500">*</span></label>
              <BrandSelector brands={brands} value={brand} onChange={setBrand} error={errors.brand} />
            </div>
            <div>
              <label className="label">Product Type</label>
              <div className="grid grid-cols-3 gap-2">
                {PRODUCT_TYPES.map(pt => (
                  <button key={pt} type="button" onClick={() => setProductType(pt)}
                    className={`quick-btn text-center ${productType === pt ? 'quick-btn-active' : ''}`}>{pt}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Amount (KD) <span className="text-slate-400 font-normal ml-1">(optional)</span></label>
              <div className="relative">
                <input value={amountKD} onChange={e => setAmountKD(e.target.value)}
                  placeholder="0.000" type="number" inputMode="decimal" step="0.001" min="0" className="input pr-12" />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 font-medium text-sm">KD</span>
              </div>
            </div>

            {entryType === 'Lost Sale' && (
              <>
                <div>
                  <label className="label">Reason <span className="text-rose-500">*</span></label>
                  <div className="flex flex-wrap gap-2">
                    {LOST_REASONS_QUICK.map(r => (
                      <button key={r} type="button" onClick={() => setLostReason(r)}
                        className={`quick-btn ${lostReason === r ? 'quick-btn-active' : ''}`}>{r}</button>
                    ))}
                  </div>
                  {errors.lostReason && <p className="text-rose-500 text-xs mt-1">{errors.lostReason}</p>}
                </div>
                <div>
                  <label className="label">Model / Item Details <span className="text-slate-400 font-normal ml-1">(optional — be specific)</span></label>
                  <input value={lostProduct} onChange={e => setLostProduct(e.target.value)}
                    placeholder={productType === 'Strap' ? 'e.g. 20mm black leather, for Submariner' : 'e.g. Seamaster 41mm blue dial'}
                    className="input" />
                </div>
                {productType === 'Strap' && (
                  <div>
                    <label className="label">Strap Width</label>
                    <div className="flex flex-wrap gap-2">
                      {(['18mm', '20mm', '22mm', '24mm', 'Other'] as const).map(size => (
                        <button key={size} type="button" onClick={() => setStrapWidth(prev => prev === size ? '' : size)}
                          className={`quick-btn ${strapWidth === size ? 'quick-btn-active' : ''}`}>{size}</button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {entryType === 'Follow-up' && (
              <>
                <div>
                  <label className="label">Follow-up action <span className="text-rose-500">*</span></label>
                  <div className="flex flex-wrap gap-2">
                    {FOLLOWUP_ACTIONS_QUICK.map(a => (
                      <button key={a} type="button" onClick={() => setFollowUpAction(a)}
                        className={`quick-btn ${followUpAction === a ? 'quick-btn-active' : ''}`}>{a}</button>
                    ))}
                  </div>
                  {errors.followUpAction && <p className="text-rose-500 text-xs mt-1">{errors.followUpAction}</p>}
                </div>
                <div>
                  <label className="label">Next follow-up <span className="text-rose-500">*</span></label>
                  <input type="date" value={promisedCallback} onChange={e => setPromisedCallback(e.target.value)}
                    min={format(new Date(), 'yyyy-MM-dd')} className={`input ${errors.promisedCallback ? 'input-error' : ''}`} />
                  {errors.promisedCallback && <p className="text-rose-500 text-xs mt-1">{errors.promisedCallback}</p>}
                </div>
              </>
            )}

            {entryType === 'Follow-up' ? customerFields(true, true, false) : customerFields(true, true, true)}

            {entryType === 'Follow-up' ? (
              <div>
                <label className="label">Customer Requirement <span className="text-rose-500">*</span></label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)}
                  placeholder="What does the customer want? What was discussed? What's the next step?"
                  rows={3} className={`input resize-none ${errors.notes ? 'input-error' : ''}`} />
                {errors.notes && <p className="text-rose-500 text-xs mt-1">{errors.notes}</p>}
              </div>
            ) : (
              <div>
                <label className="label">Details / What did they want? <span className="text-rose-500">*</span></label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)}
                  placeholder="e.g. black NATO for Rolex, price too high, wanted it under 15 KD…"
                  rows={2} className={`input resize-none ${errors.notes ? 'input-error' : ''}`} />
                {errors.notes && <p className="text-rose-500 text-xs mt-1">{errors.notes}</p>}
              </div>
            )}

            <button type="submit" disabled={submitting}
              className="btn-primary w-full flex items-center justify-center gap-2 py-4 text-base disabled:opacity-40">
              <CheckCircle className="w-5 h-5" />
              {submitting ? 'Saving…' : `Log ${caseLabel(entryType)}`}
            </button>
          </div>
        )}

      </form>
    </div>
  );
}
