import { useEffect, useState } from 'react';
import { ChevronRight, Undo2 } from 'lucide-react';
import { getTillSales, type LightspeedToday, type TillSale } from '../db';
import { formatKD } from '../utils/formatKD';
import { outletName } from '../shared/outlets';
import { activeChannels } from '../utils/channels';
import { Modal } from './shared/Modal';

const kuwaitTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kuwait' });
/** "Time Keeper - Avenues" -> "Avenues": the card has no room for the company name twice. */
const shopName = (code: string) => outletName(code).replace(/^Time Keeper\s*-\s*/i, '');
const STALE_MS = 30 * 60_000;

/**
 * "Tissot · PRX" and how many other lines: the dearest line, brand first, then the model. The till names are long
 * ("West End - Classic 37 - Sunray Ruthenium Dial - 6828.10.3034Y") and a card has one line.
 */
export function productLine(items: TillSale['items']): { text: string; more: number } | null {
  /* Lightspeed leaves some lines without a name (a custom item, a deleted product). Headline the dearest named one. */
  const named = items.filter(i => i.name);
  if (!named.length) return null;
  const top = named.reduce((a, b) => (b.kd > a.kd ? b : a));
  const parts = (top.name ?? '').split(/\s+-\s+/).map(p => p.trim()).filter(Boolean);
  const brand = top.brand?.trim() || null;
  if (brand && parts[0]?.toLowerCase() === brand.toLowerCase()) parts.shift();
  const head = brand ? [brand, parts[0]] : parts.slice(0, 2);
  return { text: head.filter(Boolean).join(' · '), more: items.length - 1 };
}

/**
 * The newest sale the till rang up today. The whole card is one control: it opens the day's
 * sales in a sheet. The tiles above already say how many and how much, so this says what.
 *
 * Owner and manager also get, under it, the Online and WhatsApp orders the shop tiles leave
 * out. Choosing a shop never shows them, so say where they went.
 */
export function LatestSaleCard({ till, overseer }: { till: LightspeedToday; overseer: boolean }) {
  const [sales, setSales] = useState<TillSale[] | null>(null);
  const [open, setOpen] = useState(false);
  const scope = till.scope;

  useEffect(() => {
    if (till.sales === 0) { setSales([]); return; }
    let live = true;
    getTillSales(scope).then(s => live && setSales(s)).catch(() => live && setSales([]));
    return () => { live = false; };
  }, [scope, till.sales, till.as_of]);

  const others = overseer ? activeChannels(till.channels) : [];
  const notCounted = others.length > 0 && (
    <p className="mt-2 px-1 text-xs text-slate-500">
      Not counted above: {others.map(c => `${c.name.replace(/^Time Keeper\s+/i, '')} ${c.sales}`).join(' · ')}
    </p>
  );

  const real = (sales ?? []).filter(s => !s.isReturn);
  const latest = real[0];
  if (!latest) return notCounted ? <div className="mb-5">{notCounted}</div> : null;

  const stale = !!till.as_of && Date.now() - new Date(till.as_of).getTime() > STALE_MS;
  const updated = till.as_of ? kuwaitTime(till.as_of) : null;
  const product = productLine(latest.items);
  const when = [`${formatKD(latest.kd)} KD`, kuwaitTime(latest.at), !scope && latest.scope ? shopName(latest.scope) : null].filter(Boolean).join(' · ');

  return (
    <div className="mb-5">
      <button type="button" onClick={() => setOpen(true)}
        className="w-full text-left rounded-2xl bg-white border border-slate-100 px-4 py-3 active:bg-slate-50">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Latest sale</p>
            {product && (
              <p className="mt-0.5 flex gap-1 font-semibold text-slate-900">
                <span className="truncate">{product.text}</span>
                {product.more > 0 && <span className="shrink-0">+{product.more}</span>}
              </p>
            )}
            <p className={`tabular-nums ${product ? 'text-sm text-slate-700' : 'mt-0.5 font-semibold text-slate-900'}`}>{when}</p>
            {latest.soldBy && <p className="text-sm text-slate-500">Sold by {latest.soldBy}</p>}
          </div>
          {real.length > 1 && <span className="shrink-0 text-xs text-slate-400 pt-0.5">+{real.length - 1} earlier today</span>}
        </div>
        {updated && (
          <p className={`mt-2 flex items-center justify-between text-xs ${stale ? 'font-semibold text-amber-600' : 'text-slate-400'}`}>
            <span>{stale ? `Till data is behind. Updated ${updated}` : `Updated ${updated}`}</span>
            <ChevronRight className="w-4 h-4" />
          </p>
        )}
      </button>
      {notCounted}
      <Modal open={open} onClose={() => setOpen(false)} title="Today's sales">
        <div className="space-y-2.5">
          {(sales ?? []).map(s => (
            <div key={s.id} className="rounded-xl border border-slate-100 px-3 py-2.5 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-semibold text-slate-800 tabular-nums">{kuwaitTime(s.at)}{s.receipt ? ` · #${s.receipt}` : ''}</span>
                <span className={`font-bold tabular-nums ${s.isReturn ? 'text-red-600' : 'text-slate-900'}`}>
                  {s.isReturn && <Undo2 className="inline w-3.5 h-3.5 mr-1" />}{formatKD(s.kd)} KD
                </span>
              </div>
              <p className="text-slate-500 text-xs mt-0.5">
                {[s.soldBy ? `Sold by ${s.soldBy}` : null, s.scope ? shopName(s.scope) : null].filter(Boolean).join(' · ')}
              </p>
              <p className="text-slate-500 text-xs">Customer: <span className="text-slate-800">{s.customer ?? 'not on file'}</span></p>
              {s.items.length > 0 && (
                <ul className="mt-1.5 space-y-0.5 border-t border-slate-100 pt-1.5 text-xs">
                  {s.items.map((i, k) => (
                    <li key={k} className="flex justify-between gap-3 text-slate-700">
                      <span className="min-w-0">{i.qty !== 1 ? `${i.qty} × ` : ''}{i.name ?? <span className="text-slate-400">Item without a name in Lightspeed</span>}</span>
                      <span className="tabular-nums shrink-0">{formatKD(i.kd)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {(s.payments.length > 0 || s.note) && (
                <p className="text-slate-500 text-xs mt-1.5">
                  {s.payments.length > 0 && <>Paid: {s.payments.join(', ')}</>}
                  {s.note && <span className="block italic">“{s.note}”</span>}
                </p>
              )}
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
