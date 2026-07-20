import { useState, useEffect } from 'react';
import { format, addDays } from 'date-fns';
import { Plus, Trash2 } from 'lucide-react';
import { getSettings, updateCase, updateSaleItems } from '../db';
import type { Case, CaseType, AppSettings, ProductType } from '../types';
import { PRODUCT_TYPES } from '../types';
import { formatKD } from '../utils/formatKD';

const STRAP_WIDTHS = ['18mm', '20mm', '22mm', '24mm', 'Other'] as const;

// ── Sale item draft (mirrors QuickEntry) ──────────────────────────────────────

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

// ── Main component ────────────────────────────────────────────────────────────

export function QuickEntryEdit({ case_, onDone, onCancel }: {
  case_: Case;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(null);

  const [staff, setStaff] = useState(case_.staff);
  const [caseType] = useState<CaseType>(case_.caseType);
  const [customerName, setCustomerName] = useState(case_.customerName || '');
  const [contact, setContact] = useState(case_.contact || '');
  const [product, setProduct] = useState(case_.product);
  const [amountKD, setAmountKD] = useState(case_.amountKD?.toString() || '');
  const [lostReason, setLostReason] = useState(case_.lostReason || '');
  const [followUpAction, setFollowUpAction] = useState(case_.followUpAction || '');
  // For Lost Sale strap: detect pre-selected width from existing product value
  const [strapWidth, setStrapWidth] = useState(() => {
    if (case_.caseType === 'Lost Sale' && case_.productType === 'Strap') {
      const match = STRAP_WIDTHS.find(w => case_.product?.includes(w));
      return match ?? '';
    }
    return '';
  });
  const [promisedCallback, setPromisedCallback] = useState(
    case_.promisedCallback || format(addDays(new Date(), 1), 'yyyy-MM-dd')
  );
  const [channel, setChannel] = useState(case_.channel || '');
  const [notes, setNotes] = useState(case_.notes || '');
  const [saving, setSaving] = useState(false);

  // Sale items state
  const [saleItems, setSaleItems] = useState<SaleItemDraft[]>(() => {
    if (caseType === 'Sale') {
      if (case_.saleItems && case_.saleItems.length > 0) {
        return case_.saleItems.map(item => ({
          brand: item.brand || '',
          productType: item.productType || 'Watch',
          product: item.product || '',
          quantity: item.quantity.toString(),
          amountKD: item.amountKD.toString(),
        }));
      }
      // Fallback for legacy single-item case
      return [{
        brand: case_.brand || '',
        productType: case_.productType || 'Watch',
        product: case_.product || '',
        quantity: '1',
        amountKD: case_.amountKD?.toString() || '',
      }];
    }
    return [];
  });

  useEffect(() => {
    getSettings().then(setSettings);
  }, []);

  function updateItem(index: number, patch: Partial<SaleItemDraft>) {
    setSaleItems(prev => prev.map((item, i) => i === index ? { ...item, ...patch } : item));
  }

  function removeItem(index: number) {
    setSaleItems(prev => prev.filter((_, i) => i !== index));
  }

  const saleTotal = saleItems.reduce((sum, item) => {
    const v = parseFloat(item.amountKD);
    return sum + (isNaN(v) ? 0 : v);
  }, 0);

  async function handleSave() {
    if (!case_.id) return;
    setSaving(true);
    try {
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (staff !== case_.staff) changes.staff = { from: case_.staff, to: staff };

      if (caseType === 'Sale') {
        const totalKD = saleTotal;
        const firstItem = saleItems[0];
        const newProduct = saleItems.length > 1
          ? `${firstItem.brand || firstItem.productType} +${saleItems.length - 1} more`
          : (firstItem.product || firstItem.brand || firstItem.productType || 'Sale');

        if (totalKD !== case_.amountKD) changes.amountKD = { from: case_.amountKD, to: totalKD };

        await updateCase(case_.id, {
          staff,
          customerName: customerName || undefined,
          contact: contact || undefined,
          brand: firstItem.brand || undefined,
          productType: firstItem.productType || undefined,
          product: newProduct,
          amountKD: totalKD,
          notes: notes.trim() || undefined,
          auditLog: [...case_.auditLog, { timestamp: new Date().toISOString(), action: 'edited', by: staff, changes }],
        });

        await updateSaleItems(case_.id, saleItems.map((item, i) => ({
          brand: item.brand || undefined,
          productType: item.productType || undefined,
          product: item.product.trim() || undefined,
          quantity: parseInt(item.quantity) || 1,
          amountKD: parseFloat(item.amountKD) || 0,
          sortOrder: i,
        })));

      } else {
        // For Lost Sale straps, combine strapWidth into the product field
        const finalProduct = caseType === 'Lost Sale' && case_.productType === 'Strap' && strapWidth
          ? [product.replace(/\s*—\s*(18mm|20mm|22mm|24mm|Other)/g, '').trim(), strapWidth].filter(Boolean).join(' — ')
          : product;

        if (finalProduct !== case_.product) changes.product = { from: case_.product, to: finalProduct };
        if (amountKD !== (case_.amountKD?.toString() || '')) changes.amountKD = { from: case_.amountKD, to: Number(amountKD) };

        await updateCase(case_.id, {
          staff,
          customerName: customerName || undefined,
          contact: contact || undefined,
          product: finalProduct,
          amountKD: amountKD ? Number(amountKD) : undefined,
          lostReason: lostReason || undefined,
          followUpAction: followUpAction || undefined,
          promisedCallback: caseType === 'Follow-up' ? promisedCallback : undefined,
          channel: channel || undefined,
          notes: notes.trim() || undefined,
          auditLog: [...case_.auditLog, { timestamp: new Date().toISOString(), action: 'edited', by: staff, changes }],
        });
      }

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

      {/* ── Sale items editor ── */}
      {caseType === 'Sale' && (
        <div className="space-y-3">
          <label className="label">Sale Items</label>

          {saleItems.map((item, i) => (
            <div key={i} className="bg-slate-50 rounded-2xl p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Item {i + 1}</span>
                {saleItems.length > 1 && (
                  <button type="button" onClick={() => removeItem(i)}
                    className="p-1 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 transition-colors">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <div>
                <label className="label text-xs">Brand</label>
                <input
                  value={item.brand}
                  onChange={e => updateItem(i, { brand: e.target.value })}
                  placeholder="Brand name"
                  className="input text-sm py-2"
                />
              </div>

              <div>
                <label className="label text-xs">Product Type</label>
                <div className="grid grid-cols-3 gap-1.5">
                  {PRODUCT_TYPES.map(pt => (
                    <button key={pt} type="button"
                      onClick={() => updateItem(i, { productType: pt })}
                      className={`quick-btn text-center text-xs py-1.5 ${item.productType === pt ? 'quick-btn-active' : ''}`}>
                      {pt}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="label text-xs">Model / Reference</label>
                <input
                  value={item.product}
                  onChange={e => updateItem(i, { product: e.target.value })}
                  placeholder="Optional"
                  className="input text-sm py-2"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="label text-xs">Qty</label>
                  <input value={item.quantity} onChange={e => updateItem(i, { quantity: e.target.value })}
                    type="number" min="1" step="1" className="input text-sm py-2" />
                </div>
                <div>
                  <label className="label text-xs">Line Total (KD)</label>
                  <div className="relative">
                    <input value={item.amountKD} onChange={e => updateItem(i, { amountKD: e.target.value })}
                      type="number" step="0.001" min="0" placeholder="0.000"
                      className="input text-sm py-2 pr-10" />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">KD</span>
                  </div>
                </div>
              </div>
            </div>
          ))}

          <button type="button"
            onClick={() => setSaleItems(prev => [...prev, blankItem()])}
            className="flex items-center gap-1.5 text-sm text-brand-700 font-medium hover:text-brand-800 transition-colors">
            <Plus className="w-4 h-4" /> Add another item
          </button>

          {saleItems.length > 1 && (
            <div className="flex items-center justify-between px-3 py-2 bg-emerald-50 rounded-xl border border-emerald-100">
              <span className="text-sm font-semibold text-emerald-800">Transaction Total</span>
              <span className="text-sm font-bold text-emerald-700">{formatKD(saleTotal)} KD</span>
            </div>
          )}

          <div>
            <label className="label">Customer Name</label>
            <input value={customerName} onChange={e => setCustomerName(e.target.value)} className="input" />
          </div>
          <div>
            <label className="label">Contact</label>
            <input value={contact} onChange={e => setContact(e.target.value)} type="tel" className="input" />
          </div>
        </div>
      )}

      {/* ── Non-sale fields ── */}
      {caseType !== 'Sale' && (
        <>
          {/* Customer Requirement — shown prominently for Follow-up */}
          {caseType === 'Follow-up' && (
            <div>
              <label className="label">Customer Requirement</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="What does the customer want? What was discussed? What's the next step?"
                rows={3} className="input resize-none" />
            </div>
          )}

          <div>
            <label className="label">
              {caseType === 'Lost Sale' ? 'Model / Item Details' : 'Product / Request'}
            </label>
            <input value={product} onChange={e => setProduct(e.target.value)}
              placeholder={caseType === 'Lost Sale'
                ? (case_.productType === 'Strap' ? 'e.g. 20mm black leather, for Submariner' : 'e.g. Seamaster 41mm blue dial')
                : ''}
              className="input" />
          </div>

          {/* Strap Width — Lost Sale strap edits */}
          {caseType === 'Lost Sale' && case_.productType === 'Strap' && (
            <div>
              <label className="label">Strap Width</label>
              <div className="flex flex-wrap gap-2">
                {STRAP_WIDTHS.map(size => (
                  <button key={size} type="button"
                    onClick={() => setStrapWidth(prev => prev === size ? '' : size)}
                    className={`quick-btn ${strapWidth === size ? 'quick-btn-active' : ''}`}>
                    {size}
                  </button>
                ))}
              </div>
            </div>
          )}

          {(caseType === 'Follow-up') && (
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
                <label className="label">Amount (KD)</label>
                <input value={amountKD} onChange={e => setAmountKD(e.target.value)} type="number" step="0.001" min="0" className="input" />
              </div>
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
        </>
      )}

      {/* Notes — optional for non-Follow-up types (Follow-up uses Customer Requirement above) */}
      {caseType !== 'Follow-up' && (
        <div>
          <label className="label">
            {caseType === 'Lost Sale' ? 'Details / What did they want?' : 'Notes'}
            <span className="text-slate-400 font-normal ml-1">(optional)</span>
          </label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)}
            placeholder={caseType === 'Lost Sale'
              ? 'e.g. black NATO for Rolex, price too high, wanted it under 15 KD…'
              : 'Any additional details…'}
            rows={2} className="input resize-none" />
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <button onClick={onCancel} className="btn-ghost flex-1">Cancel</button>
        <button onClick={handleSave} disabled={saving} className="btn-primary flex-1">{saving ? 'Saving…' : 'Save Changes'}</button>
      </div>
    </div>
  );
}
