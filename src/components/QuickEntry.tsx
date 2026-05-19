import { useState, useEffect, useRef } from 'react';
import { format, addDays } from 'date-fns';
import { ShoppingBag, Clock, TrendingDown, CheckCircle } from 'lucide-react';
import { getSettings, getProductSuggestions, insertCase, nextCaseId } from '../db';
import { useAppStore } from '../store';
import type { CaseType, Case, AppSettings } from '../types';

export function QuickEntry() {
  const { lastStaff, setLastStaff, showToast } = useAppStore();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [products, setProducts] = useState<string[]>([]);

  const [staff, setStaff] = useState(lastStaff || '');
  const [caseType, setCaseType] = useState<CaseType | ''>('');
  const [customerName, setCustomerName] = useState('');
  const [contact, setContact] = useState('');
  const [product, setProduct] = useState('');
  const [amountKD, setAmountKD] = useState('');
  const [lostReason, setLostReason] = useState('');
  const [followUpAction, setFollowUpAction] = useState('');
  const [promisedCallback, setPromisedCallback] = useState(
    format(addDays(new Date(), 1), 'yyyy-MM-dd')
  );
  const [channel, setChannel] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getSettings().then(s => {
      setSettings(s);
      if (!staff && s.staffRoster[0]) setStaff(s.staffRoster[0]);
    });
    getProductSuggestions().then(setProducts);
  }, []);

  function resetForm(keepStaff = true) {
    setCaseType('');
    setCustomerName('');
    setContact('');
    setProduct('');
    setAmountKD('');
    setLostReason('');
    setFollowUpAction('');
    setPromisedCallback(format(addDays(new Date(), 1), 'yyyy-MM-dd'));
    setChannel('');
    setErrors({});
    if (!keepStaff) setStaff('');
  }

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!staff) errs.staff = 'Required';
    if (!caseType) errs.caseType = 'Pick a case type';
    if (!product.trim()) errs.product = 'Required';
    if (caseType === 'Sale') {
      if (!amountKD || isNaN(Number(amountKD)) || Number(amountKD) <= 0) errs.amountKD = 'Enter a valid amount';
    }
    if (caseType === 'Follow-up') {
      if (!customerName.trim()) errs.customerName = 'Required for follow-ups';
      if (!contact.trim()) errs.contact = 'Required for follow-ups';
      if (!promisedCallback) errs.promisedCallback = 'Required';
      if (!followUpAction) errs.followUpAction = 'Required';
      if (!channel) errs.channel = 'Required';
    }
    if (caseType === 'Lost Sale') {
      if (!lostReason) errs.lostReason = 'Required';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      const now = new Date();
      const dateStr = format(now, 'yyyy-MM-dd');
      const caseId = await nextCaseId(dateStr);
      const newCase: Omit<Case, 'id'> = {
        caseId,
        dateLogged: dateStr,
        timeLogged: format(now, 'HH:mm'),
        staff,
        customerName: customerName || undefined,
        contact: contact || undefined,
        caseType: caseType as CaseType,
        product: product.trim(),
        amountKD: amountKD ? Number(amountKD) : undefined,
        lostReason: lostReason || undefined,
        followUpAction: followUpAction || undefined,
        promisedCallback: caseType === 'Follow-up' ? promisedCallback : undefined,
        channel: channel || undefined,
        status: 'Open',
        dayLocked: false,
        auditLog: [{ timestamp: now.toISOString(), action: 'created', by: staff }],
      };

      await insertCase(newCase);
      setLastStaff(staff);
      getProductSuggestions().then(setProducts);
      showToast('Logged. Next customer ready.', 'success');
      resetForm(true);
      formRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      showToast('Failed to save. Check connection.', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (!settings) return <div className="flex-1 flex items-center justify-center text-slate-400">Loading…</div>;

  return (
    <div ref={formRef} className="px-4 pt-6 pb-32 max-w-lg mx-auto scroll-area">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Quick Entry</h1>
        <p className="text-slate-500 text-sm mt-0.5">{format(new Date(), 'EEEE, d MMMM yyyy')}</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Staff selector */}
        <div>
          <label className="label">Staff <span className="text-rose-500">*</span></label>
          <select
            value={staff}
            onChange={e => setStaff(e.target.value)}
            className={`input ${errors.staff ? 'input-error' : ''}`}
          >
            <option value="">— Select staff —</option>
            {settings.staffRoster.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          {errors.staff && <p className="text-rose-500 text-xs mt-1">{errors.staff}</p>}
        </div>

        {/* Case type buttons */}
        <div>
          <label className="label">Case Type <span className="text-rose-500">*</span></label>
          <div className="flex gap-3">
            <button type="button" onClick={() => setCaseType('Sale')}
              className={`type-btn ${caseType === 'Sale' ? 'type-btn-sale-active' : 'type-btn-sale'}`}>
              <ShoppingBag className="w-6 h-6" /><span>Sale</span>
            </button>
            <button type="button" onClick={() => setCaseType('Follow-up')}
              className={`type-btn ${caseType === 'Follow-up' ? 'type-btn-followup-active' : 'type-btn-followup'}`}>
              <Clock className="w-6 h-6" /><span>Follow-up</span>
            </button>
            <button type="button" onClick={() => setCaseType('Lost Sale')}
              className={`type-btn ${caseType === 'Lost Sale' ? 'type-btn-lost-active' : 'type-btn-lost'}`}>
              <TrendingDown className="w-6 h-6" /><span>Lost Sale</span>
            </button>
          </div>
          {errors.caseType && <p className="text-rose-500 text-xs mt-1">{errors.caseType}</p>}
        </div>

        {/* Product */}
        <div>
          <label className="label">Product / Request <span className="text-rose-500">*</span></label>
          <input
            list="product-suggestions"
            value={product}
            onChange={e => setProduct(e.target.value)}
            placeholder="e.g. Citizen Zenshin Navy Blue"
            className={`input ${errors.product ? 'input-error' : ''}`}
            autoComplete="off"
          />
          <datalist id="product-suggestions">
            {products.map(p => <option key={p} value={p} />)}
          </datalist>
          {errors.product && <p className="text-rose-500 text-xs mt-1">{errors.product}</p>}
        </div>

        {/* Customer name */}
        {(caseType === 'Sale' || caseType === 'Follow-up') && (
          <div>
            <label className="label">
              Customer Name {caseType === 'Follow-up' && <span className="text-rose-500">*</span>}
              {caseType === 'Sale' && <span className="text-slate-400 font-normal ml-1">(optional)</span>}
            </label>
            <input value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="Full name"
              className={`input ${errors.customerName ? 'input-error' : ''}`} />
            {errors.customerName && <p className="text-rose-500 text-xs mt-1">{errors.customerName}</p>}
          </div>
        )}

        {/* Contact */}
        {(caseType === 'Sale' || caseType === 'Follow-up') && (
          <div>
            <label className="label">
              Contact {caseType === 'Follow-up' && <span className="text-rose-500">*</span>}
              {caseType === 'Sale' && <span className="text-slate-400 font-normal ml-1">(optional)</span>}
            </label>
            <input value={contact} onChange={e => setContact(e.target.value)} placeholder="Phone / WhatsApp"
              type="tel" inputMode="tel" className={`input ${errors.contact ? 'input-error' : ''}`} />
            {errors.contact && <p className="text-rose-500 text-xs mt-1">{errors.contact}</p>}
          </div>
        )}

        {/* Sale amount */}
        {caseType === 'Sale' && (
          <div>
            <label className="label">Amount (KD) <span className="text-rose-500">*</span></label>
            <div className="relative">
              <input value={amountKD} onChange={e => setAmountKD(e.target.value)} placeholder="0.000"
                type="number" inputMode="decimal" step="0.001" min="0"
                className={`input pr-12 ${errors.amountKD ? 'input-error' : ''}`} />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 font-medium text-sm">KD</span>
            </div>
            {errors.amountKD && <p className="text-rose-500 text-xs mt-1">{errors.amountKD}</p>}
          </div>
        )}

        {/* Lost reason */}
        {caseType === 'Lost Sale' && (
          <div>
            <label className="label">Lost Reason <span className="text-rose-500">*</span></label>
            <select value={lostReason} onChange={e => setLostReason(e.target.value)}
              className={`input ${errors.lostReason ? 'input-error' : ''}`}>
              <option value="">— Select reason —</option>
              {settings.lostReasons.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            {errors.lostReason && <p className="text-rose-500 text-xs mt-1">{errors.lostReason}</p>}
          </div>
        )}

        {/* Follow-up fields */}
        {caseType === 'Follow-up' && (
          <>
            <div>
              <label className="label">Follow-up Action <span className="text-rose-500">*</span></label>
              <select value={followUpAction} onChange={e => setFollowUpAction(e.target.value)}
                className={`input ${errors.followUpAction ? 'input-error' : ''}`}>
                <option value="">— Select action —</option>
                {settings.followUpActions.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              {errors.followUpAction && <p className="text-rose-500 text-xs mt-1">{errors.followUpAction}</p>}
            </div>
            <div>
              <label className="label">Promised Callback <span className="text-rose-500">*</span></label>
              <input type="date" value={promisedCallback} onChange={e => setPromisedCallback(e.target.value)}
                min={format(new Date(), 'yyyy-MM-dd')}
                className={`input ${errors.promisedCallback ? 'input-error' : ''}`} />
              {errors.promisedCallback && <p className="text-rose-500 text-xs mt-1">{errors.promisedCallback}</p>}
            </div>
            <div>
              <label className="label">Channel <span className="text-rose-500">*</span></label>
              <select value={channel} onChange={e => setChannel(e.target.value)}
                className={`input ${errors.channel ? 'input-error' : ''}`}>
                <option value="">— How to reach them —</option>
                {settings.channels.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              {errors.channel && <p className="text-rose-500 text-xs mt-1">{errors.channel}</p>}
            </div>
          </>
        )}

        <div className="pt-2 pb-4">
          <button type="submit" disabled={submitting}
            className="btn-primary w-full flex items-center justify-center gap-2 py-4 text-base">
            <CheckCircle className="w-5 h-5" />
            {submitting ? 'Saving…' : 'Log Case'}
          </button>
        </div>
      </form>
    </div>
  );
}
