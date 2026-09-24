import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MapPin, Clock, LogIn, LogOut, PlusCircle, ClipboardList, Bell, Users, ChevronRight,
  AlertTriangle, Cake, Gift, ArrowLeftRight,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useAppStore } from '../store';
import {
  getSettings, getTodayCases, getOpenFollowUps, getUpcomingOccasions, getMyShiftsToday, getLightspeedToday,
  logOutletChange, getRosterEmployees, type Occasion, type MyShift, type LightspeedToday,
} from '../db';
import { useLive } from '../shared/live';
import { dayHours } from '../shared/workedHours';
import { shopsFrom, sameOutlet } from '../utils/outlet';
import { followUpUrgency } from '../utils/followUps';
import { formatKD } from '../utils/formatKD';
import { caseLabel } from '../shared/caseLabels';
import { Modal } from './shared/Modal';
import type { Case } from '../types';

const todayKuwait = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuwait' });
const hhmm = (iso: string) => new Date(iso)
  .toLocaleTimeString('en-KW', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kuwait' });
const hm = (ms: number) => `${Math.floor(ms / 3600000)}h ${String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')}m`;

function greeting(): string {
  const h = Number(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Kuwait' }));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/**
 * The salesperson's opening screen.
 *
 * Four questions, in the order they come up walking onto the floor: where am
 * I and am I clocked in; is anybody waiting on me; how is my day going; and
 * who has something coming up that I should know about. Then the one action
 * the page exists for — logging the customer in front of you.
 *
 * "You" means the roster name this login sells under. On the shared shop
 * phone there is no such person, so the page speaks for the outlet instead:
 * the shop's follow-ups, the shop's visits, no clock, no till figures.
 */
export function SalesHome() {
  const { user, profile, role, salesName } = useAuth();
  const { activeOutlet, setActiveOutlet, showToast, refreshLog, lastStaff } = useAppStore();
  const navigate = useNavigate();
  const shared = role === 'staff';
  const personal = !shared && !!salesName;

  const [outlets, setOutlets] = useState<string[]>([]);
  /* The shared phone has to say who is moving; a person is themselves. */
  const [roster, setRoster] = useState<string[]>([]);
  const [mover, setMover] = useState('');
  const [cases, setCases] = useState<Case[]>([]);
  const [followUps, setFollowUps] = useState<Case[]>([]);
  const [occasions, setOccasions] = useState<Occasion[]>([]);
  const [shifts, setShifts] = useState<MyShift[]>([]);
  const [till, setTill] = useState<LightspeedToday | null>(null);
  const [switching, setSwitching] = useState(false);
  const [moving, setMoving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const today = todayKuwait();
  const outlet = activeOutlet ?? '';

  useEffect(() => {
    void getSettings().then(s => { setOutlets(shopsFrom(s.outlets)); setRoster(s.staffRoster); });
  }, []);
  useEffect(() => { if (shared && !mover && lastStaff) setMover(lastStaff); }, [shared, mover, lastStaff]);

  const load = useCallback(async () => {
    const [c, f, o, s, t] = await Promise.all([
      getTodayCases(),
      getOpenFollowUps(),
      getUpcomingOccasions(7).catch(() => [] as Occasion[]),
      user && !shared ? getMyShiftsToday(user.id) : Promise.resolve([] as MyShift[]),
      shared ? Promise.resolve(null) : getLightspeedToday(outlet || null).catch(() => null),
    ]);
    setCases(c); setFollowUps(f); setOccasions(o); setShifts(s); setTill(t); setLoaded(true);
  }, [user, shared, outlet]);

  useEffect(() => { void load(); }, [load, refreshLog]);
  useLive('sales-home', [
    { table: 'cases', filter: `date_logged=eq.${today}` },
    { table: 'attendance_records' },
  ], () => { void load(); });

  /* Mine: filed under my roster name when I am a person; at this shop when I
     am the shared phone. */
  const mine = useCallback((c: Case) =>
    personal ? c.staff === salesName : (!c.outlet || sameOutlet(c.outlet, outlet)), [personal, salesName, outlet]);

  const myCases = useMemo(() => cases.filter(mine), [cases, mine]);
  const myFollowUps = useMemo(() => followUps.filter(mine), [followUps, mine]);
  const overdue = myFollowUps.filter(c => followUpUrgency(c) === 'overdue').length;
  const dueToday = myFollowUps.filter(c => followUpUrgency(c) === 'today').length;
  const soon = occasions.filter(o => o.daysUntil <= 7);

  const counts = useMemo(() => ({
    browsing: myCases.filter(c => c.caseType === 'No Interaction').reduce((n, c) => n + (c.visitorCount ?? 1), 0),
    interested: myCases.filter(c => c.caseType === 'Follow-up').length,
    lost: myCases.filter(c => c.caseType === 'Lost Sale').length,
    manual: myCases.filter(c => c.caseType === 'Sale' && !c.linkedCaseId).length,
    manualKD: myCases.filter(c => c.caseType === 'Sale' && !c.linkedCaseId).reduce((t, c) => t + (c.amountKD ?? 0), 0),
  }), [myCases]);

  const open = shifts.find(s => !s.clockOut) ?? null;
  // Through the one rule, so a clock-in that went through twice is not counted twice.
  const workedMs = (dayHours(shifts).hours ?? 0) * 3_600_000;

  async function moveTo(to: string) {
    if (sameOutlet(to, outlet)) { setSwitching(false); return; }
    if (shared && !mover) { showToast('Choose who is moving first.', 'error'); return; }
    setMoving(true);
    try {
      /* The record goes in first: if the database refuses, the phone stays
         where it was rather than quietly showing one shop and logging another. */
      let employeeId: string | null = null;
      if (shared) {
        employeeId = (await getRosterEmployees()).get(mover) ?? null;
        if (!employeeId) throw new Error(`${mover} is not linked to an employee record yet. Ask the office to link the name.`);
      }
      await logOutletChange(to, outlet || null, employeeId);
      setActiveOutlet(to);
      showToast(`Now at ${to}`, 'success');
      setSwitching(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not record the move.', 'error');
    } finally {
      setMoving(false);
    }
  }

  const attention: { key: string; text: string; go: () => void }[] = [];
  if (overdue) attention.push({ key: 'overdue', text: `${overdue} follow-up${overdue > 1 ? 's' : ''} overdue`, go: () => navigate('/followups') });
  if (dueToday) attention.push({ key: 'today', text: `${dueToday} to call today`, go: () => navigate('/followups') });
  if (soon.length) attention.push({ key: 'occ', text: `${soon.length} customer ${soon.length > 1 ? 'occasions' : 'occasion'} this week`, go: () => navigate('/crm?tab=occasions') });

  const firstName = (salesName ?? profile?.full_name ?? '').split(' ')[0];

  if (!loaded) {
    return <div className="p-4 space-y-3">{[0, 1, 2].map(i => <div key={i} className="h-28 rounded-2xl bg-slate-100 animate-pulse" />)}</div>;
  }

  return (
    <div className="p-4 pb-28 space-y-4 max-w-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{greeting()}{firstName && !shared ? `, ${firstName}` : ''}</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kuwait' })}
        </p>
      </div>

      {/* ── where, and on the clock ── */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center gap-3">
          <MapPin className="w-4 h-4 text-brand-700 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-bold text-slate-900 truncate">{outlet || 'No outlet chosen'}</p>
            <p className="text-xs text-slate-500">{shared ? 'Shared shop phone' : 'Where your visits are logged today'}</p>
          </div>
          {outlets.length > 1 && (
            <button onClick={() => setSwitching(true)}
              className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 border-slate-200 text-sm font-semibold text-slate-700">
              <ArrowLeftRight className="w-4 h-4" /> Switch
            </button>
          )}
        </div>
        {!shared && (
          <div className="flex items-center gap-3 pt-3 border-t border-slate-100">
            <Clock className="w-4 h-4 text-slate-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-slate-700">
                {open ? <>Clocked in <span className="font-semibold">{hhmm(open.clockIn)}</span> · {hm(workedMs)} so far</>
                  : shifts.length ? <>{hm(workedMs)} today · out at {hhmm(shifts[shifts.length - 1].clockOut!)}</>
                  : 'Not clocked in yet'}
              </p>
              {open?.location && !sameOutlet(open.location, outlet) && (
                <p className="text-[11px] text-amber-700 mt-0.5">Clocked in at {open.location}. Use Switch if you have moved.</p>
              )}
            </div>
            {/* Clocking in and out stays in My Portal, where the location
                check and its explanations live. Clocking out never closes the
                day — that is Close Day, on Today's log. */}
            <button onClick={() => navigate('/portal')}
              className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 border-slate-200 text-sm font-semibold">
              {open ? <><LogOut className="w-4 h-4" /> Clock out</> : <><LogIn className="w-4 h-4" /> Clock in</>}
            </button>
          </div>
        )}
      </div>

      {/* ── the one action ── */}
      <button onClick={() => navigate('/entry')}
        className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl bg-brand-700 text-white font-bold text-base active:scale-[0.99] transition-transform">
        <PlusCircle className="w-5 h-5" /> Log a visit
      </button>

      {/* ── needs attention ── */}
      {attention.length > 0 && (
        <div className="card p-4 border-amber-200 bg-amber-50/60">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            <h2 className="font-bold text-slate-900 text-sm">Needs attention</h2>
          </div>
          <div className="space-y-1.5">
            {attention.map(a => (
              <button key={a.key} onClick={a.go} className="w-full flex items-center gap-2 text-left text-sm text-slate-700 py-1.5">
                <span className="flex-1">{a.text}</span>
                <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── today, for you ── */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3 -mr-2">
          <h2 className="font-bold text-slate-900">{personal ? 'Your day' : `Today at ${outlet || 'the shop'}`}</h2>
          <button onClick={() => navigate('/today')}
            className="flex items-center gap-1 px-3 py-3 -my-1.5 min-h-[44px] rounded-xl text-xs font-semibold text-brand-700 active:bg-brand-50">
            {myCases.length} {myCases.length === 1 ? 'visit' : 'visits'} <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <div className="grid grid-cols-4 gap-2 text-center">
          {([
            [caseLabel('No Interaction'), counts.browsing, 'text-slate-700'],
            [caseLabel('Follow-up'), counts.interested, 'text-amber-700'],
            ['Lost opp.', counts.lost, 'text-rose-700'],
            [caseLabel('Sale'), counts.manual, 'text-emerald-700'],
          ] as const).map(([l, v, tone]) => (
            <div key={l}>
              <p className={`text-xl font-bold leading-none ${tone}`}>{v}</p>
              <p className="text-[11px] text-slate-500 mt-1 leading-tight">{l}</p>
            </div>
          ))}
        </div>
        {till && (
          <p className="text-xs text-slate-500 mt-4 pt-3 border-t border-slate-100 flex items-baseline justify-between">
            <span>Lightspeed today</span>
            <span className="font-semibold text-slate-800 tabular-nums">{till.sales} {till.sales === 1 ? 'sale' : 'sales'} · {formatKD(till.revenue)} KD</span>
          </p>
        )}
        {!till && counts.manualKD > 0 && (
          <p className="text-xs text-slate-500 mt-4 pt-3 border-t border-slate-100 flex items-baseline justify-between">
            <span>Manual sales</span><span className="font-semibold text-slate-800 tabular-nums">{formatKD(counts.manualKD)} KD</span>
          </p>
        )}
      </div>

      {/* ── coming up ── */}
      {soon.length > 0 && (
        <div className="card p-4">
          <h2 className="font-bold text-slate-900 mb-2">Coming up</h2>
          <div className="divide-y divide-slate-100">
            {soon.slice(0, 5).map(o => (
              <button key={`${o.customerId}-${o.kind}-${o.date}`} onClick={() => navigate(`/crm?customer=${o.customerId}`)}
                className="w-full flex items-center gap-3 py-2.5 text-left">
                {o.kind === 'birthday' ? <Cake className="w-4 h-4 text-pink-500 shrink-0" /> : <Gift className="w-4 h-4 text-violet-500 shrink-0" />}
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold text-slate-800 truncate">{o.name}</span>
                  <span className="block text-xs text-slate-500">{o.label}{o.year && o.kind === 'birthday' ? ` · turning ${new Date(o.date).getFullYear() - o.year}` : ''}</span>
                </span>
                <span className={`text-xs font-semibold shrink-0 ${o.daysUntil === 0 ? 'text-pink-600' : 'text-slate-500'}`}>
                  {o.daysUntil === 0 ? 'Today' : o.daysUntil === 1 ? 'Tomorrow' : `in ${o.daysUntil} days`}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── quick actions ── */}
      <div className="grid grid-cols-3 gap-2">
        {([
          ['/today', ClipboardList, "Today's log"],
          ['/followups', Bell, 'Follow-ups'],
          ['/crm', Users, 'Customers'],
        ] as const).map(([to, Icon, label]) => (
          <button key={to} onClick={() => navigate(to)}
            className="card p-3 flex flex-col items-center gap-1.5 text-xs font-semibold text-slate-700 active:scale-[0.98]">
            <Icon className="w-5 h-5 text-slate-400" />{label}
          </button>
        ))}
      </div>

      {switching && (
        <Modal open onClose={() => !moving && setSwitching(false)} title="Which shop are you at now?">
          <p className="text-sm text-slate-500 mb-3">
            {shared
              ? 'Visits from this phone are logged at the shop you pick, and the move is recorded against the salesperson you name.'
              : 'Your visits from now on are logged at the shop you pick, and the move is recorded against your shift.'}
          </p>
          {shared && (
            <div className="mb-3">
              <label className="label">Who is moving?</label>
              <select value={mover} onChange={e => setMover(e.target.value)} className="input">
                <option value="">— Select —</option>
                {roster.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          )}
          <div className="space-y-2">
            {outlets.map(o => (
              <button key={o} disabled={moving} onClick={() => void moveTo(o)}
                className={`w-full flex items-center gap-3 p-4 rounded-2xl border-2 text-left ${sameOutlet(o, outlet) ? 'border-slate-900 bg-slate-50' : 'border-slate-200'}`}>
                <MapPin className="w-4 h-4 text-brand-700" />
                <span className="font-semibold text-slate-900 flex-1">{o}</span>
                {sameOutlet(o, outlet) && <span className="text-xs text-slate-500">Here now</span>}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
