import { useState, useEffect } from 'react';
import { format, addDays } from 'date-fns';
import { getSettings, getProductSuggestions, updateCase } from '../db';
import type { Case, CaseType, AppSettings } from '../types';

export function QuickEntryEdit({ case_, onDone, onCancel }: {
  case_: Case;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [products, setProducts] = useState<string[]>([]);

  const [staff, setStaff] = useState(case_.staff);
  const [caseType] = useState<CaseType>(case_.caseType);
  const [customerName, setCustomerName] = useState(case_.customerName || '');
  const [contact, setContact] = useState(case_.contact || '');
  const [product, setProduct] = useState(case_.product);
  const [amountKD, setAmountKD] = useState(case_.amountKD?.toString() || '');
  const [lostReason, setLostReason] = useState(case_.lostReason || '');
  const [followUpAction, setFollowUpAction] = useState(case_.followUpAction || '');
  const [promisedCallback, setPromisedCallback] = useState(
    case_.promisedCallback || format(addDays(new Date(), 1), 'yyyy-MM-dd')
  );
  const [channel, setChannel] = useState(case_.channel || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSettings().then(setSettings);
    getProductSuggestions().then(setProducts);
  }, []);

  async function handleSave() {
    if (!case_.id) return;
    setSaving(true);
    try {
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (staff !== case_.staff) changes.staff = { from: case_.staff, to: staff };
      if (product !== case_.product) changes.product = { from: case_.product, to: product };
      if (amountKD !== (case_.amountKD?.toString() || '')) changes.amountKD = { from: case_.amountKD, to: Number(amountKD) };

      await updateCase(case_.id, {
        staff,
        customerName: customerName || undefined,
        contact: contact || undefined,
        product,
        amountKD: amountKD ? Number(amountKD) : undefined,
        lostReason: lostReason || undefined,
        followUpAction: followUpAction || undefined,
        promisedCallback: caseType === 'Follow-up' ? promisedCallback : undefined,
        channel: channel || undefined,
        auditLog: [...case_.auditLog, { timestamp: new Date().toISOString(), action: 'edited', by: staff, changes }],
      });
      onDone();
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return null;

  return (
    <div className="space-y-4">
      <div className="bg-slate-50 rounded-xl px-3 py-2 text-xs text-slate-500">
        Case ID: <span className="font-mono font-medium">{case_.caseId}</span> · Type: <strong>{caseType}</strong>
      </div>

      <div>
        <label className="label">Staff</label>
        <select value={staff} onChange={e => setStaff(e.target.value)} className="input">
          {settings.staffRoster.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div>
        <label className="label">Product / Request</label>
        <input list="edit-products" value={product} onChange={e => setProduct(e.target.value)} className="input" />
        <datalist id="edit-products">{products.map(p => <option key={p} value={p} />)}</datalist>
      </div>

      {(caseType === 'Sale' || caseType === 'Follow-up') && (
        <>
          <div>
            <label className="label">Customer Name</label>
            <input value={customerName} onChange={e => setCustomerName(e.target.value)} className="input" />
          </div>
          <div>
            <label className="label">Contact</label>
            <input value={contact} onChange={e => setContact(e.target.value)} type="tel" className="input" />
          </div>
        </>
      )}

      {caseType === 'Sale' && (
        <div>
          <label className="label">Amount (KD)</label>
          <input value={amountKD} onChange={e => setAmountKD(e.target.value)} type="number" step="0.001" min="0" className="input" />
        </div>
      )}

      {caseType === 'Lost Sale' && (
        <div>
          <label className="label">Lost Reason</label>
          <select value={lostReason} onChange={e => setLostReason(e.target.value)} className="input">
            <option value="">— Select —</option>
            {settings.lostReasons.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      )}

      {caseType === 'Follow-up' && (
        <>
          <div>
            <label className="label">Follow-up Action</label>
            <select value={followUpAction} onChange={e => setFollowUpAction(e.target.value)} className="input">
              {settings.followUpActions.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Promised Callback</label>
            <input type="date" value={promisedCallback} onChange={e => setPromisedCallback(e.target.value)} className="input" />
          </div>
          <div>
            <label className="label">Channel</label>
            <select value={channel} onChange={e => setChannel(e.target.value)} className="input">
              {settings.channels.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </>
      )}

      <div className="flex gap-3 pt-2">
        <button onClick={onCancel} className="btn-ghost flex-1">Cancel</button>
        <button onClick={handleSave} disabled={saving} className="btn-primary flex-1">{saving ? 'Saving…' : 'Save Changes'}</button>
      </div>
    </div>
  );
}
