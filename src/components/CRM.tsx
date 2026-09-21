import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import {
  Search, Star, Phone, MessageCircle, PlusCircle, ChevronRight, ChevronLeft, Pencil, Cake, Gift,
  ShoppingBag, Users, Trash2, Plus, ShieldAlert, Clock,
} from 'lucide-react';
import { useAuth, canSeePerformance } from '../context/AuthContext';
import { useAppStore } from '../store';
import {
  getCustomerList, getCustomerProfile, updateCustomerDetails, updateCustomerPhone, assignResponsible,
  addOccasion, removeOccasion, getRosterEmployees,
  type CustomerListRow, type CustomerProfile, type ProfileVisit, type ProfilePurchase, type ProfileHandoff,
} from '../db';
import { formatKD } from '../utils/formatKD';
import { caseLabel } from '../shared/caseLabels';
import { displayPhone } from '../shared/phoneRules';
import { Modal } from './shared/Modal';
import { CaseTypeBadge } from './shared/Badge';
import { WhatsAppSheet } from './WhatsAppSheet';
import type { TemplateKey } from '../shared/messageRules';
import type { CaseType } from '../types';

type Filter = 'all' | 'mine' | 'followups' | 'occasions' | 'vip';

const day = (iso: string | null | undefined) => iso ? format(new Date(iso), 'd MMM yyyy') : '—';
const ago = (iso: string | null) => {
  if (!iso) return null;
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : d < 365 ? `${Math.floor(d / 30)} mo ago` : `${Math.floor(d / 365)} yr ago`;
};
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
  const [filter, setFilter] = useState<Filter>(params.get('tab') === 'occasions' ? 'occasions' : 'all');
  const openId = params.get('customer');

  const load = useCallback(async () => {
    try { setRows(await getCustomerList()); }
    catch (err) { showToast(err instanceof Error ? err.message : 'Could not load customers.', 'error'); }
    finally { setLoading(false); }
  }, [showToast]);
  useEffect(() => { void load(); }, [load]);

  const everyoneMine = useMemo(() => rows.length > 0 && rows.every(r => r.mine), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    return rows
      .filter(r => {
        if (filter === 'mine' && !r.mine) return false;
        if (filter === 'followups' && r.openFollowups === 0) return false;
        if (filter === 'occasions' && (r.nextOccasionDays == null || r.nextOccasionDays > 30)) return false;
        if (filter === 'vip' && !r.isVip) return false;
        if (!q) return true;
        return r.name.toLowerCase().includes(q)
          || (digits.length >= 3 && ((r.phoneE164 ?? '').includes(digits) || r.contact.replace(/\D/g, '').includes(digits)));
      })
      .sort((a, b) => {
        if (filter === 'occasions') return (a.nextOccasionDays ?? 999) - (b.nextOccasionDays ?? 999);
        const la = [a.lastVisit, a.lastPurchase].filter(Boolean).sort().pop() ?? '';
        const lb = [b.lastVisit, b.lastPurchase].filter(Boolean).sort().pop() ?? '';
        return lb.localeCompare(la) || a.name.localeCompare(b.name);
      });
  }, [rows, search, filter]);

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
    return <CustomerPage id={openId} onBack={() => openCustomer(null)} onChanged={load} canAssign={perf} />;
  }

  const chips: { key: Filter; label: string; show: boolean }[] = [
    { key: 'all', label: 'All', show: true },
    { key: 'mine', label: 'Mine', show: !everyoneMine && !!salesName },
    { key: 'followups', label: 'Open follow-ups', show: true },
    { key: 'occasions', label: 'Occasions', show: true },
    { key: 'vip', label: 'VIP', show: true },
  ];

  return (
    <div className="px-4 pt-6 pb-32 max-w-lg mx-auto lg:max-w-3xl lg:px-8">
      <div className="flex items-end justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Customers</h1>
          <p className="text-slate-500 text-sm mt-0.5">{rows.length.toLocaleString()} {everyoneMine ? 'you know' : 'you may see'}</p>
        </div>
      </div>

      <div className="relative mb-3">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Name or number"
          className="input pl-9" inputMode="search" />
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-3 -mx-1 px-1">
        {chips.filter(c => c.show).map(c => (
          <button key={c.key} onClick={() => setFilter(c.key)}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border ${filter === c.key ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200'}`}>
            {c.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-2">{[0, 1, 2, 3].map(i => <div key={i} className="h-16 rounded-2xl bg-slate-100 animate-pulse" />)}</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <Users className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">{search ? 'Nobody matches that.' : 'No customers here yet.'}</p>
          {!search && <p className="text-sm">A customer appears once you have logged a visit or a sale with their number.</p>}
        </div>
      ) : (
        <div className="card divide-y divide-slate-100 overflow-hidden">
          {filtered.slice(0, 200).map(r => (
            <button key={r.id} onClick={() => openCustomer(r.id)} className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-slate-50">
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-slate-900 text-sm truncate flex items-center gap-1.5">
                  {r.isVip && <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-400 shrink-0" />}
                  {r.name}
                </p>
                <p className="text-xs text-slate-500 truncate">
                  {displayPhone(r.phoneE164) ?? r.contact}
                  {(r.lastVisit || r.lastPurchase) && <> · {ago([r.lastVisit, r.lastPurchase].filter(Boolean).sort().pop()!)}</>}
                  {r.responsible && <> · {r.responsible}</>}
                </p>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {r.purchases > 0 && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700">{r.purchases} {r.purchases === 1 ? 'purchase' : 'purchases'} · {formatKD(r.purchasesKD)} KD</span>}
                  {r.openFollowups > 0 && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700">{r.openFollowups} open follow-up{r.openFollowups > 1 ? 's' : ''}</span>}
                  {r.nextOccasionDays != null && r.nextOccasionDays <= 30 && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-pink-50 text-pink-700">
                      {r.nextOccasionLabel} {r.nextOccasionDays === 0 ? 'today' : r.nextOccasionDays === 1 ? 'tomorrow' : `in ${r.nextOccasionDays} days`}
                    </span>
                  )}
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-slate-300 shrink-0" />
            </button>
          ))}
          {filtered.length > 200 && <p className="px-4 py-3 text-xs text-slate-400 text-center">Showing the first 200. Search to narrow it down.</p>}
        </div>
      )}
    </div>
  );
}

// ── One customer ──────────────────────────────────────────────────────────────

type TimelineItem =
  | { kind: 'visit'; at: string; v: ProfileVisit }
  | { kind: 'purchase'; at: string; p: ProfilePurchase }
  | { kind: 'handoff'; at: string; h: ProfileHandoff };

function CustomerPage({ id, onBack, onChanged, canAssign }: { id: string; onBack: () => void; onChanged: () => void; canAssign: boolean }) {
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

  const timeline = useMemo<TimelineItem[]>(() => {
    if (!p) return [];
    return [
      ...p.visits.map(v => ({ kind: 'visit' as const, at: v.at, v })),
      ...p.purchases.map(pu => ({ kind: 'purchase' as const, at: pu.at, p: pu })),
      ...p.handoffs.map(h => ({ kind: 'handoff' as const, at: h.at, h })),
    ].sort((a, b) => b.at.localeCompare(a.at));
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
