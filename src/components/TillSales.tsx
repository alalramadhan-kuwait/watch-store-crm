import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, Undo2 } from 'lucide-react';
import { getTillSales, type TillSale } from '../db';
import { formatKD } from '../utils/formatKD';
import { outletName } from '../shared/outlets';

const kuwaitTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kuwait' });

/**
 * The sales behind the till figure: time, receipt, who rang it, the customer, what was
 * bought and how it was paid. Opens from the Lightspeed line, so "1 sale" can be read.
 */
export function TillSalesList({ scope, count }: { scope: string | null; count: number }) {
  const [open, setOpen] = useState(false);
  const [sales, setSales] = useState<TillSale[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { setSales(null); setErr(null); }, [scope, count]);
  useEffect(() => {
    if (!open || sales) return;
    let live = true;
    getTillSales(scope).then(s => live && setSales(s)).catch(e => live && setErr(e.message));
    return () => { live = false; };
  }, [open, sales, scope]);

  if (count === 0) return null;
  const Chev = open ? ChevronUp : ChevronDown;
  return (
    <div className="-mt-3 mb-5">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="w-full flex items-center justify-center gap-1 py-2 text-xs font-semibold text-brand-700">
        {open ? 'Hide the sales' : count === 1 ? 'See the sale' : `See the ${count} sales`} <Chev className="w-4 h-4" />
      </button>
      {open && (
        <div className="space-y-2">
          {!sales && !err && <div className="flex justify-center py-4 text-slate-400"><Loader2 className="w-5 h-5 animate-spin" /></div>}
          {err && <p className="text-xs text-red-600 px-3">Could not load the sales: {err}</p>}
          {sales && sales.length === 0 && <p className="text-xs text-slate-500 px-3">Nothing to show for this login.</p>}
          {sales?.map(s => (
            <div key={s.id} className="rounded-xl border border-slate-100 bg-white px-3 py-2.5 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-semibold text-slate-800 tabular-nums">{kuwaitTime(s.at)}{s.receipt ? ` · #${s.receipt}` : ''}</span>
                <span className={`font-bold tabular-nums ${s.isReturn ? 'text-red-600' : 'text-slate-900'}`}>
                  {s.isReturn && <Undo2 className="inline w-3 h-3 mr-1" />}{formatKD(s.kd)} KD
                </span>
              </div>
              <p className="text-slate-500 mt-0.5">
                {[s.soldBy ? `Rung by ${s.soldBy}` : 'Rung by: not matched', s.scope ? outletName(s.scope) : null].filter(Boolean).join(' · ')}
              </p>
              <p className="text-slate-500">Customer: <span className="text-slate-800">{s.customer ?? 'not on file'}</span></p>
              {s.items.length > 0 && (
                <ul className="mt-1.5 space-y-0.5 border-t border-slate-100 pt-1.5">
                  {s.items.map((i, k) => (
                    <li key={k} className="flex justify-between gap-3 text-slate-700">
                      <span className="min-w-0">{i.qty !== 1 ? `${i.qty} × ` : ''}{i.name}</span>
                      <span className="tabular-nums shrink-0">{formatKD(i.kd)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {(s.payments.length > 0 || s.note) && (
                <p className="text-slate-500 mt-1.5">
                  {s.payments.length > 0 && <>Paid: {s.payments.join(', ')}</>}
                  {s.note && <span className="block italic">“{s.note}”</span>}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
