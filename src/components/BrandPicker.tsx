import { useState } from 'react';
import { Search, X, Check } from 'lucide-react';
import type { BrandCount } from '../db';
import { matchBrands, useSkeleton } from '../utils/brandMatch';

/**
 * Pick a brand to list the customers who bought it or asked about it. The counts are the
 * customers this login may see, so a salesperson's numbers are their own customers.
 */
export function BrandPicker({ brands, value, onPick, onClose }: {
  brands: BrandCount[] | null;
  value: string | null;
  onPick: (brand: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const skeleton = useSkeleton(query);
  const shown = brands ? matchBrands(brands, query, skeleton, 80) : [];

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose} />
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-white rounded-t-3xl shadow-2xl max-h-[88vh] flex flex-col lg:max-w-lg lg:mx-auto lg:bottom-6 lg:rounded-3xl">
        <div className="w-10 h-1 bg-slate-200 rounded-full mx-auto mt-3 mb-1 lg:hidden" />
        <div className="px-5 pt-2 pb-3 flex items-center justify-between">
          <h2 className="font-bold text-slate-900">Customers who bought…</h2>
          <button onClick={onClose} aria-label="Close" className="p-2 -mr-2 text-slate-400"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 pb-3">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Brand, in English or Arabic"
              className="input pl-9" inputMode="search" />
          </div>
        </div>
        <div className="px-5 pb-2 flex justify-between text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          <span>Brand</span><span>Bought · Asked</span>
        </div>
        <div className="flex-1 overflow-y-auto px-5 pb-6">
          {brands === null ? (
            <div className="space-y-2">{[0, 1, 2, 3, 4].map(i => <div key={i} className="h-10 rounded-xl bg-slate-100 animate-pulse" />)}</div>
          ) : shown.length === 0 ? (
            <p className="text-sm text-slate-400 py-6 text-center">{query ? 'No brand sounds like that.' : 'None of your customers has a brand on record yet.'}</p>
          ) : (
            <div className="card divide-y divide-slate-100 overflow-hidden">
              {shown.map(b => (
                <button key={b.brand} onClick={() => onPick(b.brand)}
                  className={`w-full flex items-center justify-between gap-3 px-4 py-3 text-left active:bg-slate-50 ${value === b.brand ? 'bg-emerald-50' : ''}`}>
                  <span className="text-sm font-semibold text-slate-900 flex items-center gap-1.5 min-w-0">
                    <span className="truncate">{b.brand}</span>
                    {value === b.brand && <Check className="w-4 h-4 text-emerald-600 shrink-0" />}
                  </span>
                  <span className="text-xs text-slate-500 tabular-nums shrink-0">
                    {b.bought.toLocaleString()}{b.asked > 0 && <span className="text-amber-600"> · {b.asked}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
