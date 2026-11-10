import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import {
  Search, Star, Phone, MessageCircle, PlusCircle, ChevronRight, ChevronLeft, Pencil, Cake, Gift,
  ShoppingBag, Users, Trash2, Plus, ShieldAlert, Clock, Tag, X, Check,
} from 'lucide-react';
import { useAuth, canSeePerformance } from '../context/AuthContext';
import { useAppStore } from '../store';
import {
  getCustomerList, getCustomerProfile, updateCustomerDetails, updateCustomerPhone, assignResponsible,
  addOccasion, removeOccasion, getRosterEmployees, getBrandCounts, getBrandCustomers,
  type CustomerListRow, type CustomerProfile, type ProfileVisit, type ProfilePurchase, type ProfileHandoff,
  type BrandCount, type BrandCustomer,
} from '../db';
import { formatKD } from '../utils/formatKD';
import { caseLabel } from '../shared/caseLabels';
import { displayPhone } from '../shared/phoneRules';
import { groupOf, GROUP_LABEL, lastSeen, type CustomerGroup } from '../shared/customerTiers';
import { Modal } from './shared/Modal';
import { CaseTypeBadge } from './shared/Badge';
import { WhatsAppSheet } from './WhatsAppSheet';
import { BrandPicker } from './BrandPicker';
import { matchBrands, useSkeleton } from '../utils/brandMatch';
import type { TemplateKey } from '../shared/messageRules';
import type { CaseType } from '../types';

type Filter = 'top' | 'win_back' | 'new' | 'all' | 'mine' | 'followups' | 'occasions';

const day = (iso: string | null | undefined) => iso ? format(new Date(iso), 'd MMM yyyy') : '—';
const ago = (iso: string | null) => {
  if (!iso) return null;
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : d < 365 ? `${Math.floor(d / 30)} mo ago` : `${Math.floor(d / 365)} yr ago`;
};
/** Within the last `days` days. */
const within = (iso: string | null | undefined, days: number) => !!iso && Date.now() - new Date(iso).getTime() < days * 86400000;
/** A week is how long a customer is left alone after a brand message. */
const MESSAGE_REST_DAYS = 7;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Customers.
 *
 * Who this login may see is the database's decision (customer_list runs
 * under the caller's rules), so a salesperson opens this and sees their own
 * customers, a manager the shop's, the owner everyone. There is no "all
 * customers" to leak: a number you have never served is not in the list,
 * and looking it up on the entry form only says "recognised".
 *
 * The shared shop phone is nobody, so it sees no customers here. That is
 * the rule, not a gap: a profile with purchase history is shown to the
 * person who earned it, on their own login.
 */
