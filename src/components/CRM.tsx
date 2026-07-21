import { useState, useEffect, useCallback, useMemo } from 'react';
import { format } from 'date-fns';
import {
  Users, Search, Phone, TrendingUp, ShoppingBag, Clock,
  TrendingDown, Edit2, Check, X, GitMerge, ArrowRight, ArrowLeftRight,
  Mail, Instagram, AtSign, Cake, StickyNote,
} from 'lucide-react';
import { getAllCustomerCases, bulkUpdateCustomerInfo, getCustomerRecords, upsertCustomer } from '../db';
import type { CustomerRecord } from '../db';
import { useAppStore } from '../store';
import { Modal } from './shared/Modal';
import { CaseTypeBadge } from './shared/Badge';
import type { Case } from '../types';
import { formatKD } from '../utils/formatKD';

// ── Customer profile type ─────────────────────────────────────────────────────

interface CustomerProfile {
  key: string;           // contact if present, else customerName
  displayName: string;
  contact?: string;
  cases: Case[];
  totalRevenue: number;
  visitCount: number;
  lastActivity: string;
  openFollowUps: number;
  brands: string[];
  record?: CustomerRecord;  // personal info from customers table
}

// ── Build profiles from cases ─────────────────────────────────────────────────

function buildProfiles(cases: Case[], records: Map<string, CustomerRecord>): CustomerProfile[] {
  const map = new Map<string, CustomerProfile>();

  for (const c of cases) {
    const key = c.contact?.trim() || c.customerName?.trim() || '';
    if (!key) continue;

    if (!map.has(key)) {
      map.set(key, {
        key,
        displayName: c.customerName?.trim() || c.contact?.trim() || key,
        contact: c.contact?.trim() || undefined,
        cases: [],
        totalRevenue: 0,
        visitCount: 0,
        lastActivity: c.dateLogged,
        openFollowUps: 0,
        brands: [],
      });
    }

    const p = map.get(key)!;
    p.cases.push(c);
    p.visitCount++;

    // Keep the most informative displayName (prefer explicit customerName)
    if (c.customerName?.trim() && !p.displayName.startsWith('+') && p.displayName !== c.customerName.trim()) {
      p.displayName = c.customerName.trim();
    }
    if (c.contact?.trim()) p.contact = c.contact.trim();
    if (c.dateLogged > p.lastActivity) p.lastActivity = c.dateLogged;
    if (c.caseType === 'Sale') p.totalRevenue += c.amountKD ?? 0;
    if (c.caseType === 'Follow-up' && c.status === 'Open') p.openFollowUps++;
    if (c.brand && !p.brands.includes(c.brand)) p.brands.push(c.brand);
  }

  // Attach customer records (personal info) by contact
  for (const [, p] of map) {
    if (p.contact) p.record = records.get(p.contact);
  }

  return Array.from(map.values());
}

// ── Main CRM component ────────────────────────────────────────────────────────

