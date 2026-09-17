import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  PlusCircle, Store, AlertTriangle, ChevronRight, LogIn, LogOut, Clock, WifiOff,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useAppStore } from '../store';
import { supabase } from '../lib/supabase';
import { getSettings, getOpenFollowUps } from '../db';
import { loadStoreDay, loadMonthToDate, loadMonthlyTarget, type StoreDayData } from '../db/storeToday';
import { storeDay, standings, STANDING_WORD, type TeamStanding } from '../utils/storeDay';
import { shopsFrom, sameOutlet } from '../utils/outlet';
import { followUpUrgency } from '../utils/followUps';
import { formatKDCompact } from '../utils/formatKD';
import { StoreDayDetail } from './StoreDayDetail';
import { Modal } from './shared/Modal';

const todayKuwait = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuwait' });
const hhmm = (iso: string | null) => (!iso ? '—' : new Date(iso)
  .toLocaleTimeString('en-KW', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kuwait' }));
const hm = (hours: number) => `${Math.floor(hours)}h ${String(Math.round((hours % 1) * 60)).padStart(2, '0')}m`;

/**
 * The manager's opening screen: is the shop open, is anything wrong, how is it
 * going, and where is the team.
 *
 * Deliberately not a dashboard. The monthly numbers, the brand breakdowns and
 * the charts already exist one tap away under More — this page answers the
 * questions somebody asks walking through the door, and it is meant to be read
 * in about five seconds and then left.
 *
 * It owns no data logic. The shop's state, who was expected and where everyone
 * stands come from utils/storeDay; the rows come from db/storeToday; the
 * follow-up buckets come from the same utils/followUps the Follow-ups tab uses.
 */
export function Home() {
  const { profile, role } = useAuth();
  const activeOutlet = useAppStore((s) => s.activeOutlet);
  const setActiveOutlet = useAppStore((s) => s.setActiveOutlet);
  const navigate = useNavigate();

  const [outlets, setOutlets] = useState<string[]>([]);
  const [workStart, setWorkStart] = useState('09:00');
  const [data, setData] = useState<StoreDayData | null>(null);
  const [mtd, setMtd] = useState<number | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [followUps, setFollowUps] = useState<{ overdue: number; today: number; total: number }>({ overdue: 0, today: 0, total: 0 });
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState(false);

  const today = todayKuwait();
  const outlet = activeOutlet ?? outlets[0] ?? '';

  useEffect(() => {
    void getSettings().then((s) => setOutlets(shopsFrom(s.outlets)));
    /* The shop's start time lives on the shared settings row the HQ app owns and
       the DSR's own AppSettings does not carry, so it is read directly. It only
       decides when "not in yet" becomes "not in". */
    void supabase.from('settings').select('work_start_time').maybeSingle()
      .then(({ data }) => { const w = (data as { work_start_time?: string } | null)?.work_start_time; if (w) setWorkStart(w); });
  }, []);

  const load = useCallback(async () => {
    if (!outlet) return;
    try {
      const [d, m, t, ups] = await Promise.all([
        loadStoreDay(outlet, today),
        loadMonthToDate(outlet, today),
        loadMonthlyTarget(outlet),
        getOpenFollowUps(),
      ]);
      const mine = ups.filter((c) => sameOutlet(c.outlet, outlet));
      const buckets = mine.map(followUpUrgency);
      setData(d); setMtd(m); setTarget(t);
      setFollowUps({
        overdue: buckets.filter((b) => b === 'overdue').length,
        today: buckets.filter((b) => b === 'today').length,
        total: mine.length,
      });
      setStale(false);
    } catch {
      /* Keep whatever is on screen and say it is old. A shop with bad wifi
         needs yesterday's answer more than it needs a blank page. */
      setStale(true);
    } finally {
      setLoading(false);
    }
  }, [outlet, today]);

  useEffect(() => { void load(); }, [load]);
  // The floor keeps moving while this is open; a minute is often enough.
  useEffect(() => { const t = setInterval(() => void load(), 60_000); return () => clearInterval(t); }, [load]);

  const shop = useMemo(
    () => (data ? storeDay(data.shifts, outlet, today) : null), [data, outlet, today]);
  const team = useMemo(() => {
    if (!data) return [] as TeamStanding[];
    const here = data.roster.filter((r) => sameOutlet(r.location, outlet));
    return standings(here, data.shifts, data.onLeave, today, { workStart, graceMinutes: 60 });
  }, [data, outlet, today, workStart]);

  const me = team.find((t) => t.member.fullName === profile?.full_name) ?? null;
  const sales = data?.cases.filter((c) => c.caseType === 'Sale') ?? [];
  const lost = data?.cases.filter((c) => c.caseType === 'Lost Sale') ?? [];
  const salesValue = sales.reduce((t, c) => t + (c.amountKd ?? 0), 0);
  const missing = team.filter((t) => t.standing === 'missing');

  const alerts: { key: string; text: string; go?: () => void }[] = [];
  if (data && !data.dayClosed && shop?.state === 'closed') {
    alerts.push({ key: 'close', text: 'Yesterday’s pattern: the day is not closed yet', go: () => navigate('/today') });
  }
  if (followUps.overdue) {
    alerts.push({ key: 'fu', text: `${followUps.overdue} follow-up${followUps.overdue > 1 ? 's' : ''} overdue`, go: () => navigate('/followups') });
  }
  for (const m of missing) {
    alerts.push({ key: `miss-${m.member.employeeId}`, text: `${m.member.fullName} was due in and has not clocked in`, go: () => navigate('/team') });
  }

  if (loading && !data) {
    return <div className="p-4 space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-28 rounded-2xl bg-slate-100 animate-pulse" />)}</div>;
  }

  return (
    <div className="p-4 pb-28 space-y-4 max-w-2xl mx-auto">
      {stale && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs">
          <WifiOff className="w-4 h-4 shrink-0" />
          Showing the last figures that reached this phone. They may be out of date.
        </div>
      )}

      {/* ── which shop ── */}
      {outlets.length > 1 && (
        <div className="flex rounded-xl border border-slate-200 overflow-hidden text-sm">
          {outlets.map((o) => (
            <button key={o} onClick={() => setActiveOutlet(o)}
              className={`flex-1 px-3 py-2.5 font-semibold ${sameOutlet(o, outlet) ? 'bg-slate-900 text-white' : 'bg-white text-slate-600'}`}>
              {o}
            </button>
          ))}
        </div>
      )}

      {/* ── store status ── */}
      <button onClick={() => setSheet(true)}
        className="w-full text-left card p-4 active:scale-[0.99] transition-transform">
        <div className="flex items-start gap-3">
          <span className={`mt-0.5 w-2.5 h-2.5 rounded-full shrink-0 ${
            shop?.state === 'open' ? 'bg-emerald-500' : shop?.state === 'closed' ? 'bg-slate-400' : 'bg-amber-500'}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Store className="w-4 h-4 text-slate-400 shrink-0" />
              <span className="font-bold text-slate-900 truncate">{outlet}</span>
              <span className={`text-sm font-semibold ${shop?.state === 'open' ? 'text-emerald-600' : 'text-slate-500'}`}>
                {shop?.state === 'open' ? 'Open' : shop?.state === 'closed' ? 'Closed' : 'Not opened'}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              {shop?.state === 'not_opened'
                ? 'Nobody has clocked in yet today.'
                : <>Opened {hhmm(shop!.openedAt)} by {shop!.openedBy}
                    {shop!.closedAt && <> · closed {hhmm(shop!.closedAt)} by {shop!.closedBy}</>}</>}
            </p>
            {!!shop?.onFloor.length && (
              <p className="text-xs text-slate-600 mt-1.5">
                <span className="font-semibold">{shop.onFloor.length} on the floor:</span>{' '}
                {shop.onFloor.map((s) => s.fullName ?? s.rosterName).join(', ')}
              </p>
            )}
          </div>
          <ChevronRight className="w-4 h-4 text-slate-300 shrink-0 mt-1" />
        </div>
      </button>

      {/* ── needs attention, only when there is something ── */}
      {alerts.length > 0 && (
        <div className="card p-4 border-amber-200 bg-amber-50/60">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            <h2 className="font-bold text-slate-900 text-sm">Needs attention</h2>
          </div>
          <div className="space-y-1.5">
            {alerts.map((a) => (
              <button key={a.key} onClick={a.go}
                className="w-full flex items-center gap-2 text-left text-sm text-slate-700 py-1.5">
                <span className="flex-1">{a.text}</span>
                <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── today ── */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3 -mr-2">
          <h2 className="font-bold text-slate-900">Today</h2>
          {/* The way to the full log and to Close Day. Padded to a real tap
              target: it was a 16px line of text, which is the wrong size for
              the one thing that has to be reachable every evening. */}
          <button onClick={() => navigate('/today')}
            className="flex items-center gap-1 px-3 py-3 -my-1.5 min-h-[44px] rounded-xl text-xs font-semibold text-brand-700 active:bg-brand-50">
            {data?.cases.length ?? 0} entries
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <p className="text-3xl font-bold text-slate-900 leading-none">
          {formatKDCompact(salesValue)} <span className="text-base font-semibold text-slate-400">KD</span>
        </p>
        <div className="grid grid-cols-3 gap-3 mt-4 text-center">
          {[['Sales', sales.length], ['Lost', lost.length], ['Interactions', data?.cases.length ?? 0]].map(([l, v]) => (
            <div key={l as string}>
              <p className="text-xl font-bold text-slate-900 leading-none">{v as number}</p>
              <p className="text-[11px] text-slate-500 mt-1">{l as string}</p>
            </div>
          ))}
        </div>
        {target != null && target > 0 && mtd != null && (
          <div className="mt-4 pt-3 border-t border-slate-100">
            <div className="flex items-baseline justify-between text-xs mb-1.5">
              <span className="text-slate-500">This month</span>
              <span className="text-slate-700"><span className="font-bold">{formatKDCompact(mtd)}</span> of {formatKDCompact(target)} KD</span>
            </div>
            <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full rounded-full bg-brand-600" style={{ width: `${Math.min(100, (mtd / target) * 100)}%` }} />
            </div>
            <p className="text-[11px] text-slate-400 mt-1">{Math.round((mtd / target) * 100)}% of the monthly target</p>
          </div>
        )}
      </div>

      {/* ── team today ── */}
      <button onClick={() => navigate('/team')} className="w-full text-left card p-4 active:scale-[0.99] transition-transform">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="font-bold text-slate-900">Team today</h2>
          <ChevronRight className="w-4 h-4 text-slate-300" />
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {([
            ['In now', team.filter((t) => t.standing === 'on_floor').length, 'text-emerald-600'],
            ['Done', team.filter((t) => t.standing === 'finished' || t.standing === 'late').length, 'text-slate-700'],
            ['Not in', missing.length, 'text-rose-600'],
            ['Leave / off', team.filter((t) => t.standing === 'leave' || t.standing === 'off').length, 'text-slate-400'],
          ] as const).map(([label, n, tone]) => (
            <span key={label} className="flex items-baseline gap-1.5">
              <span className={`text-lg font-bold ${tone}`}>{n}</span>
              <span className="text-xs text-slate-500">{label}</span>
            </span>
          ))}
        </div>
        <p className="text-[11px] text-slate-400 mt-2">
          {hm(team.reduce((t, s) => t + s.hoursToday, 0))} worked at this shop today
        </p>
      </button>

      {/* ── you ── */}
      <div className="card p-4">
        <div className="flex items-center gap-3">
          <Clock className="w-4 h-4 text-slate-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-bold text-slate-900 text-sm">You</p>
            <p className="text-xs text-slate-500">
              {!me ? 'Your clock-in is in My Portal.'
                : me.standing === 'on_floor' ? `Clocked in ${hhmm(me.firstIn)} · ${hm(me.hoursToday)} so far`
                : me.shifts.length ? `${hm(me.hoursToday)} today · last out ${hhmm(me.lastOut)}`
                : STANDING_WORD[me.standing]}
            </p>
          </div>
          <button onClick={() => navigate('/portal')}
            className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 border-slate-200 text-sm font-semibold">
            {me?.standing === 'on_floor' ? <><LogOut className="w-4 h-4" /> Clock out</> : <><LogIn className="w-4 h-4" /> Clock in</>}
          </button>
        </div>
      </div>

      {/* ── the one primary action ── */}
      <button onClick={() => navigate('/entry')}
        className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl bg-brand-700 text-white font-bold text-base active:scale-[0.99] transition-transform">
        <PlusCircle className="w-5 h-5" /> New Entry
      </button>

      {sheet && (
        <Modal open onClose={() => setSheet(false)} title="Store day" size="lg">
          <StoreDayDetail outlet={outlet} workStart={workStart} role={role} />
        </Modal>
      )}
    </div>
  );
}