export function CRM() {
  const { role, salesName } = useAuth();
  const { showToast } = useAppStore();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const shared = role === 'staff';
  const perf = canSeePerformance(role);

  const [rows, setRows] = useState<CustomerListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  /* Until the person picks one, a long list opens on the customers worth the day's
     attention and a short one (a salesperson's own) on everyone. */
  const [picked, setPicked] = useState<Filter | null>(params.get('tab') === 'occasions' ? 'occasions' : null);
  const openId = params.get('customer');

  /* Customers by brand: the brand lives in the address, so coming back from a customer's
     page keeps the list as it was. */
  const brand = params.get('brand');
  const [brands, setBrands] = useState<BrandCount[] | null>(null);
  const [brandMode, setBrandMode] = useState<'bought' | 'asked'>('bought');
  const [brandWhen, setBrandWhen] = useState<'any' | 'year' | 'older'>('any');
  const [brandRows, setBrandRows] = useState<Map<string, BrandCustomer> | null>(null);
  const [picking, setPicking] = useState(false);
  const [waRow, setWaRow] = useState<CustomerListRow | null>(null);
  const [sentNow, setSentNow] = useState<Set<string>>(new Set());
  const searchSkeleton = useSkeleton(search);

  const load = useCallback(async () => {
    try { setRows(await getCustomerList()); }
    catch (err) { showToast(err instanceof Error ? err.message : 'Could not load customers.', 'error'); }
    finally { setLoading(false); }
  }, [showToast]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (shared) return;
    void getBrandCounts().then(setBrands).catch(() => setBrands([]));
  }, [shared]);

  useEffect(() => {
    if (!brand) { setBrandRows(null); return; }
    let live = true;
    setBrandRows(null);
    getBrandCustomers(brand)
      .then(list => { if (live) setBrandRows(new Map(list.map(b => [b.customerId, b]))); })
      .catch(err => { if (live) { setBrandRows(new Map()); showToast(err instanceof Error ? err.message : 'Could not load that brand.', 'error'); } });
    return () => { live = false; };
  }, [brand, showToast]);

  const setBrand = (b: string | null) => {
    const next = new URLSearchParams(params);
    if (b) next.set('brand', b); else next.delete('brand');
    setParams(next, { replace: true });
    setSentNow(new Set());
    if (b) { setPicked('all'); setSearch(''); }
  };

  const inBrand = useCallback((id: string) => {
    const b = brandRows?.get(id);
    if (!b) return false;
    if (brandMode === 'asked') return !!b.askedAt;
    if (!b.lastBought) return false;
    if (brandWhen === 'year') return within(b.lastBought, 365);
    if (brandWhen === 'older') return !within(b.lastBought, 365);
    return true;
  }, [brandRows, brandMode, brandWhen]);

  const messaged = useCallback((id: string) =>
    sentNow.has(id) || within(brandRows?.get(id)?.lastWhatsApp, MESSAGE_REST_DAYS), [sentNow, brandRows]);

  const everyoneMine = useMemo(() => rows.length > 0 && rows.every(r => r.mine), [rows]);
  const filter: Filter = picked ?? (rows.length > 300 ? 'top' : 'all');
  const setFilter = (f: Filter) => setPicked(f);

  const groups = useMemo(() => {
    const now = new Date();
    return new Map<string, CustomerGroup>(rows.map(r => [r.id, groupOf(r, now)]));
  }, [rows]);
  const counts = useMemo(() => {
    const n = { top: 0, win_back: 0, new: 0 };
    for (const g of groups.values()) if (g !== 'other') n[g]++;
    return n;
  }, [groups]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    return rows
      .filter(r => {
        /* A search looks at everybody: typing a name must not depend on which
           group the list happened to open on. */
        if (!q) {
          if (brand && !inBrand(r.id)) return false;
          if (filter === 'top' || filter === 'win_back' || filter === 'new') { if (groups.get(r.id) !== filter) return false; }
          if (filter === 'mine' && !r.mine) return false;
          if (filter === 'followups' && r.openFollowups === 0) return false;
          if (filter === 'occasions' && (r.nextOccasionDays == null || r.nextOccasionDays > 30)) return false;
          return true;
        }
        return r.name.toLowerCase().includes(q)
          || (digits.length >= 3 && ((r.phoneE164 ?? '').includes(digits) || r.contact.replace(/\D/g, '').includes(digits)));
      })
      .sort((a, b) => {
        if (filter === 'occasions') return (a.nextOccasionDays ?? 999) - (b.nextOccasionDays ?? 999);
        if (!search && brand && brandRows) {
          const ba = brandRows.get(a.id), bb = brandRows.get(b.id);
          if (brandMode === 'asked') return (bb?.askedAt ?? '').localeCompare(ba?.askedAt ?? '') || a.name.localeCompare(b.name);
          return (bb?.kd ?? 0) - (ba?.kd ?? 0) || a.name.localeCompare(b.name);
        }
        // The ones that matter most come first: by what they have spent, or for the new, how recently.
        if (!search && (filter === 'top' || filter === 'win_back')) return b.purchasesKD - a.purchasesKD || a.name.localeCompare(b.name);
        const la = lastSeen(a) ?? '';
        const lb = lastSeen(b) ?? '';
        return lb.localeCompare(la) || a.name.localeCompare(b.name);
      });
  }, [rows, search, filter, groups, brand, brandRows, brandMode, inBrand]);

  const openCustomer = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('customer', id); else next.delete('customer');
    setParams(next, { replace: !id });
  };

  if (shared) {
    return (
      <div className="px-4 pt-6 pb-32 max-w-lg mx-auto">
        <h1 className="text-2xl font-bold text-slate-900 mb-4">Customers</h1>
        <div className="card p-5 text-sm text-slate-600 space-y-2">
          <div className="flex items-center gap-2 text-slate-800 font-semibold"><ShieldAlert className="w-4 h-4 text-amber-500" /> Sign in as yourself to see your customers</div>
          <p>The shared shop phone is not a person, so it has no customers of its own. A customer's page — their visits, what they bought, their birthday — is shown to the salesperson who knows them, on their own login.</p>
          <p>From this phone you can still log a visit: typing a number tells you whether the customer is already known.</p>
        </div>
      </div>
    );
  }

  if (openId) {
    return <CustomerPage id={openId} onBack={() => openCustomer(null)} onChanged={load} canAssign={perf}
      openWith={params.get('wa') as TemplateKey | null} />;
  }

  const brandActive = !!brand && !search;
  const brandTotalKD = brandActive && brandRows && brandMode === 'bought'
    ? filtered.reduce((t, r) => t + (brandRows.get(r.id)?.kd ?? 0), 0) : 0;
  const reachable = brandActive ? filtered.filter(r => !!r.phoneE164) : [];
  const messagedCount = reachable.filter(r => messaged(r.id)).length;
  const nextUp = reachable.find(r => !messaged(r.id)) ?? null;
  const brandSuggestions = !brand && brands && search.trim().length >= 2
    ? matchBrands(brands, search, searchSkeleton, 3) : [];

  const chips: { key: Filter; label: string; show: boolean }[] = [
    { key: 'top', label: `Top ${counts.top.toLocaleString()}`, show: rows.length > 300 },
    { key: 'win_back', label: `Win back ${counts.win_back.toLocaleString()}`, show: rows.length > 300 },
    { key: 'new', label: `New ${counts.new.toLocaleString()}`, show: rows.length > 300 },
    { key: 'mine', label: 'Mine', show: !everyoneMine && !!salesName },
    { key: 'followups', label: 'Open follow-ups', show: true },
    { key: 'occasions', label: 'Occasions', show: true },
    { key: 'all', label: 'All', show: true },
  ];

  return (
    <div className="px-4 pt-6 pb-32 max-w-lg mx-auto lg:max-w-3xl lg:px-8">
      <div className="flex items-end justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Customers</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            {search ? `${filtered.length.toLocaleString()} found in all ${rows.length.toLocaleString()}`
              : brand ? `${brandRows ? filtered.length.toLocaleString() : '…'} ${brandMode === 'bought' ? 'bought' : 'asked about'} ${brand} · ${rows.length.toLocaleString()} ${everyoneMine ? 'you know' : 'you may see'}`
              : `${filtered.length.toLocaleString()} shown · ${rows.length.toLocaleString()} ${everyoneMine ? 'you know' : 'you may see'}`}
          </p>
        </div>
      </div>

      <div className="relative mb-3">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Name, number or brand"
          className="input pl-9" inputMode="search" />
      </div>
      {brandSuggestions.length > 0 && (
        <div className="flex flex-col gap-1.5 mb-3">
          {brandSuggestions.map(b => (
            <button key={b.brand} onClick={() => setBrand(b.brand)}
              className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-emerald-200 bg-emerald-50 text-left text-sm text-emerald-900 active:bg-emerald-100">
              <Tag className="w-4 h-4 shrink-0" />
              <span className="flex-1 min-w-0 truncate">Customers who bought <span className="font-semibold">{b.brand}</span></span>
              <span className="text-xs tabular-nums shrink-0">{b.bought.toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-1.5 overflow-x-auto pb-3 -mx-1 px-1">
        {brand ? (
          <span className="shrink-0 flex items-center rounded-full bg-emerald-700 text-white text-xs font-semibold">
            <button onClick={() => setPicking(true)} className="flex items-center gap-1 pl-3 pr-1 py-1.5"><Tag className="w-3.5 h-3.5" /> {brand}</button>
            <button onClick={() => setBrand(null)} aria-label="Clear brand" className="pl-1 pr-2.5 py-1.5"><X className="w-3.5 h-3.5" /></button>
          </span>
        ) : (
          <button onClick={() => setPicking(true)}
            className="shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold border bg-white text-slate-600 border-slate-200">
            <Tag className="w-3.5 h-3.5" /> Brand
          </button>
        )}
        {chips.filter(c => c.show).map(c => (
          <button key={c.key} onClick={() => setFilter(c.key)}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border ${filter === c.key ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200'}`}>
            {c.label}
          </button>
        ))}
      </div>

      {brandActive && (
        <div className="space-y-2 mb-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex rounded-xl bg-slate-100 p-0.5 text-xs font-semibold">
              {(['bought', 'asked'] as const).map(m => (
                <button key={m} onClick={() => setBrandMode(m)}
                  className={`px-3 py-1.5 rounded-lg ${brandMode === m ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>
                  {m === 'bought' ? 'Bought' : 'Asked about'}
                </button>
              ))}
            </div>
            {brandMode === 'bought' && (
              <select value={brandWhen} onChange={e => setBrandWhen(e.target.value as typeof brandWhen)} aria-label="When they bought"
                className="text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg px-2 py-1.5">
                <option value="any">Any time</option>
                <option value="year">Last 12 months</option>
                <option value="older">Over a year ago</option>
              </select>
            )}
          </div>
          {brandRows && brandMode === 'bought' && filtered.length > 0 && (
            <p className="text-xs text-emerald-900 bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2">
              {filtered.length.toLocaleString()} customers · {formatKD(brandTotalKD)} KD on {brand}
            </p>
          )}
          {brandRows && reachable.length > 0 && (
            <div className="flex items-center gap-3 rounded-2xl bg-slate-900 px-3 py-2.5">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white">WhatsApp them one by one</p>
                <p className="text-[11px] text-slate-300">{messagedCount.toLocaleString()} of {reachable.length.toLocaleString()} messaged this week · each one is skipped for {MESSAGE_REST_DAYS} days</p>
              </div>
              <button onClick={() => nextUp && setWaRow(nextUp)} disabled={!nextUp}
                className="shrink-0 flex items-center gap-1 px-3 py-2 rounded-xl bg-emerald-600 text-white text-sm font-bold disabled:opacity-40">
                <MessageCircle className="w-4 h-4" /> {nextUp ? 'Next' : 'All done'}
              </button>
            </div>
          )}
        </div>
      )}

      {loading || (brandActive && !brandRows) ? (
        <div className="space-y-2">{[0, 1, 2, 3].map(i => <div key={i} className="h-16 rounded-2xl bg-slate-100 animate-pulse" />)}</div>
      ) : filtered.length === 0 && search && brandSuggestions.length > 0 ? (
        /* The word is a brand, not a name: the suggestion above is the answer. */
        null
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <Users className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">{search ? 'Nobody matches that.' : brand ? `None of your customers ${brandMode === 'bought' ? 'bought' : 'asked about'} ${brand}${brandMode === 'bought' && brandWhen !== 'any' ? ' in that time' : ''}.` : rows.length ? 'Nobody in this group.' : 'No customers here yet.'}</p>
          {!search && !rows.length && <p className="text-sm">A customer appears once you have logged a visit or a sale with their number.</p>}
          {!search && rows.length > 0 && filter !== 'all' && <button onClick={() => setFilter('all')} className="mt-2 text-sm font-semibold text-slate-700 underline">Show all customers</button>}
        </div>
      ) : (
        <div className="card divide-y divide-slate-100 overflow-hidden">
          {filtered.slice(0, 200).map(r => (
            <div key={r.id} className="flex items-center">
            <button onClick={() => openCustomer(r.id)} className="flex-1 min-w-0 flex items-center gap-3 px-4 py-3 text-left active:bg-slate-50">
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-slate-900 text-sm truncate flex items-center gap-1.5">
                  {r.isVip && <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-400 shrink-0" />}
                  {r.name}
                </p>
                <p className="text-xs text-slate-500 truncate">
                  {displayPhone(r.phoneE164) ?? r.contact}
                  {lastSeen(r) && <> · {ago(lastSeen(r))}</>}
                  {r.responsible && <> · {r.responsible}</>}
                </p>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {groups.get(r.id) !== 'other' && groups.get(r.id) !== undefined && (
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${groups.get(r.id) === 'top' ? 'bg-slate-900 text-white' : groups.get(r.id) === 'win_back' ? 'bg-sky-50 text-sky-700' : 'bg-violet-50 text-violet-700'}`}>
                      {GROUP_LABEL[groups.get(r.id)!]}
                    </span>
                  )}
                  {brandActive && brandRows?.get(r.id) && (() => {
                    const b = brandRows.get(r.id)!;
                    return brandMode === 'bought'
                      ? <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-teal-50 text-teal-800">{b.pieces} {brand} · {formatKD(b.kd)} KD · {ago(b.lastBought)}</span>
                      : <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-800">Asked about {brand} {ago(b.askedAt)}</span>;
                  })()}
                  {brandActive && messaged(r.id) && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-green-100 text-green-800 flex items-center gap-0.5"><Check className="w-3 h-3" /> Messaged {ago(sentNow.has(r.id) ? new Date().toISOString() : brandRows?.get(r.id)?.lastWhatsApp ?? null)}</span>}
                  {r.purchases > 0 && !brandActive && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700">{r.purchases} {r.purchases === 1 ? 'purchase' : 'purchases'} · {formatKD(r.purchasesKD)} KD</span>}
                  {r.openFollowups > 0 && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700">{r.openFollowups} open follow-up{r.openFollowups > 1 ? 's' : ''}</span>}
                  {r.nextOccasionDays != null && r.nextOccasionDays <= 30 && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-pink-50 text-pink-700">
                      {r.nextOccasionLabel} {r.nextOccasionDays === 0 ? 'today' : r.nextOccasionDays === 1 ? 'tomorrow' : `in ${r.nextOccasionDays} days`}
                    </span>
                  )}
                </div>
                {brandActive && brandMode === 'bought' && (brandRows?.get(r.id)?.models.length ?? 0) > 0 && (
                  <p className="text-[11px] text-slate-400 truncate mt-1">{brandRows!.get(r.id)!.models.join(' · ')}</p>
                )}
              </div>
              <ChevronRight className="w-4 h-4 text-slate-300 shrink-0" />
            </button>
            {brandActive && r.phoneE164 && (
              <button onClick={() => setWaRow(r)} aria-label={`WhatsApp ${r.name}`}
                className="shrink-0 mr-3 w-11 h-11 rounded-xl bg-emerald-600 text-white flex items-center justify-center active:bg-emerald-700">
                <MessageCircle className="w-5 h-5" />
              </button>
            )}
            </div>
          ))}
          {filtered.length > 200 && <p className="px-4 py-3 text-xs text-slate-400 text-center">Showing the first 200. Search to narrow it down.</p>}
        </div>
      )}

      {picking && <BrandPicker brands={brands} value={brand} onClose={() => setPicking(false)} onPick={b => { setPicking(false); setBrand(b); }} />}
      {waRow && brand && (
        <WhatsAppSheet
          target={{ customerId: waRow.id, name: waRow.name !== waRow.contact ? waRow.name : null, phone: waRow.phoneE164 }}
          product={brand} defaultTemplate="brand_news"
          onClose={() => setWaRow(null)}
          onOpened={() => { const id = waRow.id; setSentNow(prev => new Set(prev).add(id)); }} />
      )}
    </div>
  );
}

// ── One customer ──────────────────────────────────────────────────────────────

type TimelineItem =
  | { kind: 'visit'; at: string; v: ProfileVisit }
  | { kind: 'purchase'; at: string; p: ProfilePurchase }
  | { kind: 'handoff'; at: string; h: ProfileHandoff };

function CustomerPage({ id, onBack, onChanged, canAssign, openWith }: { id: string; onBack: () => void; onChanged: () => void; canAssign: boolean; openWith?: TemplateKey | null }) {
  const { role } = useAuth();
  const { showToast } = useAppStore();
  const navigate = useNavigate();
  const [p, setP] = useState<CustomerProfile | null | undefined>(undefined);
  const [wa, setWa] = useState<{ template: TemplateKey; caseId?: string; product?: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [phoneEdit, setPhoneEdit] = useState(false);
  const [occasionAdd, setOccasionAdd] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const load = useCallback(async () => {
    try { setP(await getCustomerProfile(id)); }
    catch (err) { showToast(err instanceof Error ? err.message : 'Could not open the customer.', 'error'); setP(null); }
  }, [id, showToast]);
  useEffect(() => { void load(); }, [load]);

  /* A reminder's link arrives with the template named, so the message is
     one tap away — the page opens with WhatsApp ready, once. */
  const [autoOpened, setAutoOpened] = useState(false);
  useEffect(() => {
    if (p && openWith && !autoOpened && p.customer.phone_e164) { setWa({ template: openWith }); setAutoOpened(true); }
  }, [p, openWith, autoOpened]);

  const timeline = useMemo<TimelineItem[]>(() => {
    if (!p) return [];
    return [
      ...p.visits.map(v => ({ kind: 'visit' as const, at: v.at, v })),
      ...p.purchases.map(pu => ({ kind: 'purchase' as const, at: pu.at, p: pu })),
      ...p.handoffs.map(h => ({ kind: 'handoff' as const, at: h.at, h })),
    ].sort((a, b) => b.at.localeCompare(a.at));
  }, [p]);

  /* What they have bought, brand by brand, and the brands they asked about on a visit. */
  const brandSummary = useMemo(() => {
    const bought = new Map<string, { brand: string; pieces: number; kd: number; last: string }>();
    const asked = new Map<string, string>();
    if (p) {
      for (const pu of p.purchases) {
        if (pu.is_return) continue;
        for (const it of pu.items ?? []) {
          const b = it.brand?.trim();
          if (!b) continue;
          const e = bought.get(b) ?? { brand: b, pieces: 0, kd: 0, last: pu.at };
          e.pieces += Number(it.qty ?? 0); e.kd += Number(it.total ?? 0);
          if (pu.at > e.last) e.last = pu.at;
          bought.set(b, e);
        }
      }
      for (const v of p.visits) {
        const b = v.brand?.trim();
        if (!b || (v.case_type !== 'Follow-up' && v.case_type !== 'Lost Sale') || /^others?$/i.test(b)) continue;
        if (!asked.has(b) || v.at > asked.get(b)!) asked.set(b, v.at);
      }
    }
    return {
      bought: [...bought.values()].sort((a, b) => b.kd - a.kd),
      asked: [...asked].map(([brand, at]) => ({ brand, at })).sort((a, b) => b.at.localeCompare(a.at)),
    };
  }, [p]);

  if (p === undefined) return <div className="p-4 space-y-3">{[0, 1, 2].map(i => <div key={i} className="h-24 rounded-2xl bg-slate-100 animate-pulse" />)}</div>;
  if (p === null) {
    return (
      <div className="px-4 pt-6 max-w-lg mx-auto">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-brand-700 font-semibold mb-4"><ChevronLeft className="w-4 h-4" /> Customers</button>
        <div className="card p-5 text-sm text-slate-600">This customer is not one of yours to see. Once you have served them, their page opens here.</div>
      </div>
    );
  }

  const c = p.customer;
  const name = c.display_name?.trim() || c.contact;
  const phone = displayPhone(c.phone_e164) ?? c.contact;
  const lastProduct = p.visits.find(v => v.product)?.product ?? null;
  const spent = p.purchases.reduce((t, x) => t + Number(x.total ?? 0), 0);
  const openFollowUps = p.visits.filter(v => v.case_type === 'Follow-up' && v.status === 'Open');
  const occasionsSoon = p.occasions.map(o => ({ ...o, days: daysUntil(o.month, o.day) })).sort((a, b) => a.days - b.days);
  const birthdayDays = c.birthday ? daysUntil(Number(c.birthday.slice(5, 7)), Number(c.birthday.slice(8, 10))) : null;
  const anniversaryDays = c.anniversary ? daysUntil(Number(c.anniversary.slice(5, 7)), Number(c.anniversary.slice(8, 10))) : null;

  return (
    <div className="px-4 pt-4 pb-32 max-w-lg mx-auto lg:max-w-3xl lg:px-8 space-y-4">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-brand-700 font-semibold"><ChevronLeft className="w-4 h-4" /> Customers</button>

      {/* ── who ── */}
      <div className="card p-4">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              {c.is_vip && <Star className="w-4 h-4 text-amber-500 fill-amber-400 shrink-0" />}
              <span className="truncate">{name}</span>
            </h1>
            <p className="text-sm text-slate-600 mt-0.5">{phone}</p>
            <p className="text-xs text-slate-400 mt-1">
              {p.responsible ? <>Responsible: <span className="text-slate-600 font-medium">{p.responsible}</span></> : 'No responsible salesperson'}
              {p.knownBy.length > 0 && <> · Known by {p.knownBy.map(k => k.name).filter(Boolean).join(', ')}</>}
            </p>
          </div>
          <button onClick={() => setEditing(true)} className="p-2 rounded-xl text-slate-400 hover:bg-slate-50"><Pencil className="w-4 h-4" /></button>
        </div>

        <div className="grid grid-cols-3 gap-2 mt-4">
          <button onClick={() => setWa({ template: openFollowUps.length ? 'interested_followup' : p.purchases.length ? 'post_sale_checkin' : 'general_followup', product: lastProduct ?? undefined, caseId: openFollowUps[0]?.id })}
            disabled={!c.phone_e164}
            className="flex flex-col items-center gap-1 py-3 rounded-2xl bg-emerald-600 text-white text-xs font-semibold disabled:opacity-40">
            <MessageCircle className="w-5 h-5" /> WhatsApp
          </button>
          <a href={c.phone_e164 ? `tel:${c.phone_e164}` : undefined}
            className={`flex flex-col items-center gap-1 py-3 rounded-2xl border-2 border-slate-200 text-slate-700 text-xs font-semibold ${c.phone_e164 ? '' : 'opacity-40 pointer-events-none'}`}>
            <Phone className="w-5 h-5" /> Call
          </a>
          <button onClick={() => navigate(`/entry?contact=${encodeURIComponent(c.contact)}&name=${encodeURIComponent(c.display_name ?? '')}`)}
            className="flex flex-col items-center gap-1 py-3 rounded-2xl border-2 border-slate-200 text-slate-700 text-xs font-semibold">
            <PlusCircle className="w-5 h-5" /> Log a visit
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2 mt-4 text-center">
          {[['Visits', String(p.visits.length)], ['Purchases', String(p.purchases.filter(x => !x.is_return).length)], ['Spent', `${formatKD(spent)} KD`]].map(([l, v]) => (
            <div key={l}><p className="text-base font-bold text-slate-900 leading-none">{v}</p><p className="text-[11px] text-slate-500 mt-1">{l}</p></div>
          ))}
        </div>
        {(role === 'sales') && p.purchases.length > 0 && (
          <p className="text-[11px] text-slate-400 mt-2 text-center">Purchases shown are the ones credited to you.</p>
        )}
      </div>

      {/* ── brands ── */}
      {(brandSummary.bought.length > 0 || brandSummary.asked.length > 0) && (
        <div className="card p-4">
          <h2 className="font-bold text-slate-900 mb-2">Brands</h2>
          {brandSummary.bought.length > 0 && (
            <div className="divide-y divide-slate-100">
              {brandSummary.bought.map(b => (
                <div key={b.brand} className="flex items-center gap-3 py-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-900 truncate">{b.brand}</p>
                    <p className="text-xs text-slate-500">{b.pieces} {b.pieces === 1 ? 'piece' : 'pieces'} · last {ago(b.last)}</p>
                  </div>
                  <span className="text-sm font-semibold text-teal-800 tabular-nums shrink-0">{formatKD(b.kd)} KD</span>
                  {c.phone_e164 && (
                    <button onClick={() => setWa({ template: 'brand_news', product: b.brand })} aria-label={`WhatsApp about ${b.brand}`}
                      className="shrink-0 w-9 h-9 rounded-xl border border-emerald-200 text-emerald-700 flex items-center justify-center">
                      <MessageCircle className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {brandSummary.asked.length > 0 && (
            <div className={brandSummary.bought.length ? 'pt-2 mt-1 border-t border-slate-100' : ''}>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">Asked about</p>
              <div className="flex flex-wrap gap-1.5">
                {brandSummary.asked.map(a => (
                  <span key={a.brand} className="text-xs font-semibold px-2 py-1 rounded-full bg-amber-50 text-amber-800">{a.brand} · {ago(a.at)}</span>
                ))}
              </div>
            </div>
          )}
          {role === 'sales' && brandSummary.bought.length > 0 && (
            <p className="text-[11px] text-slate-400 mt-2">From the purchases credited to you.</p>
          )}
        </div>
      )}

      {/* ── details ── */}
      <div className="card p-4 space-y-2 text-sm">
        <div className="flex items-center justify-between"><h2 className="font-bold text-slate-900">Details</h2>
          <button onClick={() => setEditing(true)} className="text-xs font-semibold text-brand-700">Edit</button></div>
        <Row label="Birthday" value={c.birthday ? `${day(c.birthday)}${birthdayDays != null && birthdayDays <= 30 ? ` · ${when(birthdayDays)}` : ''}` : null} />
        <Row label="Anniversary" value={c.anniversary ? `${day(c.anniversary)}${anniversaryDays != null && anniversaryDays <= 30 ? ` · ${when(anniversaryDays)}` : ''}` : null} />
        <Row label="Email" value={c.email} />
        <Row label="Instagram" value={c.instagram} />
        <Row label="Likes" value={c.preferred_brands?.length ? c.preferred_brands.join(', ') : null} />
        <Row label="Notes" value={c.personal_notes} />
        <Row label="Customer since" value={day(c.created_at)} />
        {canAssign && (
          <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
            <span className="text-slate-500">Responsible salesperson</span>
            <button onClick={() => setAssigning(true)} className="text-xs font-semibold text-brand-700">{p.responsible ? 'Change' : 'Assign'}</button>
          </div>
        )}
        {p.contactChanges.length > 0 && (
          <p className="text-[11px] text-slate-400 pt-1">Number changed {p.contactChanges.length === 1 ? 'once' : `${p.contactChanges.length} times`}, last {day(p.contactChanges[0].at)} from {p.contactChanges[0].from}.</p>
        )}
      </div>

      {/* ── occasions ── */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-bold text-slate-900">Occasions</h2>
          <button onClick={() => setOccasionAdd(true)} className="flex items-center gap-1 text-xs font-semibold text-brand-700"><Plus className="w-3.5 h-3.5" /> Add</button>
        </div>
        {occasionsSoon.length === 0 && !c.birthday && !c.anniversary ? (
          <p className="text-sm text-slate-400">Nothing yet. Birthday and anniversary go under Details; anything else — a child's birthday, a graduation — goes here.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {occasionsSoon.map(o => (
              <div key={o.id} className="flex items-center gap-3 py-2">
                <Gift className="w-4 h-4 text-violet-500 shrink-0" />
                <span className="flex-1 min-w-0 text-sm text-slate-800 truncate">{o.label} <span className="text-slate-400">· {o.day} {MONTHS[o.month - 1]}{o.year ? ` ${o.year}` : ''}</span></span>
                <span className="text-xs text-slate-500 shrink-0">{when(o.days)}</span>
                <button onClick={async () => { try { await removeOccasion(o.id); await load(); } catch (err) { showToast(err instanceof Error ? err.message : 'Could not remove it.', 'error'); } }}
                  className="p-1 text-slate-300 hover:text-rose-500"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── timeline ── */}
      <div className="card p-4">
        <h2 className="font-bold text-slate-900 mb-2">History</h2>
        {timeline.length === 0 ? <p className="text-sm text-slate-400">No visits or purchases recorded yet.</p> : (
          <div className="divide-y divide-slate-100">
            {timeline.map((t, i) => (
              <div key={i} className="py-2.5 flex gap-3">
                <div className="shrink-0 mt-0.5">
                  {t.kind === 'visit' ? <Clock className="w-4 h-4 text-slate-400" /> : t.kind === 'purchase' ? <ShoppingBag className="w-4 h-4 text-emerald-600" /> : <MessageCircle className="w-4 h-4 text-emerald-500" />}
                </div>
                <div className="flex-1 min-w-0 text-sm">
                  {t.kind === 'visit' && (
                    <>
                      <div className="flex items-center gap-2 flex-wrap">
                        <CaseTypeBadge type={t.v.case_type as CaseType} />
                        {t.v.case_type === 'Follow-up' && <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${t.v.status === 'Open' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>{t.v.status}</span>}
                        <span className="text-xs text-slate-400">{format(new Date(t.v.at), 'd MMM yyyy · HH:mm')} · {t.v.staff}{t.v.outlet ? ` · ${t.v.outlet}` : ''}</span>
                      </div>
                      <p className="text-slate-800 mt-0.5">{[t.v.brand, t.v.product].filter(Boolean).join(' · ') || '—'}{t.v.amount_kd ? ` · ${formatKD(t.v.amount_kd)} KD` : ''}</p>
                      {t.v.lost_reason && <p className="text-xs text-rose-600">{t.v.lost_reason}</p>}
                      {t.v.notes && <p className="text-xs text-slate-500 italic mt-0.5">"{t.v.notes}"</p>}
                      {t.v.case_type === 'Follow-up' && t.v.status === 'Open' && c.phone_e164 && (
                        <button onClick={() => setWa({ template: 'interested_followup', caseId: t.v.id, product: t.v.product })}
                          className="mt-1 text-xs font-semibold text-emerald-700 flex items-center gap-1"><MessageCircle className="w-3.5 h-3.5" /> WhatsApp about this</button>
                      )}
                    </>
                  )}
                  {t.kind === 'purchase' && (
                    <>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${t.p.is_return ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'}`}>{t.p.is_return ? 'Return' : 'Purchase'}</span>
                        <span className="text-xs text-slate-400">{format(new Date(t.p.at), 'd MMM yyyy · HH:mm')}{t.p.salesperson ? ` · ${t.p.salesperson}` : ''}{t.p.outlet ? ` · ${t.p.outlet}` : ''}</span>
                      </div>
                      <p className="text-slate-800 mt-0.5 font-semibold">{formatKD(Number(t.p.total))} KD</p>
                      {t.p.items?.map((it, j) => (
                        <p key={j} className="text-xs text-slate-500">{it.qty > 1 ? `${it.qty} × ` : ''}{[it.brand, it.name].filter(Boolean).join(' ') || it.sku || 'Item'}</p>
                      ))}
                    </>
                  )}
                  {t.kind === 'handoff' && (
                    <p className="text-slate-600">WhatsApp opened{t.h.by ? ` by ${t.h.by}` : ''} · {t.h.template.replace(/_/g, ' ')} ({t.h.lang}) <span className="text-xs text-slate-400">· {format(new Date(t.h.at), 'd MMM yyyy · HH:mm')}</span></p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {wa && <WhatsAppSheet target={{ customerId: c.id, name: c.display_name, phone: c.phone_e164 }} caseId={wa.caseId} product={wa.product} defaultTemplate={wa.template} onClose={() => setWa(null)} onOpened={load} />}

      {editing && (
        <EditDetails c={c} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); await load(); onChanged(); }} onPhone={() => { setEditing(false); setPhoneEdit(true); }} />
      )}
      {phoneEdit && (
        <EditPhone c={c} onClose={() => setPhoneEdit(false)} onSaved={async () => { setPhoneEdit(false); await load(); onChanged(); }} />
      )}
      {occasionAdd && (
        <AddOccasion customerId={c.id} onClose={() => setOccasionAdd(false)} onSaved={async () => { setOccasionAdd(false); await load(); onChanged(); }} />
      )}
      {assigning && (
        <Assign c={c} current={p.responsible} onClose={() => setAssigning(false)} onSaved={async () => { setAssigning(false); await load(); onChanged(); }} />
      )}
    </div>
  );
}

function daysUntil(month: number, day: number): number {
  const now = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuwait' }) + 'T00:00:00');
  let d = new Date(now.getFullYear(), month - 1, day);
  if (d < now) d = new Date(now.getFullYear() + 1, month - 1, day);
  return Math.round((d.getTime() - now.getTime()) / 86400000);
}
const when = (days: number) => days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days <= 30 ? `In ${days} days` : `In ${Math.round(days / 30)} months`;

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return <div className="flex gap-3"><span className="w-28 shrink-0 text-slate-500">{label}</span><span className="flex-1 text-slate-800 break-words">{value}</span></div>;
}

// ── edit sheets ──────────────────────────────────────────────────────────────

function EditDetails({ c, onClose, onSaved, onPhone }: { c: CustomerProfile['customer']; onClose: () => void; onSaved: () => void; onPhone: () => void }) {
  const { showToast } = useAppStore();
  const [f, setF] = useState({
    displayName: c.display_name ?? '', email: c.email ?? '', birthday: c.birthday ?? '', anniversary: c.anniversary ?? '',
    personalNotes: c.personal_notes ?? '', isVip: !!c.is_vip, instagram: c.instagram ?? '', preferredBrands: (c.preferred_brands ?? []).join(', '),
  });
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      await updateCustomerDetails(c.id, {
        displayName: f.displayName, email: f.email, birthday: f.birthday || null, anniversary: f.anniversary || null,
        personalNotes: f.personalNotes, isVip: f.isVip, instagram: f.instagram,
        preferredBrands: f.preferredBrands.split(',').map(s => s.trim()).filter(Boolean),
      });
      showToast('Saved.', 'success'); onSaved();
    } catch (err) { showToast(err instanceof Error ? err.message : 'Could not save.', 'error'); }
    finally { setSaving(false); }
  }
  return (
    <Modal open onClose={onClose} title="Customer details" footer={
      <div className="flex gap-3"><button onClick={onClose} className="btn-ghost flex-1" disabled={saving}>Cancel</button><button onClick={() => void save()} className="btn-primary flex-1" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>}>
      <div className="space-y-3">
        <div><label className="label">Name</label><input value={f.displayName} onChange={e => setF({ ...f, displayName: e.target.value })} className="input" /></div>
        <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-slate-50">
          <span className="text-sm text-slate-700">Number: <span className="font-medium">{displayPhone(c.phone_e164) ?? c.contact}</span></span>
          <button type="button" onClick={onPhone} className="text-xs font-semibold text-brand-700">Change</button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div><label className="label">Birthday</label><input type="date" value={f.birthday} onChange={e => setF({ ...f, birthday: e.target.value })} className="input" /></div>
          <div><label className="label">Anniversary</label><input type="date" value={f.anniversary} onChange={e => setF({ ...f, anniversary: e.target.value })} className="input" /></div>
        </div>
        <div><label className="label">Email</label><input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} className="input" /></div>
        <div><label className="label">Instagram</label><input value={f.instagram} onChange={e => setF({ ...f, instagram: e.target.value })} className="input" placeholder="@handle" /></div>
        <div><label className="label">Likes <span className="text-slate-400 font-normal">(brands, comma-separated)</span></label><input value={f.preferredBrands} onChange={e => setF({ ...f, preferredBrands: e.target.value })} className="input" /></div>
        <div><label className="label">Notes</label><textarea value={f.personalNotes} onChange={e => setF({ ...f, personalNotes: e.target.value })} rows={3} className="input resize-none" placeholder="What they like, who they buy for, how they like to be contacted…" /></div>
        <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={f.isVip} onChange={e => setF({ ...f, isVip: e.target.checked })} /> VIP customer</label>
      </div>
    </Modal>
  );
}

function EditPhone({ c, onClose, onSaved }: { c: CustomerProfile['customer']; onClose: () => void; onSaved: () => void }) {
  const { showToast } = useAppStore();
  const [contact, setContact] = useState(c.contact);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true); setErr('');
    try { await updateCustomerPhone(c.id, contact); showToast('Number changed.', 'success'); onSaved(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not change the number.'); }
    finally { setSaving(false); }
  }
  return (
    <Modal open onClose={onClose} title="Change the number" footer={
      <div className="flex gap-3"><button onClick={onClose} className="btn-ghost flex-1" disabled={saving}>Cancel</button><button onClick={() => void save()} className="btn-primary flex-1" disabled={saving || contact.trim() === c.contact}>{saving ? 'Saving…' : 'Change'}</button></div>}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">Their visits and history move with the number. A number Lightspeed holds must be corrected in Lightspeed instead; a number another customer already has is refused.</p>
        <div><label className="label">New number</label><input type="tel" value={contact} onChange={e => { setContact(e.target.value); setErr(''); }} className={`input ${err ? 'input-error' : ''}`} inputMode="tel" /></div>
        {err && <p className="text-rose-600 text-sm">{err}</p>}
      </div>
    </Modal>
  );
}

function AddOccasion({ customerId, onClose, onSaved }: { customerId: string; onClose: () => void; onSaved: () => void }) {
  const { showToast } = useAppStore();
  const [label, setLabel] = useState('');
  const [date, setDate] = useState('');
  const [knownYear, setKnownYear] = useState(false);
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!label.trim() || !date) { showToast('Give it a name and a date.', 'error'); return; }
    setSaving(true);
    try {
      const [y, m, d] = date.split('-').map(Number);
      await addOccasion(customerId, label, m, d, knownYear ? y : null);
      onSaved();
    } catch (err) { showToast(err instanceof Error ? err.message : 'Could not add it.', 'error'); }
    finally { setSaving(false); }
  }
  return (
    <Modal open onClose={onClose} title="Add an occasion" footer={
      <div className="flex gap-3"><button onClick={onClose} className="btn-ghost flex-1" disabled={saving}>Cancel</button><button onClick={() => void save()} className="btn-primary flex-1" disabled={saving}>{saving ? 'Saving…' : 'Add'}</button></div>}>
      <div className="space-y-3">
        <div><label className="label">What is it?</label><input value={label} onChange={e => setLabel(e.target.value)} className="input" placeholder="e.g. Daughter's birthday, Graduation" /></div>
        <div><label className="label">Date</label><input type="date" value={date} onChange={e => setDate(e.target.value)} className="input" /></div>
        <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={knownYear} onChange={e => setKnownYear(e.target.checked)} /> The year matters (a first birthday, a 25th anniversary)</label>
        <p className="text-[11px] text-slate-400 flex items-center gap-1"><Cake className="w-3 h-3" /> A reminder comes a week before and on the day.</p>
      </div>
    </Modal>
  );
}

function Assign({ c, current, onClose, onSaved }: { c: CustomerProfile['customer']; current: string | null; onClose: () => void; onSaved: () => void }) {
  const { showToast } = useAppStore();
  const [roster, setRoster] = useState<Map<string, string>>(new Map());
  const [pick, setPick] = useState(current ?? '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { void getRosterEmployees().then(setRoster).catch(() => setRoster(new Map())); }, []);
  async function save() {
    setSaving(true);
    try { await assignResponsible(c.id, pick ? (roster.get(pick) ?? null) : null); showToast(pick ? `${pick} is responsible for this customer.` : 'Assignment removed.', 'success'); onSaved(); }
    catch (err) { showToast(err instanceof Error ? err.message : 'Could not assign.', 'error'); }
    finally { setSaving(false); }
  }
  return (
    <Modal open onClose={onClose} title="Responsible salesperson" footer={
      <div className="flex gap-3"><button onClick={onClose} className="btn-ghost flex-1" disabled={saving}>Cancel</button><button onClick={() => void save()} className="btn-primary flex-1" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">The responsible salesperson gets this customer's reminders and can see and message them even if somebody else served them last. It can be changed or removed at any time.</p>
        <select value={pick} onChange={e => setPick(e.target.value)} className="input">
          <option value="">— Nobody —</option>
          {Array.from(roster.keys()).map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
    </Modal>
  );
}