export function CRM() {
  const { showToast } = useAppStore();
  const [allCases, setAllCases] = useState<Case[]>([]);
  const [customerRecords, setCustomerRecords] = useState<Map<string, CustomerRecord>>(new Map());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'lastVisit' | 'revenue' | 'cases'>('lastVisit');
  const [detailCustomer, setDetailCustomer] = useState<CustomerProfile | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [cases, records] = await Promise.all([getAllCustomerCases(), getCustomerRecords()]);
    setAllCases(cases);
    setCustomerRecords(records);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const profiles = useMemo(() => buildProfiles(allCases, customerRecords), [allCases, customerRecords]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return profiles
      .filter(p =>
        !q ||
        p.displayName.toLowerCase().includes(q) ||
        (p.contact && p.contact.includes(q)) ||
        p.key.includes(q)
      )
      .sort((a, b) => {
        if (sortBy === 'revenue') return b.totalRevenue - a.totalRevenue;
        if (sortBy === 'cases') return b.visitCount - a.visitCount;
        return b.lastActivity.localeCompare(a.lastActivity);
      });
  }, [profiles, search, sortBy]);

  const totalRevenue = useMemo(() => profiles.reduce((s, p) => s + p.totalRevenue, 0), [profiles]);
  const totalOpenFU = useMemo(() => profiles.reduce((s, p) => s + p.openFollowUps, 0), [profiles]);

  // When the detail modal saves, re-derive the customer from fresh profiles
  function handleProfileUpdated(updatedKey: string) {
    load().then(() => {
      // The key may have changed after an edit — just close the modal
      setDetailCustomer(null);
    });
  }

  return (
    <div className="px-4 pt-6 pb-32 max-w-5xl mx-auto lg:max-w-none lg:px-8">
      {/* Header */}
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <Users className="w-6 h-6 text-brand-700" /> CRM
        </h1>
        <p className="text-slate-500 text-sm mt-0.5">Customer interaction history</p>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        <div className="card px-4 py-3 text-center">
          <p className="text-2xl font-bold text-slate-900">{loading ? '—' : profiles.length}</p>
          <p className="text-xs text-slate-400 font-medium mt-0.5">Customers</p>
        </div>
        <div className="card px-4 py-3 text-center">
          <p className="text-2xl font-bold text-emerald-700">{loading ? '—' : formatKD(totalRevenue)}</p>
          <p className="text-xs text-slate-400 font-medium mt-0.5">Total Revenue KD</p>
        </div>
        <div className="card px-4 py-3 text-center">
          <p className={`text-2xl font-bold ${totalOpenFU > 0 ? 'text-rose-600' : 'text-slate-900'}`}>
            {loading ? '—' : totalOpenFU}
          </p>
          <p className="text-xs text-slate-400 font-medium mt-0.5">Open Follow-ups</p>
        </div>
      </div>

      {/* Search + sort */}
      <div className="flex gap-2 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or phone…"
            className="input pl-9"
          />
        </div>
        <div className="flex gap-1">
          {([
            { id: 'lastVisit', label: 'Recent' },
            { id: 'revenue',   label: 'Revenue' },
            { id: 'cases',     label: 'Most Cases' },
          ] as const).map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setSortBy(id)}
              className={`px-3 py-2 rounded-xl text-xs font-semibold transition-colors ${
                sortBy === id ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Customer list */}
      {loading ? (
        <div className="text-center py-16 text-slate-400">
          <div className="w-6 h-6 border-2 border-brand-700 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm">Loading customers…</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <Users className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">{search ? 'No customers match your search.' : 'No customers yet.'}</p>
          <p className="text-sm">Customers appear when cases include a name or phone number.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(p => (
            <CustomerCard key={p.key} profile={p} onClick={() => setDetailCustomer(p)} />
          ))}
        </div>
      )}

      {/* Detail modal */}
      {detailCustomer && (
        <CustomerDetailModal
          profile={detailCustomer}
          allProfiles={profiles}
          onClose={() => setDetailCustomer(null)}
          onSaved={handleProfileUpdated}
          showToast={showToast}
        />
      )}
    </div>
  );
}

// ── Customer card ─────────────────────────────────────────────────────────────

function CustomerCard({ profile: p, onClick }: { profile: CustomerProfile; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className="card px-4 py-3.5 cursor-pointer hover:bg-slate-50 active:bg-slate-100 transition-colors"
    >
      <div className="flex items-start gap-3">
        {/* Avatar */}
        <div className="w-9 h-9 rounded-full bg-brand-50 text-brand-700 font-bold text-sm flex items-center justify-center shrink-0">
          {p.displayName.charAt(0).toUpperCase()}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-slate-900 text-sm">{p.displayName}</span>
            {p.openFollowUps > 0 && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 bg-rose-100 text-rose-700 rounded-full">
                {p.openFollowUps} open FU
              </span>
            )}
          </div>
          {p.contact && (
            <p className="text-xs text-slate-400 mt-0.5 flex items-center gap-1">
              <Phone className="w-3 h-3" /> {p.contact}
            </p>
          )}
          {p.brands.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {p.brands.slice(0, 4).map(b => (
                <span key={b} className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded-md font-medium">{b}</span>
              ))}
              {p.brands.length > 4 && (
                <span className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-400 rounded-md">+{p.brands.length - 4}</span>
              )}
            </div>
          )}
        </div>

        <div className="text-right shrink-0">
          {p.totalRevenue > 0 && (
            <p className="text-sm font-bold text-emerald-700">{formatKD(p.totalRevenue)} KD</p>
          )}
          <p className="text-xs text-slate-400">{p.visitCount} visit{p.visitCount !== 1 ? 's' : ''}</p>
          <p className="text-xs text-slate-300 mt-0.5">
            {format(new Date(p.lastActivity + 'T12:00:00'), 'd MMM yyyy')}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Customer detail modal ─────────────────────────────────────────────────────

function CustomerDetailModal({ profile, allProfiles, onClose, onSaved, showToast }: {
  profile: CustomerProfile;
  allProfiles: CustomerProfile[];
  onClose: () => void;
  onSaved: (key: string) => void;
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [editingName, setEditingName] = useState(false);
  const [editingContact, setEditingContact] = useState(false);
  const [draftName, setDraftName] = useState(profile.displayName);
  const [draftContact, setDraftContact] = useState(profile.contact ?? '');
  const [saving, setSaving] = useState(false);
  const [showMerge, setShowMerge] = useState(false);

  // Personal info edit state
  const [editingProfile, setEditingProfile] = useState(false);
  const [draftEmail, setDraftEmail] = useState(profile.record?.email ?? '');
  const [draftBirthday, setDraftBirthday] = useState(profile.record?.birthday ?? '');
  const [draftInstagram, setDraftInstagram] = useState(profile.record?.instagram ?? '');
  const [draftSnapchat, setDraftSnapchat] = useState(profile.record?.snapchat ?? '');
  const [draftTwitter, setDraftTwitter] = useState(profile.record?.twitter ?? '');
  const [draftPersonalNotes, setDraftPersonalNotes] = useState(profile.record?.personalNotes ?? '');
  const [savingProfile, setSavingProfile] = useState(false);

  async function saveProfile() {
    if (!profile.contact) return;
    setSavingProfile(true);
    try {
      await upsertCustomer({
        contact: profile.contact,
        displayName: profile.displayName,
        email: draftEmail.trim() || undefined,
        birthday: draftBirthday || undefined,
        instagram: draftInstagram.trim() || undefined,
        snapchat: draftSnapchat.trim() || undefined,
        twitter: draftTwitter.trim() || undefined,
        personalNotes: draftPersonalNotes.trim() || undefined,
      });
      setEditingProfile(false);
      showToast('Profile saved.', 'success');
      onSaved(profile.key);
    } finally { setSavingProfile(false); }
  }

  const caseIds = profile.cases.map(c => c.id!).filter(Boolean);
  const sales = profile.cases.filter(c => c.caseType === 'Sale');
  const followUps = profile.cases.filter(c => c.caseType === 'Follow-up');
  const lostSales = profile.cases.filter(c => c.caseType === 'Lost Sale');

  async function saveName() {
    if (!draftName.trim()) return;
    setSaving(true);
    try {
      await bulkUpdateCustomerInfo(caseIds, { customerName: draftName.trim() });
      setEditingName(false);
      showToast('Name updated across all cases.', 'success');
      onSaved(profile.key);
    } finally { setSaving(false); }
  }

  async function saveContact() {
    setSaving(true);
    try {
      await bulkUpdateCustomerInfo(caseIds, { contact: draftContact.trim() });
      setEditingContact(false);
      showToast('Contact updated across all cases.', 'success');
      onSaved(profile.key);
    } finally { setSaving(false); }
  }

  if (showMerge) {
    return (
      <MergeModal
        source={profile}
        allProfiles={allProfiles.filter(p => p.key !== profile.key)}
        onClose={() => setShowMerge(false)}
        onMerged={() => { setShowMerge(false); onSaved(profile.key); }}
        showToast={showToast}
      />
    );
  }

  return (
    <Modal open onClose={onClose} title="" size="lg"
      footer={
        <div className="flex items-center justify-between w-full">
          <button
            onClick={() => setShowMerge(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors"
          >
            <GitMerge className="w-3.5 h-3.5" /> Merge with…
          </button>
          <button onClick={onClose} className="btn-ghost">Close</button>
        </div>
      }
    >
      <div className="space-y-5">
        {/* Customer header */}
        <div className="space-y-3">
          {/* Name */}
          <div className="flex items-center gap-2">
            {editingName ? (
              <div className="flex items-center gap-2 flex-1">
                <input
                  autoFocus
                  value={draftName}
                  onChange={e => setDraftName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditingName(false); }}
                  className="input flex-1 text-lg font-bold"
                />
                <button onClick={saveName} disabled={saving} className="p-2 rounded-xl bg-brand-700 text-white hover:bg-brand-800 transition-colors">
                  <Check className="w-4 h-4" />
                </button>
                <button onClick={() => { setEditingName(false); setDraftName(profile.displayName); }} className="p-2 rounded-xl text-slate-400 hover:bg-slate-100 transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-1">
                <h2 className="text-xl font-bold text-slate-900">{profile.displayName}</h2>
                <button onClick={() => setEditingName(true)} className="p-1.5 rounded-lg text-slate-300 hover:text-brand-700 hover:bg-brand-50 transition-colors">
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>

          {/* Contact */}
          <div className="flex items-center gap-2">
            {editingContact ? (
              <div className="flex items-center gap-2 flex-1">
                <input
                  autoFocus
                  value={draftContact}
                  onChange={e => setDraftContact(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveContact(); if (e.key === 'Escape') setEditingContact(false); }}
                  placeholder="Phone / WhatsApp"
                  type="tel"
                  className="input flex-1"
                />
                <button onClick={saveContact} disabled={saving} className="p-2 rounded-xl bg-brand-700 text-white hover:bg-brand-800 transition-colors">
                  <Check className="w-4 h-4" />
                </button>
                <button onClick={() => { setEditingContact(false); setDraftContact(profile.contact ?? ''); }} className="p-2 rounded-xl text-slate-400 hover:bg-slate-100 transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-500 flex items-center gap-1.5">
                  <Phone className="w-3.5 h-3.5" />
                  {profile.contact || <span className="text-slate-300 italic">No number</span>}
                </span>
                <button onClick={() => setEditingContact(true)} className="p-1.5 rounded-lg text-slate-300 hover:text-brand-700 hover:bg-brand-50 transition-colors">
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-2">
          {[
            { icon: <TrendingUp className="w-4 h-4" />, label: 'Revenue', value: `${formatKD(profile.totalRevenue)} KD`, color: 'text-emerald-700' },
            { icon: <ShoppingBag className="w-4 h-4" />, label: 'Sales', value: String(sales.length), color: 'text-brand-700' },
            { icon: <Clock className="w-4 h-4" />, label: 'Follow-ups', value: String(followUps.length), color: 'text-amber-700' },
            { icon: <TrendingDown className="w-4 h-4" />, label: 'Lost', value: String(lostSales.length), color: 'text-rose-600' },
          ].map(({ icon, label, value, color }) => (
            <div key={label} className="bg-slate-50 rounded-2xl p-3 text-center">
              <div className={`flex justify-center mb-1 ${color} opacity-60`}>{icon}</div>
              <p className={`text-lg font-bold ${color}`}>{value}</p>
              <p className="text-[10px] text-slate-400 font-medium">{label}</p>
            </div>
          ))}
        </div>

        {/* Personal Info */}
        <div className="border border-slate-100 rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 bg-slate-50">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Personal Info</p>
            {profile.contact && !editingProfile && (
              <button onClick={() => setEditingProfile(true)}
                className="flex items-center gap-1 text-xs font-semibold text-brand-700 hover:text-brand-800 transition-colors">
                <Edit2 className="w-3 h-3" />
                {profile.record ? 'Edit' : 'Add'}
              </button>
            )}
          </div>

          {!profile.contact ? (
            <p className="px-4 py-3 text-xs text-slate-400 italic">Add a phone number to enable personal profile.</p>
          ) : editingProfile ? (
            <div className="px-4 py-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1 flex items-center gap-1">
                    <Mail className="w-3 h-3" /> Email
                  </label>
                  <input value={draftEmail} onChange={e => setDraftEmail(e.target.value)}
                    placeholder="email@example.com" type="email" className="input text-sm py-2" />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1 flex items-center gap-1">
                    <Cake className="w-3 h-3" /> Birthday
                  </label>
                  <input value={draftBirthday} onChange={e => setDraftBirthday(e.target.value)}
                    type="date" className="input text-sm py-2" />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1 flex items-center gap-1">
                    <Instagram className="w-3 h-3" /> Instagram
                  </label>
                  <input value={draftInstagram} onChange={e => setDraftInstagram(e.target.value)}
                    placeholder="@handle" className="input text-sm py-2" />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1 flex items-center gap-1">
                    <AtSign className="w-3 h-3" /> Snapchat
                  </label>
                  <input value={draftSnapchat} onChange={e => setDraftSnapchat(e.target.value)}
                    placeholder="username" className="input text-sm py-2" />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1 flex items-center gap-1">
                    <AtSign className="w-3 h-3" /> X / Twitter
                  </label>
                  <input value={draftTwitter} onChange={e => setDraftTwitter(e.target.value)}
                    placeholder="@handle" className="input text-sm py-2" />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1 flex items-center gap-1">
                  <StickyNote className="w-3 h-3" /> Personal Notes
                </label>
                <textarea value={draftPersonalNotes} onChange={e => setDraftPersonalNotes(e.target.value)}
                  placeholder="VIP customer, prefers morning calls, allergic to leather…"
                  rows={2} className="input text-sm resize-none" />
              </div>
              <div className="flex gap-2 pt-1">
                <button onClick={() => setEditingProfile(false)} className="btn-ghost flex-1" disabled={savingProfile}>Cancel</button>
                <button onClick={saveProfile} disabled={savingProfile} className="btn-primary flex-1">
                  {savingProfile ? 'Saving…' : 'Save Profile'}
                </button>
              </div>
            </div>
          ) : profile.record ? (
            <div className="px-4 py-3 grid grid-cols-2 gap-x-6 gap-y-2">
              {profile.record.birthday && (
                <div className="flex items-center gap-2 text-sm">
                  <Cake className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                  <span className="text-slate-700">
                    {(() => { try { return format(new Date(profile.record.birthday + 'T12:00:00'), 'd MMMM yyyy'); } catch { return profile.record.birthday; } })()}
                  </span>
                </div>
              )}
              {profile.record.email && (
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                  <span className="text-slate-700 truncate">{profile.record.email}</span>
                </div>
              )}
              {profile.record.instagram && (
                <div className="flex items-center gap-2 text-sm">
                  <Instagram className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                  <span className="text-slate-700">{profile.record.instagram}</span>
                </div>
              )}
              {profile.record.snapchat && (
                <div className="flex items-center gap-2 text-sm">
                  <AtSign className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                  <span className="text-slate-700">{profile.record.snapchat}</span>
                </div>
              )}
              {profile.record.twitter && (
                <div className="flex items-center gap-2 text-sm">
                  <AtSign className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                  <span className="text-slate-700">{profile.record.twitter}</span>
                </div>
              )}
              {profile.record.personalNotes && (
                <div className="col-span-2 flex items-start gap-2 text-sm mt-1">
                  <StickyNote className="w-3.5 h-3.5 text-slate-300 shrink-0 mt-0.5" />
                  <span className="text-slate-600 italic">{profile.record.personalNotes}</span>
                </div>
              )}
              {!profile.record.birthday && !profile.record.email && !profile.record.instagram && !profile.record.snapchat && !profile.record.twitter && !profile.record.personalNotes && (
                <p className="col-span-2 text-xs text-slate-300 italic">No info added yet.</p>
              )}
            </div>
          ) : (
            <p className="px-4 py-3 text-xs text-slate-400 italic">
              No profile info yet. <button onClick={() => setEditingProfile(true)} className="text-brand-700 font-semibold">Add now →</button>
            </p>
          )}
        </div>

        {/* Case timeline */}
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Interaction History</p>
          <div className="space-y-2.5 max-h-[340px] overflow-y-auto pr-1">
            {profile.cases.map(c => (
              <div key={c.id} className="flex gap-3 items-start">
                {/* Date badge */}
                <div className="shrink-0 w-10 text-center">
                  <p className="text-[10px] font-medium text-slate-400 leading-none">
                    {format(new Date(c.dateLogged + 'T12:00:00'), 'MMM')}
                  </p>
                  <p className="text-sm font-bold text-slate-700 leading-none mt-0.5">
                    {format(new Date(c.dateLogged + 'T12:00:00'), 'd')}
                  </p>
                </div>
                {/* Case info */}
                <div className="flex-1 min-w-0 bg-slate-50 rounded-xl p-3">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <CaseTypeBadge type={c.caseType} />
                    {c.brand && <span className="text-xs font-semibold text-slate-700">{c.brand}</span>}
                    {c.productType && <span className="text-xs text-slate-400">{c.productType}</span>}
                    {c.amountKD != null && c.amountKD > 0 && (
                      <span className="text-xs font-bold text-emerald-700 ml-auto">{formatKD(c.amountKD)} KD</span>
                    )}
                  </div>
                  {c.product && c.product !== c.brand && (
                    <p className="text-xs text-slate-500 mb-1">{c.product}</p>
                  )}
                  {c.lostReason && (
                    <p className="text-xs text-rose-600">Reason: {c.lostReason}</p>
                  )}
                  {c.followUpAction && (
                    <p className="text-xs text-amber-700">Action: {c.followUpAction}
                      {c.promisedCallback && ` · ${format(new Date(c.promisedCallback + 'T12:00:00'), 'd MMM yyyy')}`}
                    </p>
                  )}
                  {c.notes && (
                    <p className="text-xs text-slate-600 italic mt-1 leading-snug">"{c.notes}"</p>
                  )}
                  <p className="text-[10px] text-slate-300 mt-1">{c.staff} · {c.outlet || 'No outlet'} · {c.caseId}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── Merge modal ───────────────────────────────────────────────────────────────

function MergeModal({ source, allProfiles, onClose, onMerged, showToast }: {
  source: CustomerProfile;
  allProfiles: CustomerProfile[];
  onClose: () => void;
  onMerged: () => void;
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<CustomerProfile | null>(null);
  const [swapped, setSwapped] = useState(false);
  const [merging, setMerging] = useState(false);

  const mergeSource = swapped ? (target ?? source) : source;
  const mergeTarget = swapped ? source : (target ?? source);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return allProfiles.filter(p =>
      !q ||
      p.displayName.toLowerCase().includes(q) ||
      (p.contact && p.contact.includes(q))
    );
  }, [allProfiles, search]);

  async function doMerge() {
    if (!target) return;
    setMerging(true);
    try {
      const sourceCaseIds = mergeSource.cases.map(c => c.id!).filter(Boolean);
      await bulkUpdateCustomerInfo(sourceCaseIds, {
        customerName: mergeTarget.displayName,
        contact: mergeTarget.contact,
      });
      showToast(`Merged into ${mergeTarget.displayName}.`, 'success');
      onMerged();
    } finally { setMerging(false); }
  }

  return (
    <Modal open onClose={onClose} title="Merge Customers" size="lg"
      footer={<>
        <button onClick={onClose} className="btn-ghost" disabled={merging}>Cancel</button>
        <button onClick={doMerge} disabled={!target || merging}
          className="btn-primary flex items-center gap-1.5">
          <GitMerge className="w-4 h-4" />
          {merging ? 'Merging…' : 'Confirm Merge'}
        </button>
      </>}
    >
      <div className="space-y-4">
        {/* Merge direction preview */}
        {target && (
          <div className="bg-slate-50 rounded-2xl p-4">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Merge Direction</p>
            <div className="flex items-center gap-3">
              <div className="flex-1 text-center">
                <div className="w-10 h-10 rounded-full bg-rose-50 text-rose-600 font-bold text-sm flex items-center justify-center mx-auto mb-1">
                  {mergeSource.displayName.charAt(0).toUpperCase()}
                </div>
                <p className="text-xs font-semibold text-slate-700 truncate">{mergeSource.displayName}</p>
                <p className="text-[10px] text-slate-400">{mergeSource.visitCount} cases</p>
                <p className="text-[10px] text-rose-500 mt-0.5">will be absorbed</p>
              </div>
              <div className="flex flex-col items-center gap-1">
                <ArrowRight className="w-5 h-5 text-slate-400" />
                <button
                  onClick={() => setSwapped(s => !s)}
                  className="p-1.5 rounded-lg bg-slate-200 text-slate-500 hover:bg-brand-100 hover:text-brand-700 transition-colors"
                  title="Swap direction"
                >
                  <ArrowLeftRight className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="flex-1 text-center">
                <div className="w-10 h-10 rounded-full bg-brand-50 text-brand-700 font-bold text-sm flex items-center justify-center mx-auto mb-1">
                  {mergeTarget.displayName.charAt(0).toUpperCase()}
                </div>
                <p className="text-xs font-semibold text-slate-700 truncate">{mergeTarget.displayName}</p>
                <p className="text-[10px] text-slate-400">{mergeTarget.visitCount} cases</p>
                <p className="text-[10px] text-emerald-600 mt-0.5">identity kept</p>
              </div>
            </div>
            <p className="text-xs text-slate-500 text-center mt-3">
              All {mergeSource.visitCount} cases from <strong>{mergeSource.displayName}</strong> will use <strong>{mergeTarget.displayName}</strong>'s name and number.
            </p>
          </div>
        )}

        {/* Search for merge target */}
        {!target && (
          <>
            <p className="text-sm text-slate-600">
              Select the customer to merge <strong>{source.displayName}</strong> with:
            </p>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                autoFocus
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search by name or phone…"
                className="input pl-9"
              />
            </div>
          </>
        )}

        {!target && (
          <div className="max-h-[280px] overflow-y-auto space-y-1.5">
            {filtered.slice(0, 20).map(p => (
              <button
                key={p.key}
                onClick={() => setTarget(p)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-brand-50 transition-colors text-left"
              >
                <div className="w-8 h-8 rounded-full bg-slate-100 text-slate-600 font-bold text-sm flex items-center justify-center shrink-0">
                  {p.displayName.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-800 truncate">{p.displayName}</p>
                  {p.contact && <p className="text-xs text-slate-400 flex items-center gap-1"><Phone className="w-3 h-3" />{p.contact}</p>}
                </div>
                <span className="text-xs text-slate-400 shrink-0">{p.visitCount} cases</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="text-sm text-slate-400 text-center py-6">No customers found.</p>
            )}
          </div>
        )}

        {target && (
          <button onClick={() => setTarget(null)} className="text-xs text-slate-400 hover:text-slate-600 transition-colors">
            ← Choose a different customer
          </button>
        )}
      </div>
    </Modal>
  );
}
