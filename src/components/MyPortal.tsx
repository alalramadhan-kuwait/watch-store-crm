import { useEffect, useMemo, useState } from 'react';
import MyRequests from './MyRequests';
import { dayPunctuality, punctualityTotals, shiftTimesOn } from '../shared/punctuality';
import { scheduleFromRow, type Schedule, type ScheduleRow } from '../shared/schedule';
import AskForSchedule from './AskForSchedule';
import {
  LogIn, LogOut, AlertCircle, CheckCircle, Home, Plus, Send, X, Pencil, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useAppStore } from '../store';
import { lateClassOf, isEarlyLeave, workingDaysBetween, kuwaitMinutes } from '../utils/attendance';
import { locationBlockedMessage, locationAlreadyDenied, CORRECTION_FALLBACK } from '../utils/locationHelp';
import { dayHours, totalHours, type DayHours } from '../shared/workedHours';
import {
  fencesNear, clockIn as portalClockIn, clockOut as portalClockOut,
  applyForLeave, reviseLeave, cancelLeave as portalCancelLeave,
  planCorrection, requestCorrection, submitRequest as portalSubmitRequest,
} from '../shared/portal';
import { useLive } from '../shared/live';

/**
 * The salesperson's own page: attendance, leave and HR record.
 *
 * It reads the same tables as Timekeeper Online's My Portal — row-level
 * security already limits each of them to the signed-in person's own rows —
 * so a salesperson never has to open the other app.
 */

interface EmpRecord {
  id: string; full_name: string; user_id: string | null; job_title: string | null; location: string | null;
  civil_id: string | null; passport_number: string | null; residency_expiry: string | null;
  work_permit_expiry: string | null; joining_date: string | null; annual_leave_entitlement: number | null;
  status: string | null; portal_enabled: boolean | null; phone: string | null;
  /** Mirrors whichever dated schedule is in force today. */
  shift_start: string | null; shift_end: string | null;
}
interface LeaveRec { id: string; leave_type: string; leave_start: string; leave_end: string; days: number; approval_status: string; manager_status?: string; notes: string | null; created_at: string; document_url: string | null }
interface AttRec { id: string; clock_in: string; clock_out: string | null; is_late: boolean; justified: boolean; location: string | null; correction_reason: string | null }
interface EmpRequest { id: string; request_type: string; details: string; status: string; manager_remarks: string | null; created_at: string }
interface Geofence { id: string; name: string; lat: number; lng: number; radius_m: number; active: boolean }

const STANDARD_DAY_HOURS = 8;
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-KW', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kuwait' });
const todayKuwait = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuwait' });
const kwDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kuwait' });

/** A month of records folded into one entry per Kuwait day, hours and all. The
 *  rule is in src/shared/workedHours.ts, so this agrees with the back office. */
const groupByDay = (records: Array<{ clock_in: string; clock_out: string | null }>) => {
  const raw = new Map<string, Array<{ clockIn: string; clockOut: string | null }>>();
  for (const r of records) {
    const d = kwDate(r.clock_in);
    if (!raw.has(d)) raw.set(d, []);
    raw.get(d)!.push({ clockIn: r.clock_in, clockOut: r.clock_out });
  }
  const out = new Map<string, DayHours>();
  for (const [d, shifts] of raw) out.set(d, dayHours(shifts));
  return out;
};

/** A Kuwait wall-clock time on a given day, as an instant. Kuwait is UTC+3 all
 *  year — no daylight saving — so the offset can be written down. */
const kuwaitISO = (date: string, time: string) => new Date(`${date}T${time}:00+03:00`).toISOString();
/** The HH:MM an instant reads as in Kuwait, for prefilling a time input. */
const kuwaitHM = (iso: string) => new Intl.DateTimeFormat('en-GB',
  { timeZone: 'Asia/Kuwait', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
const hm = (hours: number) => { const m = Math.max(0, Math.round(hours * 60)); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const fmtDur = (aIso: string, bIso: string | null, now: number) => {
  const mins = Math.max(0, Math.floor(((bIso ? new Date(bIso).getTime() : now) - new Date(aIso).getTime()) / 60000));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
};
/** A span of milliseconds as "7h 45m" — a day can now be several shifts added up. */
const fmtHrs = (ms: number) => {
  const mins = Math.max(0, Math.floor(ms / 60000));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
};
const dayLabel = (ymd?: string | null) => (ymd ? new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const stamp = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kuwait' }) : '');
const weekdayLabel = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'Asia/Kuwait' });
const monthLabel = (ym: string) => new Date(`${ym}-01T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthShift = (ym: string, n: number) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };

const STATUS_STYLE: Record<string, { dot: string; cls: string }> = {
  Pending: { dot: 'bg-amber-500', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  Approved: { dot: 'bg-emerald-500', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  Completed: { dot: 'bg-emerald-500', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  Rejected: { dot: 'bg-rose-500', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  Cancelled: { dot: 'bg-slate-400', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
};
const StatusPill = ({ s }: { s: string }) => {
  const st = STATUS_STYLE[s] ?? { dot: 'bg-slate-400', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
  return <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-xs font-semibold whitespace-nowrap ${st.cls}`}><span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} aria-hidden />{s}</span>;
};
const HrInfo = ({ label, value }: { label: string; value?: React.ReactNode }) => (
  <div>
    <div className="text-xs text-slate-400 mb-0.5">{label}</div>
    <div className="text-sm font-medium text-slate-700 break-words">
      {value == null || value === '' ? <span className="text-slate-300 font-normal">Not provided</span> : value}
    </div>
  </div>
);
const Spin = () => <span className="inline-block w-4 h-4 border-2 border-white/60 border-t-transparent rounded-full animate-spin" aria-hidden />;

export function MyPortal() {
  const { user, profile, role } = useAuth();
  const { showToast } = useAppStore();
  const [emp, setEmp] = useState<EmpRecord | null>(null);
  /* This person's own shift. Without it the page judged everybody against the
     office's 09:00 — so Avenues staff, whose hours deliberately vary, were told
     they were late for a shift nobody ever put them on. */
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [leaves, setLeaves] = useState<LeaveRec[]>([]);
  const [requests, setRequests] = useState<EmpRequest[]>([]);
  // Every clock-in for today, oldest first. A day can hold more than one shift
  // — a morning and an evening — so the page works from the list, never from
  // "the" record.
  const [todayRecs, setTodayRecs] = useState<AttRec[]>([]);
  const [monthRecs, setMonthRecs] = useState<AttRec[]>([]);
  const [geofences, setGeofences] = useState<Geofence[]>([]);
  const [workStart, setWorkStart] = useState('09:00');
  const [workEnd, setWorkEnd] = useState('17:00');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  // forms
  const [showLeaveForm, setShowLeaveForm] = useState(false);
  const [lvType, setLvType] = useState<'Annual' | 'Sick' | 'WFH'>('Annual');
  /* Working from home is not a thing a shop floor can do: the job is being in
     the shop with the customers. Offering it to a salesperson invites a request
     that can only ever be refused. Head office keeps it. */
  const canWorkFromHome = !(role === 'sales' || role === 'staff');
  const [lvStart, setLvStart] = useState('');
  const [lvEnd, setLvEnd] = useState('');
  const [lvNotes, setLvNotes] = useState('');
  const [lvFile, setLvFile] = useState<File | null>(null);
  const [showReqForm, setShowReqForm] = useState<null | 'HR update' | 'Attendance correction'>(null);
  const [reqDetails, setReqDetails] = useState('');
  /* A correction is about a specific day and specific times. Asked for as
     fields rather than left to a sentence: a paragraph can describe a problem
     without ever naming the time that fixes it, and then somebody has to write
     back and ask. */
  const [corDate, setCorDate] = useState(() => todayKuwait());
  const [corIn, setCorIn] = useState('');
  const [corOut, setCorOut] = useState('');
  const [corExisting, setCorExisting] = useState<AttRec[] | null>(null);
  /** Which shift is being corrected, so an evening departure is not attached to
   *  the morning's record. */
  const [corRecordId, setCorRecordId] = useState<string | null>(null);
  const [corNextDay, setCorNextDay] = useState(false);
  const [corLoading, setCorLoading] = useState(false);
  const [openReqId, setOpenReqId] = useState<string | null>(null);
  const [showAllReq, setShowAllReq] = useState(false);
  const [editLeaveId, setEditLeaveId] = useState<string | null>(null);
  const [edStart, setEdStart] = useState('');
  const [edEnd, setEdEnd] = useState('');

  // history
  const [showHistory, setShowHistory] = useState(false);
  const [histMonth, setHistMonth] = useState(() => todayKuwait().slice(0, 7));
  const [histRecs, setHistRecs] = useState<AttRec[]>([]);
  const [histLoading, setHistLoading] = useState(false);

  // keeps the live shift duration ticking while clocked in
  useEffect(() => { const t = setInterval(() => setNowMs(Date.now()), 30_000); return () => clearInterval(t); }, []);

  /* If the browser has already refused location, say so before the button is
     tapped rather than after. Somebody standing in the shop at 9am should not
     have to discover it by failing. */
  useEffect(() => {
    let live = true;
    void locationAlreadyDenied().then((denied) => {
      if (live && denied) setGeoError(`${locationBlockedMessage()}\n${CORRECTION_FALLBACK}`);
    });
    return () => { live = false; };
  }, []);

  /* What the day being corrected currently says, fetched as the date changes.
     Shown and prefilled rather than left blank: most corrections move one end
     of a shift, and retyping the end that was already right is how the right
     end gets broken. A day with no record at all is the other common case — a
     shift nobody clocked in for — and it has to be askable too. */
  useEffect(() => {
    if (showReqForm !== 'Attendance correction' || !user || !corDate) return;
    let live = true;
    setCorLoading(true);
    supabase.from('attendance_records')
      .select('id, clock_in, clock_out, is_late, justified, location, correction_reason')
      .eq('user_id', user.id)
      .gte('clock_in', `${corDate}T00:00:00+03:00`).lte('clock_in', `${corDate}T23:59:59+03:00`)
      .order('clock_in', { ascending: true })
      .then(({ data }) => {
        if (!live) return;
        const recs = (data ?? []) as AttRec[];
        setCorExisting(recs);
        /* The boxes are NOT filled in. They used to be, from the record — so the
           arrival came pre-answered and the leaving time, the thing actually
           wrong, was the only one left blank. An empty box now means "leave
           that end alone", which is what the help text always claimed. */
        setCorRecordId(recs.find(r => !r.clock_out)?.id ?? recs[0]?.id ?? null);
        setCorLoading(false);
      }, () => { if (live) { setCorExisting([]); setCorLoading(false); } });
    return () => { live = false; };
  }, [showReqForm, corDate, user?.id]);   // the id, not the object Supabase swaps on every token refresh

  async function load() {
    if (!user) { setLoading(false); return; }
    setLoadError(false);
    try {
      const today = todayKuwait();
      const monthStart = `${today.slice(0, 7)}-01`;
      const [empQ, geoQ, setQ, attQ, reqQ, monthQ] = await Promise.all([
        supabase.from('employees').select('*'),
        supabase.from('geofences').select('*').eq('active', true),
        supabase.from('settings').select('work_start_time, work_end_time').single(),
        supabase.from('attendance_records').select('id, clock_in, clock_out, is_late, justified, location, correction_reason')
          .eq('user_id', user.id).gte('clock_in', `${today}T00:00:00+03:00`).lte('clock_in', `${today}T23:59:59+03:00`)
          .order('clock_in', { ascending: true }),
        supabase.from('employee_requests').select('*').eq('user_id', user.id).order('created_at', { ascending: false }),
        supabase.from('attendance_records').select('id, clock_in, clock_out, is_late, justified, location, correction_reason')
          .eq('user_id', user.id).gte('clock_in', `${monthStart}T00:00:00+03:00`),
      ]);
      setMonthRecs((monthQ.data as AttRec[]) ?? []);
      // the HR record is linked by hand in Timekeeper Online; never matched by name
      const mine = ((empQ.data ?? []) as EmpRecord[]).find((e) => e.user_id === user.id) ?? null;
      setEmp(mine);
      if (mine?.id) {
        const { data: sch } = await supabase.from('employee_schedules')
          .select('id, employee_id, effective_from, effective_to, working_days, shift_start, shift_end, grace_minutes, note')
          .eq('employee_id', mine.id);
        setSchedules(((sch ?? []) as ScheduleRow[]).map(scheduleFromRow));
      } else {
        setSchedules([]);
      }
      setGeofences((geoQ.data as Geofence[]) ?? []);
      if (setQ.data?.work_start_time) setWorkStart(setQ.data.work_start_time as string);
      if (setQ.data?.work_end_time) setWorkEnd(setQ.data.work_end_time as string);
      setTodayRecs((attQ.data as AttRec[]) ?? []);
      setRequests((reqQ.data as EmpRequest[]) ?? []);
      if (mine) {
        const { data: lv } = await supabase.from('leave_records').select('*').eq('employee_id', mine.id).order('created_at', { ascending: false });
        setLeaves((lv as LeaveRec[]) ?? []);
      }
    } catch { setLoadError(true); }
    setLoading(false);
  }
  useEffect(() => { load(); }, [user?.id]);

  /* Their own day, kept current: a correction approved by HR, or a shift closed
     from another device, shows up without them reloading. Row-level security
     means only their own rows reach this. */
  useLive('my-portal', [
    { table: 'attendance_records', filter: user ? `user_id=eq.${user.id}` : undefined },
    { table: 'employee_requests', filter: user ? `user_id=eq.${user.id}` : undefined },
    { table: 'leave_records' },
  ], () => { void load(); }, { enabled: !!user }); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!showHistory || !user) return;
    setHistLoading(true);
    const [y, m] = histMonth.split('-').map(Number);
    const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    supabase.from('attendance_records')
      .select('id, clock_in, clock_out, is_late, justified, location, correction_reason')
      .eq('user_id', user.id)
      .gte('clock_in', `${histMonth}-01T00:00:00+03:00`)
      .lt('clock_in', `${nextMonth}T00:00:00+03:00`)
      .order('clock_in', { ascending: false })
      .then(({ data }) => { setHistRecs((data as AttRec[]) ?? []); setHistLoading(false); });
  }, [showHistory, histMonth, user?.id]);

  // ── clock in / out ────────────────────────────────────────────────────────
  function getPosition(): Promise<GeolocationPosition> {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error('GPS is not supported on this device')); return; }
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000 });
    });
  }

  async function clockIn() {
    if (geofences.length === 0) { setGeoError('No store location is set up yet. Ask your manager to add one.'); return; }
    setGeoError(null); setGeoLoading(true);
    try {
      const { coords: { latitude, longitude, accuracy } } = await getPosition();
      const near = fencesNear(geofences, { latitude, longitude, accuracy });
      const matched = near.find(n => n.inside)?.fence ?? null;
      if (!matched) {
        /* Name every workplace, not just the closest one. Someone who covers
           two shops reads "you are 340m from Avenues" as "this account is tied
           to Avenues", which is not what it says and not what the rule is. */
        const all = near.map(n => `${n.fence.name} ${Math.round(n.metres)}m`).join(', ');
        setGeoError(`You are not at any workplace, so there is nothing to clock in to. You can clock in at whichever one you are standing in — right now you are ${all} away.`);
        setGeoLoading(false); return;
      }
      const now = new Date();
      const err = await portalClockIn({
        userId: user!.id, employeeName: profile!.full_name, fenceName: matched.name,
        position: { latitude, longitude, accuracy },
        // Lateness is about when the day started. A second shift that begins in
        // the evening is not "late" — only the first clock-in is judged.
        isLate: todayRecs.length === 0 && lateClassOf(now.toISOString(), workStart) !== 'On time',
      });
      // Reload either way: a refusal usually means a shift is already open
      // (another phone or tab), and the page should show it rather than a stale button.
      if (err) setGeoError(err);
      else showToast(`Clocked in at ${matched.name}`, 'success');
      await load();
    } catch (err) {
      const e = err as { code?: number; message?: string };
      if (e.code === 1) setGeoError(`${locationBlockedMessage()}\n${CORRECTION_FALLBACK}`);
      else if (e.code === 3) setGeoError('Getting your location took too long. Try again.');
      else setGeoError(e.message ?? 'Could not get your location.');
    }
    setGeoLoading(false);
  }

  /**
   * Close the shift, with or without a location.
   *
   * A clock-out has never needed one — there is no geofence test on leaving,
   * only a flag — so refusing to write without a GPS fix enforced a rule that
   * does not exist and left the day open instead. That is how a salesperson who
   * could not clock out ended up asking for a correction, and how ten shifts
   * came to be open at once, the oldest for six weeks.
   *
   * The leaving time is what matters and the phone knows it. Where they were is
   * a second question, and "we could not confirm it" is a better answer than a
   * day that never ended. A timeout used to fall through to the raw browser
   * string with no advice at all; now every failure ends the same way.
   */
  async function clockOut() {
    const open = todayRecs.find(r => !r.clock_out);
    if (!open) return;
    setGeoError(null); setGeoLoading(true);
    let where: { latitude: number; longitude: number; accuracy: number } | null = null;
    let why: string | null = null;
    try {
      const { coords } = await getPosition();
      where = { latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy };
    } catch (err) {
      const e = err as { code?: number; message?: string };
      why = e.code === 1 ? locationBlockedMessage('clock out')
          : e.code === 3 ? 'Your phone took too long to find you.'
          : e.message ?? 'Your phone could not say where you are.';
    }
    const problem = await portalClockOut(open.id, where);
    if (problem) setGeoError(problem);
    else {
      if (why) setGeoError(`Clocked out. ${why}\nYour leaving time is recorded; your manager will see that the location could not be confirmed.`);
      showToast(why ? 'Clocked out — location not confirmed' : 'Clocked out', why ? 'info' : 'success');
      await load();
    }
    setGeoLoading(false);
  }

  // ── leave & requests ──────────────────────────────────────────────────────
  /* Their own shift end if HR has set one, otherwise the shop default. Telling
     somebody who finishes at 15:30 that they left early at 15:30 every day is
     how a warning stops being read. */
  const myShiftEnd = emp?.shift_end?.slice(0, 5) ?? workEnd;

  /* What the form is actually asking for, decided by the shared rule the request
     itself will use — so the button, the warning and the submitted request can
     never disagree. */
  const corRecord = useMemo(
    () => corExisting?.find(r => r.id === corRecordId) ?? corExisting?.[0] ?? null,
    [corExisting, corRecordId]);
  const corPlan = useMemo(() => planCorrection({
    date: corDate, arrivedAt: corIn, leftAt: corOut, leftNextDay: corNextDay,
    reason: reqDetails,
    record: corRecord && { id: corRecord.id, clock_in: corRecord.clock_in, clock_out: corRecord.clock_out },
  }), [corDate, corIn, corOut, corNextDay, reqDetails, corRecord]);

  const lvDays = useMemo(() => (lvStart && lvEnd && lvEnd >= lvStart ? workingDaysBetween(lvStart, lvEnd) : 0), [lvStart, lvEnd]);
  const edDays = useMemo(() => (edStart && edEnd && edEnd >= edStart ? workingDaysBetween(edStart, edEnd) : 0), [edStart, edEnd]);

  async function submitLeave() {
    if (!emp) return;
    if (!lvStart || !lvEnd || lvEnd < lvStart) { showToast('Pick a valid start and end date', 'error'); return; }
    setBusy(true);
    const problem = await applyForLeave({
      employeeId: emp.id, userId: user!.id, type: lvType, start: lvStart, end: lvEnd,
      days: lvDays, notes: lvNotes, document: lvFile,
    });
    setBusy(false);
    if (problem) { showToast(problem, 'error'); return; }
    showToast(`${lvType === 'WFH' ? 'Work from home' : `${lvType} leave`} requested — waiting for approval`, 'success');
    setShowLeaveForm(false); setLvStart(''); setLvEnd(''); setLvNotes(''); setLvFile(null);
    load();
  }

  /* Both kinds of request go through the shared layer now. The correction's
     rule — what is actually being asked for — is planCorrection, the same one
     the form has been describing as they typed, so the request cannot say
     something different from the button they pressed. */
  async function submitRequest() {
    if (!showReqForm) return;
    setBusy(true);
    const problem = showReqForm === 'Attendance correction'
      ? await requestCorrection({
          userId: user!.id, employeeId: emp?.id ?? null,
          date: corDate, arrivedAt: corIn, leftAt: corOut, leftNextDay: corNextDay,
          reason: reqDetails,
          record: corRecord && { id: corRecord.id, clock_in: corRecord.clock_in, clock_out: corRecord.clock_out },
        })
      : await portalSubmitRequest(user!.id, emp?.id ?? null, showReqForm, reqDetails);
    setBusy(false);
    if (problem) { showToast(problem, 'error'); return; }
    showToast('Sent to your manager', 'success');
    setShowReqForm(null); setReqDetails(''); setCorIn(''); setCorOut(''); setCorExisting(null);
    setCorRecordId(null); setCorNextDay(false); setCorDate(todayKuwait());
    load();
  }

  async function saveEditedLeave(rawId: string, wasApproved: boolean) {
    if (!edStart || !edEnd || edEnd < edStart) { showToast('Pick a valid start and end date', 'error'); return; }
    setBusy(true);
    // changing dates always returns the request to Pending — HR re-approves the new dates
    const problem = await reviseLeave(rawId, edStart, edEnd, edDays);
    setBusy(false);
    if (problem) { showToast(problem, 'error'); return; }
    showToast(wasApproved ? 'Dates changed — sent back to HR' : 'Leave dates updated', 'success');
    setEditLeaveId(null);
    load();
  }

  async function cancelLeave(rawId: string) {
    if (!window.confirm('Cancel this request? You would have to apply again.')) return;
    setBusy(true);
    const problem = await portalCancelLeave(rawId);
    setBusy(false);
    if (problem) { showToast(problem, 'error'); return; }
    showToast('Request cancelled', 'info');
    load();
  }

  async function openDocument(path: string) {
    const { data, error } = await supabase.storage.from('leave-docs').createSignedUrl(path, 300);
    if (error || !data?.signedUrl) { showToast('Could not open that document', 'error'); return; }
    window.open(data.signedUrl, '_blank', 'noopener');
  }

  // ── summaries ─────────────────────────────────────────────────────────────
  const leaveSummary = useMemo(() => {
    const year = new Date().getFullYear();
    const inYear = (l: LeaveRec) => new Date(l.leave_start).getFullYear() === year;
    const annualTaken = leaves.filter(l => l.leave_type === 'Annual' && l.approval_status === 'Approved' && inYear(l)).reduce((s, l) => s + Number(l.days), 0);
    const sickTaken = leaves.filter(l => l.leave_type === 'Sick' && l.approval_status === 'Approved' && inYear(l)).reduce((s, l) => s + Number(l.days), 0);
    const entitlement = Number(emp?.annual_leave_entitlement ?? 30);
    return { annualTaken, sickTaken, entitlement, remaining: entitlement - annualTaken };
  }, [leaves, emp]);

  const monthStats = useMemo(() => {
    // Group first: a split shift is one day worked, and the hours add up.
    // Counting per record would call a morning-plus-evening day two days, and
    // charge missing hours against each half of it.
    const byDay = groupByDay(monthRecs);
    const firstOfDay = new Map<string, AttRec>();
    for (const r of monthRecs) {
      const d = kwDate(r.clock_in);
      const seen = firstOfDay.get(d);
      if (!seen || r.clock_in < seen.clock_in) firstOfDay.set(d, r);
    }
    /* Lateness comes from the shared engine, against this person's own shift.
       It used to be worked out here against the office's start plus a
       hard-coded hour, which is a second opinion — and a wrong one for anybody
       not on the office's hours. */
    const punctDays = [...byDay.keys()].map((date) => dayPunctuality({
      date, schedules,
      records: (monthRecs.filter((r) => kwDate(r.clock_in) === date))
        .map((r) => ({ clockIn: r.clock_in, clockOut: r.clock_out, justified: r.justified })),
    }, { defaultStart: workStart, graceMinutes: 60 }));
    const punct = punctualityTotals(punctDays);
    const lateHours = punct.hoursLate;
    /* True when no day in the month could be judged: their hours vary, so there
       is no shift to be late against and a number would be invented. */
    const noShift = punct.days > 0 && punct.hoursLate === null;
    let missingHours = 0;
    for (const day of byDay.values()) {
      // A day still being worked is not short of anything yet, and a day nobody
      // clocked out of needs a correction before it can be judged at all.
      if (day.onTheFloor || day.unusableShifts > 0 || day.hours === null) continue;
      if (day.hours > 0 && day.hours < STANDARD_DAY_HOURS) missingHours += STANDARD_DAY_HOURS - day.hours;
    }
    const days = byDay.size;
    const late = punct.timesLate;
    const judged = punctDays.filter((d) => d.hoursLate !== null).length;
    return { days, late, onTime: Math.max(0, judged - late), judged, noShift, lateHours, missingHours };
  }, [monthRecs, workStart, schedules]);

  const histStats = useMemo(() => {
    const byDay = groupByDay(histRecs);
    const firstOfDay = new Map<string, AttRec>();
    for (const r of histRecs) {
      const d = kwDate(r.clock_in);
      const seen = firstOfDay.get(d);
      if (!seen || r.clock_in < seen.clock_in) firstOfDay.set(d, r);
    }
    const days = byDay.size;
    const hours = totalHours([...byDay.values()]);
    const late = [...firstOfDay.values()].filter(r => r.is_late && !r.justified).length;
    return { days, hours, late, onTime: Math.max(0, days - late) };
  }, [histRecs]);

  const allRequests = useMemo(() => [
    ...leaves.map(l => ({
      id: `lv-${l.id}`, rawId: l.id, kind: 'leave' as const, when: l.created_at,
      title: `${l.leave_type === 'WFH' ? 'Work from home' : `${l.leave_type} leave`}${l.days ? ` · ${l.days} day${Number(l.days) > 1 ? 's' : ''}` : ''}`,
      subtitle: l.leave_start === l.leave_end ? dayLabel(l.leave_start) : `${dayLabel(l.leave_start)} → ${dayLabel(l.leave_end)}`,
      status: l.approval_status, remarks: l.notes, doc: l.document_url, startDate: l.leave_start, endDate: l.leave_end,
      // Leave is signed off twice — the store manager first, then the owners.
      // While it is pending, say which desk it is sitting on.
      stage: l.approval_status !== 'Pending' ? ''
        : l.manager_status === 'Pending' ? 'With the store manager'
        : 'With the owners for final approval',
    })),
    ...requests.map(r => ({
      id: `rq-${r.id}`, rawId: r.id, kind: 'request' as const, when: r.created_at,
      title: r.request_type, subtitle: r.details,
      status: r.status, remarks: r.manager_remarks, doc: null as string | null, startDate: '', endDate: '',
      stage: '',
    })),
  ].sort((a, b) => (b.when ?? '').localeCompare(a.when ?? '')), [leaves, requests]);

  const todayLeave = useMemo(() => {
    const t = todayKuwait();
    return leaves.find(l => l.approval_status === 'Approved' && l.leave_start <= t && l.leave_end >= t) ?? null;
  }, [leaves]);

  if (loading) {
    return (
      <div className="px-4 pt-6 pb-32 max-w-lg mx-auto lg:max-w-4xl lg:px-8 space-y-4">
        <div className="h-8 w-40 bg-slate-100 rounded-lg animate-pulse" />
        <div className="h-52 card animate-pulse" />
        <div className="h-40 card animate-pulse" />
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="px-4 pt-6 pb-32 max-w-lg mx-auto lg:px-8">
        <div className="card p-8 text-center">
          <AlertCircle size={34} className="mx-auto text-rose-500 mb-3" />
          <p className="font-semibold text-slate-700">Your details could not be loaded</p>
          <button onClick={() => { setLoading(true); load(); }} className="btn-primary mt-4">Try again</button>
        </div>
      </div>
    );
  }

  // The shift that is still running, if any, and the one that opened the day.
  const openRec = todayRecs.find(r => !r.clock_out) ?? null;
  const firstRec = todayRecs[0] ?? null;
  const lastRec = todayRecs[todayRecs.length - 1] ?? null;
  const clockedIn = !!openRec;                    // currently at work
  const startedToday = todayRecs.length > 0;      // has worked at some point today
  const shiftsToday = todayRecs.length;
  // Total across every shift, with the open one still counting up.
  // Through the one rule, so a clock-in that went through twice is not counted twice.
  const workedTodayMs = (dayHours(
    todayRecs.map((r) => ({ clockIn: r.clock_in, clockOut: r.clock_out })), new Date(nowMs),
  ).hours ?? 0) * 3_600_000;
  // Only the first clock-in of the day carries the lateness.
  const lateClass = firstRec ? lateClassOf(firstRec.clock_in, workStart) : null;
  const lateLabel = lateClass && lateClass !== 'On time' && !firstRec?.justified ? lateClass : null;
  const portalReady = !!emp && emp.portal_enabled !== false;
  const onPaidLeaveToday = !!todayLeave && todayLeave.leave_type !== 'WFH';
  const wfhToday = todayLeave?.leave_type === 'WFH';
  const usedPct = leaveSummary.entitlement > 0 ? Math.min(100, Math.round((leaveSummary.annualTaken / leaveSummary.entitlement) * 100)) : 0;
  const shownRequests = showAllReq ? allRequests.slice(0, 20) : allRequests.slice(0, 4);
  /* When this person is due, from their own shift where they have one. Saying
     "Expected by 10:00" to somebody at Avenues, whose hours are assigned by the
     manager day by day, is stating the office's rule as if it were theirs. */
  const todaysShift = shiftTimesOn(schedules, todayKuwait(), { defaultStart: workStart });
  const graceEnd = (() => {
    if (!todaysShift.start) return null;
    const [h, m] = todaysShift.start.split(':').map(Number);
    const t = h * 60 + m + (todaysShift.graceMinutes ?? 60), hr = Math.floor(t / 60), mn = t % 60;
    return `${((hr + 11) % 12) + 1}:${String(mn).padStart(2, '0')} ${hr >= 12 ? 'PM' : 'AM'}`;
  })();
  const headerStatus = onPaidLeaveToday ? `On ${todayLeave!.leave_type.toLowerCase()} leave today`
    : wfhToday ? 'Working from home today'
    : clockedIn ? `Clocked in since ${fmtTime(openRec!.clock_in)}${lateLabel ? ` · ${lateLabel}` : ''}`
    : startedToday ? `Clocked out · ${fmtTime(lastRec!.clock_out!)}${shiftsToday > 1 ? ` · ${shiftsToday} shifts` : ''}`
    : 'Not clocked in';
  const headerDot = onPaidLeaveToday ? 'bg-sky-500' : wfhToday ? 'bg-violet-500'
    : clockedIn ? (lateLabel ? 'bg-amber-500' : 'bg-emerald-500')
    : startedToday ? 'bg-slate-400' : 'bg-slate-300';

  return (
    <div className="px-4 pt-6 pb-32 max-w-lg mx-auto lg:max-w-4xl lg:px-8 space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{emp?.full_name ?? profile?.full_name ?? 'My Portal'}</h1>
        <p className="mt-1 text-sm text-slate-500 flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${headerDot}`} aria-hidden />{headerStatus}
        </p>
      </div>

      {/* Today's attendance */}
      <section className="card p-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-base font-bold text-slate-800">Today</h2>
            <div className="mt-0.5 text-sm text-slate-500">
              {emp?.location ?? lastRec?.location ?? '—'}
              {lateLabel && <><span className="text-slate-300 mx-1.5">·</span><span className="text-amber-700">{lateLabel}</span></>}
              {firstRec?.justified && <><span className="text-slate-300 mx-1.5">·</span><span className="text-emerald-600">Justified</span></>}
            </div>
          </div>
          <div className="shrink-0">
            {clockedIn ? (
              <button onClick={clockOut} disabled={geoLoading}
                className="inline-flex items-center gap-2 bg-slate-900 text-white font-semibold px-5 py-3 rounded-xl active:scale-95 transition-all disabled:opacity-50">
                {geoLoading ? <Spin /> : <LogOut size={18} aria-hidden />}{geoLoading ? 'Locating…' : 'Clock Out'}
              </button>
            ) : onPaidLeaveToday ? (
              <span className="inline-flex items-center px-4 py-2.5 rounded-xl bg-sky-50 border border-sky-200 text-sky-700 font-semibold text-sm">
                On {todayLeave!.leave_type.toLowerCase()} leave
              </span>
            ) : (
              /* Clocking out is never the end of the day: a split shift comes
                 back in the evening, so the button always returns. */
              <div className="text-right">
                <button onClick={clockIn} disabled={geoLoading || geofences.length === 0}
                  className="btn-primary inline-flex items-center gap-2 disabled:opacity-50">
                  {geoLoading ? <Spin /> : <LogIn size={18} aria-hidden />}
                  {geoLoading ? 'Locating…' : startedToday ? 'Clock In Again' : 'Clock In'}
                </button>
                {startedToday && (
                  <div className="text-[11px] text-emerald-600 mt-1 flex items-center gap-1 justify-end">
                    <CheckCircle size={12} aria-hidden /> {fmtHrs(workedTodayMs)} so far today
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 border-y border-slate-100 py-3">
          <div><dt className="text-[11px] text-slate-400 uppercase tracking-wide">Days present</dt><dd className="mt-0.5 text-lg font-bold text-slate-800">{monthStats.days}</dd></div>
          <div><dt className="text-[11px] text-slate-400 uppercase tracking-wide">On time</dt><dd className="mt-0.5 text-lg font-bold text-slate-800">{monthStats.onTime}<span className="text-sm font-medium text-slate-400">/{monthStats.days}</span></dd></div>
          <div><dt className="text-[11px] text-slate-400 uppercase tracking-wide">Late hours</dt><dd className={`mt-0.5 text-lg font-bold ${(monthStats.lateHours ?? 0) > 0 ? 'text-amber-600' : 'text-slate-800'}`}>{monthStats.lateHours === null ? '—' : hm(monthStats.lateHours)}</dd>{monthStats.noShift && <dd className="text-[10px] text-slate-400 mt-0.5">hours vary</dd>}</div>
          <div><dt className="text-[11px] text-slate-400 uppercase tracking-wide">Missing hours</dt><dd className={`mt-0.5 text-lg font-bold ${monthStats.missingHours > 0 ? 'text-rose-600' : 'text-slate-800'}`}>{hm(monthStats.missingHours)}</dd></div>
        </dl>
        <p className="mt-1 text-[11px] text-slate-400">this month</p>

        <div className="mt-3 flex flex-wrap items-center gap-x-7 gap-y-2">
          <div className="flex items-baseline gap-2"><span className="text-[11px] font-semibold text-slate-400 uppercase">First in</span><span className="text-base font-semibold text-slate-800">{firstRec ? fmtTime(firstRec.clock_in) : '—'}</span></div>
          <div className="flex items-baseline gap-2"><span className="text-[11px] font-semibold text-slate-400 uppercase">Last out</span><span className="text-base font-semibold text-slate-800">{lastRec?.clock_out ? fmtTime(lastRec.clock_out) : '—'}</span></div>
          <div className="flex items-baseline gap-2"><span className="text-[11px] font-semibold text-slate-400 uppercase">Total</span><span className="text-base font-semibold text-slate-800">{startedToday ? fmtHrs(workedTodayMs) : '—'}</span></div>
        </div>

        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span className="text-slate-400">
            {graceEnd ? `Expected by ${graceEnd}` : 'Hours vary — no fixed start today'}
          </span>
          {!clockedIn && lastRec?.clock_out && isEarlyLeave(lastRec.clock_out, myShiftEnd) && (
            <span className="text-amber-600">Left before {myShiftEnd} — counts as early leave unless approved.</span>
          )}
          {firstRec?.correction_reason && <span className="text-blue-600">Corrected by manager: {firstRec.correction_reason}</span>}
        </div>

        {geoError && (
          <div role="alert" className="mt-3 flex items-start gap-2 px-3 py-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm">
            <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden />
            <span className="whitespace-pre-line leading-relaxed">{geoError}</span>
          </div>
        )}

        {/* Asking for a correction should not depend on where you are in the
            day — a forgotten clock-in is noticed at any point. */}
        {!onPaidLeaveToday && (
          <button onClick={() => { setShowReqForm(showReqForm === 'Attendance correction' ? null : 'Attendance correction'); setShowLeaveForm(false); }}
            className="mt-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
            <Pencil size={13} aria-hidden /> Ask for a correction
          </button>
        )}
      </section>

      {/* Request form */}
      {showReqForm && (
        <section className="card p-5 border-brand-200">
          <h2 className="text-sm font-bold text-slate-700 mb-2">
            {showReqForm === 'HR update' ? 'Ask to update my details' : 'Ask for an attendance correction'}
          </h2>

          {showReqForm === 'Attendance correction' && (
            <div className="mb-3 space-y-3">
              <label className="block">
                <span className="block text-xs font-semibold text-slate-500 mb-1">Which day</span>
                {/* Any past day. A missed clock-out is usually noticed when the
                    month's hours are read, not on the day it happened. */}
                <input type="date" value={corDate} max={todayKuwait()}
                  onChange={e => { setCorDate(e.target.value); setCorIn(''); setCorOut(''); setCorNextDay(false); }}
                  className="input" />
              </label>

              <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-2 text-xs">
                <span className="font-semibold text-slate-500">Recorded now: </span>
                {corLoading ? <span className="text-slate-400">checking…</span>
                  : !corExisting?.length ? <span className="text-amber-700">nothing — no clock-in for that day</span>
                  : corExisting.length === 1 ? <span className="text-slate-600">
                      {fmtTime(corExisting[0].clock_in)} → {corExisting[0].clock_out
                        ? fmtTime(corExisting[0].clock_out)
                        : <span className="text-amber-700">never clocked out</span>}
                    </span>
                  : <span className="block mt-1 space-y-1">
                      {/* Only asked when the day has more than one shift — otherwise
                          fixing an evening departure lands on the morning record. */}
                      <span className="block text-slate-500">Which one is wrong?</span>
                      {corExisting.map(r => (
                        <label key={r.id} className="flex items-center gap-2 text-slate-600">
                          <input type="radio" name="corShift" checked={corRecordId === r.id}
                            onChange={() => setCorRecordId(r.id)} />
                          <span>{fmtTime(r.clock_in)} → {r.clock_out
                            ? fmtTime(r.clock_out)
                            : <span className="text-amber-700">never clocked out</span>}</span>
                        </label>
                      ))}
                    </span>}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="block text-xs font-semibold text-slate-500 mb-1">I arrived at</span>
                  <input type="time" value={corIn} onChange={e => setCorIn(e.target.value)} className="input" />
                  <span className="block text-[11px] text-slate-400 mt-0.5">
                    {corRecord ? `now ${kuwaitHM(corRecord.clock_in)} — leave empty to keep it` : 'nothing recorded'}
                  </span>
                </label>
                <label className="block">
                  <span className="block text-xs font-semibold text-slate-500 mb-1">I left at</span>
                  <input type="time" value={corOut} onChange={e => setCorOut(e.target.value)} className="input" />
                  <span className="block text-[11px] text-slate-400 mt-0.5">
                    {corRecord?.clock_out ? `now ${kuwaitHM(corRecord.clock_out)} — leave empty to keep it`
                      : corRecord ? 'never clocked out' : 'nothing recorded'}
                  </span>
                </label>
              </div>

              {/* Offers, not prefills. The one value somebody in this position
                  needs is the one the form never used to help with. */}
              {!corRecord?.clock_out && corDate === todayKuwait() && (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="text-slate-400">Left at</span>
                  <button type="button" onClick={() => setCorOut(kuwaitHM(new Date().toISOString()) ?? '')}
                    className="px-2 py-0.5 rounded-full border border-slate-200 text-slate-600">now</button>
                  {myShiftEnd && (
                    <button type="button" onClick={() => setCorOut(myShiftEnd)}
                      className="px-2 py-0.5 rounded-full border border-slate-200 text-slate-600">
                      my shift ends ({myShiftEnd})
                    </button>
                  )}
                </div>
              )}

              {/* Only offered once the times say the shift ran past midnight. */}
              {corOut && (corIn || corRecord) && corOut <= (corIn || kuwaitHM(corRecord!.clock_in) || '') && (
                <label className="flex items-center gap-2 text-xs text-slate-600">
                  <input type="checkbox" checked={corNextDay} onChange={e => setCorNextDay(e.target.checked)} />
                  I left after midnight, the next morning
                </label>
              )}

              {corPlan.problem
                ? <p className="text-[11px] text-amber-700">{corPlan.problem}</p>
                : <p className="text-[11px] text-slate-400">Approving writes this onto the record.</p>}
            </div>
          )}

          <span className="block text-xs font-semibold text-slate-500 mb-1">
            {showReqForm === 'HR update' ? 'What needs changing' : 'Why the change is needed'}
          </span>
          {/* No autoFocus: it opened the keyboard on the reason and scrolled the
              times out of sight, which is how somebody sent a request that named
              neither of them. */}
          <textarea value={reqDetails} onChange={e => setReqDetails(e.target.value)} rows={3}
            placeholder={showReqForm === 'HR update' ? 'e.g. My phone number changed to 9xxxxxxx' : 'e.g. Phone died at the end of the shift, Hussain saw me leave'}
            className="input resize-none mb-3" />
          <div className="flex items-center gap-2">
            <button onClick={submitRequest}
              disabled={busy || (showReqForm === 'Attendance correction' && !!corPlan.problem)}
              className="btn-primary inline-flex items-center gap-1.5 disabled:opacity-60">
              <Send size={14} aria-hidden />
              {busy ? 'Sending…'
                : showReqForm === 'Attendance correction' && corPlan.summary ? corPlan.summary
                : 'Send'}
            </button>
            <button onClick={() => { setShowReqForm(null); setCorIn(''); setCorOut(''); setCorNextDay(false); }}
              className="btn-ghost">Cancel</button>
          </div>
        </section>
      )}

      {/* Leave */}
      <section className="card p-5">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="text-base font-bold text-slate-800">My Leave</h2>
          {portalReady && (
            <button onClick={() => { setShowLeaveForm(v => !v); setLvType('Annual'); setShowReqForm(null); }}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 border-slate-200 text-slate-700 text-sm font-semibold active:scale-95 transition-all">
              <Plus size={15} aria-hidden /> Apply
            </button>
          )}
        </div>

        {!portalReady ? (
          <p className="text-sm text-slate-400">
            {emp ? 'Portal access is switched off for your account — ask HR.' : 'Your HR record is not linked to this login yet. Ask your manager to link it.'}
          </p>
        ) : (
          <>
            <div className="text-sm font-medium text-slate-500">Annual leave</div>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span className={`text-4xl font-bold leading-none ${leaveSummary.remaining <= 5 ? 'text-amber-600' : 'text-slate-900'}`}>{leaveSummary.remaining}</span>
              <span className="text-sm text-slate-500">days left</span>
            </div>
            <div className="mt-3">
              <div className="flex justify-between text-xs text-slate-500 mb-1"><span>{leaveSummary.annualTaken} of {leaveSummary.entitlement} used</span><span>{usedPct}%</span></div>
              <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden" role="progressbar" aria-valuenow={leaveSummary.annualTaken} aria-valuemin={0} aria-valuemax={leaveSummary.entitlement} aria-label="Annual leave used">
                <div className={`h-full rounded-full ${leaveSummary.remaining <= 5 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${usedPct}%` }} />
              </div>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-100">
              <span className="text-sm font-medium text-slate-500">Sick leave</span>
              <span className="ml-2 text-slate-800"><b className="text-lg">{leaveSummary.sickTaken}</b> <span className="text-sm text-slate-500">{leaveSummary.sickTaken === 1 ? 'day' : 'days'} taken</span></span>
            </div>

            {showLeaveForm && (
              <div className="mt-4 p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-3">
                <div>
                  <label className="label">Type</label>
                  <select value={lvType} onChange={e => setLvType(e.target.value as typeof lvType)} className="input">
                    <option value="Annual">Annual leave</option>
                    <option value="Sick">Sick leave</option>
                    {canWorkFromHome && <option value="WFH">Work from home</option>}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div><label className="label">Start</label><input type="date" value={lvStart} onChange={e => setLvStart(e.target.value)} className="input" /></div>
                  <div><label className="label">End</label><input type="date" value={lvEnd} onChange={e => setLvEnd(e.target.value)} className="input" /></div>
                </div>
                <div className="px-4 py-2.5 rounded-xl bg-white border border-slate-200 text-sm">
                  <span className="text-slate-500">Working days:</span> <b className="text-slate-800">{lvDays || '—'}</b>
                  <span className="text-xs text-slate-400 ml-2">Fridays do not count</span>
                </div>
                <textarea value={lvNotes} onChange={e => setLvNotes(e.target.value)} rows={2} placeholder="Reason (optional)" className="input resize-none" />
                {lvType === 'Sick' && (
                  <div>
                    <label className="label">Sick note (photo or PDF, optional)</label>
                    <input type="file" accept="image/*,application/pdf" onChange={e => setLvFile(e.target.files?.[0] ?? null)}
                      className="block w-full text-sm text-slate-600 file:mr-3 file:px-3 file:py-2 file:rounded-xl file:border-0 file:bg-slate-900 file:text-white file:text-xs file:font-semibold" />
                    {lvFile && <p className="text-xs text-slate-400 mt-1">Attached: {lvFile.name}</p>}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <button onClick={submitLeave} disabled={busy} className="btn-primary inline-flex items-center gap-1.5 disabled:opacity-60">
                    <Send size={14} aria-hidden /> {busy ? 'Sending…' : 'Submit'}
                  </button>
                  <button onClick={() => setShowLeaveForm(false)} className="btn-ghost">Cancel</button>
                </div>
                {lvType === 'WFH' && <p className="text-xs text-slate-400">Working from home does not use your leave balance.</p>}
              </div>
            )}
          </>
        )}
      </section>

      {/* Requests */}
      <section className="card p-5">
        <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
          <h2 className="text-base font-bold text-slate-800">My Requests</h2>
          <div className="flex items-center gap-3">
            {portalReady && (
              <button onClick={() => {
                const t = todayKuwait();
                setLvType('WFH'); setLvStart(t); setLvEnd(t); setShowLeaveForm(true); setShowReqForm(null);
              }} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 border-slate-200 text-slate-700 text-sm font-semibold active:scale-95 transition-all">
                <Home size={15} aria-hidden /> WFH
              </button>
            )}
            {allRequests.length > 4 && (
              <button onClick={() => setShowAllReq(v => !v)} className="text-sm text-slate-500 hover:text-slate-800">{showAllReq ? 'Show less' : 'View all'}</button>
            )}
          </div>
        </div>

        {allRequests.length === 0 ? (
          <p className="py-5 text-center text-sm text-slate-400">Nothing yet. Leave, WFH and correction requests show up here.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {shownRequests.map(r => {
              const open = openReqId === r.id;
              const editable = portalReady && r.kind === 'leave' && (r.status === 'Pending' || r.status === 'Approved');
              const editing = editLeaveId === r.rawId;
              return (
                <li key={r.id}>
                  <div role="button" tabIndex={0}
                    onClick={() => setOpenReqId(open ? null : r.id)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenReqId(open ? null : r.id); } }}
                    className="py-3 cursor-pointer">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-slate-800">{r.title}</div>
                        <div className="text-xs text-slate-500 mt-0.5">{r.subtitle}</div>
                        <div className="text-[11px] text-slate-400 mt-0.5">Sent {stamp(r.when)}</div>
                        {r.stage && <div className="text-[11px] text-amber-600 mt-0.5">{r.stage}</div>}
                      </div>
                      <StatusPill s={r.status} />
                    </div>
                    {open && (r.remarks || r.doc || editable) && (
                      <div className="mt-2 text-xs text-slate-500 space-y-2" onClick={e => e.stopPropagation()}>
                        {r.remarks && <p className="italic">↳ {r.remarks}</p>}
                        {r.doc && <button onClick={() => openDocument(r.doc!)} className="block text-brand-700 font-medium">View document</button>}
                        {editable && !editing && (
                          <div className="flex flex-wrap items-center gap-4 pt-1">
                            <button onClick={() => { setEditLeaveId(r.rawId); setEdStart(r.startDate); setEdEnd(r.endDate); }}
                              className="inline-flex items-center gap-1 text-slate-600 font-medium"><Pencil size={12} aria-hidden /> Change dates</button>
                            <button onClick={() => cancelLeave(r.rawId)} disabled={busy}
                              className="inline-flex items-center gap-1 text-rose-600 font-medium disabled:opacity-50"><X size={12} aria-hidden /> Cancel</button>
                            {r.status === 'Approved' && <span className="text-slate-400">Changing dates sends it back to HR.</span>}
                          </div>
                        )}
                        {editable && editing && (
                          <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                            <div className="grid grid-cols-2 gap-2">
                              <div><label className="label">Start</label><input type="date" value={edStart} onChange={e => setEdStart(e.target.value)} className="input" /></div>
                              <div><label className="label">End</label><input type="date" value={edEnd} onChange={e => setEdEnd(e.target.value)} className="input" /></div>
                            </div>
                            <p className="text-xs text-slate-500">Working days: <b className="text-slate-800">{edDays || '—'}</b></p>
                            <div className="flex items-center gap-2">
                              <button onClick={() => saveEditedLeave(r.rawId, r.status === 'Approved')} disabled={busy}
                                className="btn-primary text-xs py-2 px-3 inline-flex items-center gap-1.5 disabled:opacity-60"><Send size={12} aria-hidden /> {busy ? 'Saving…' : 'Save'}</button>
                              <button onClick={() => setEditLeaveId(null)} className="btn-ghost text-xs py-2">Cancel</button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Attendance history */}
      <section className="card p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-bold text-slate-800">Attendance History</h2>
          <button onClick={() => setShowHistory(v => !v)} aria-expanded={showHistory} className="text-sm text-slate-500 hover:text-slate-800">
            {showHistory ? 'Hide' : 'View'}
          </button>
        </div>

        {showHistory && (
          <div className="mt-4">
            <div className="flex items-center gap-2 mb-3">
              <button onClick={() => setHistMonth(m => monthShift(m, -1))} aria-label="Previous month"
                className="h-9 w-9 inline-flex items-center justify-center rounded-xl border-2 border-slate-200 text-slate-600 active:scale-95"><ChevronLeft size={16} /></button>
              <span className="text-sm font-semibold text-slate-700 flex-1 text-center">{monthLabel(histMonth)}</span>
              <button onClick={() => setHistMonth(m => monthShift(m, 1))} aria-label="Next month" disabled={histMonth >= todayKuwait().slice(0, 7)}
                className="h-9 w-9 inline-flex items-center justify-center rounded-xl border-2 border-slate-200 text-slate-600 disabled:opacity-40 active:scale-95"><ChevronRight size={16} /></button>
            </div>

            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 border-y border-slate-100 py-3 mb-3">
              <div><dt className="text-[11px] text-slate-400 uppercase tracking-wide">Days</dt><dd className="mt-0.5 text-lg font-bold text-slate-800">{histStats.days}</dd></div>
              <div><dt className="text-[11px] text-slate-400 uppercase tracking-wide">Hours</dt><dd className="mt-0.5 text-lg font-bold text-slate-800">{hm(histStats.hours)}</dd></div>
              <div><dt className="text-[11px] text-slate-400 uppercase tracking-wide">On time</dt><dd className="mt-0.5 text-lg font-bold text-slate-800">{histStats.onTime}<span className="text-sm font-medium text-slate-400">/{histStats.days}</span></dd></div>
              <div><dt className="text-[11px] text-slate-400 uppercase tracking-wide">Late days</dt><dd className={`mt-0.5 text-lg font-bold ${histStats.late ? 'text-amber-600' : 'text-slate-800'}`}>{histStats.late}</dd></div>
            </dl>

            {histLoading ? (
              <p className="py-5 text-center text-sm text-slate-400">Loading…</p>
            ) : histRecs.length === 0 ? (
              <p className="py-5 text-center text-sm text-slate-400">Nothing recorded in {monthLabel(histMonth)}.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {histRecs.map(r => {
                  // is_late was decided at clock-in; the class is recomputed from the
                  // work-start time as it stands now. If that has since changed they can
                  // disagree, and an amber dot reading "On time" helps nobody.
                  const cls = lateClassOf(r.clock_in, workStart);
                  const st = r.justified ? { t: 'Justified', dot: 'bg-emerald-500', c: 'text-emerald-600' }
                    : r.is_late ? { t: cls === 'On time' ? 'Late' : cls, dot: 'bg-amber-500', c: 'text-amber-600' }
                    : { t: 'On time', dot: 'bg-emerald-500', c: 'text-emerald-600' };
                  return (
                    <li key={r.id} className="py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span className="w-28 shrink-0 text-sm font-semibold text-slate-700">{weekdayLabel(r.clock_in)}</span>
                      <span className="text-sm text-slate-700"><span className="text-[11px] text-slate-400 uppercase mr-1">In</span>{fmtTime(r.clock_in)}</span>
                      <span className="text-sm text-slate-700"><span className="text-[11px] text-slate-400 uppercase mr-1">Out</span>{r.clock_out ? fmtTime(r.clock_out) : '—'}</span>
                      <span className="text-sm text-slate-700"><span className="text-[11px] text-slate-400 uppercase mr-1">Total</span>{r.clock_out ? fmtDur(r.clock_in, r.clock_out, nowMs) : '—'}</span>
                      <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${st.c}`}><span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} aria-hidden />{st.t}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* HR record */}
      <section className="card p-5">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="text-base font-bold text-slate-800">My Details</h2>
          {portalReady && (
            <button onClick={() => { setShowReqForm(showReqForm === 'HR update' ? null : 'HR update'); setShowLeaveForm(false); }}
              className="text-sm text-slate-500 hover:text-slate-800">Ask to update</button>
          )}
        </div>
        {!emp ? (
          <p className="text-sm text-slate-400">Your HR record is not linked to this login yet. Ask your manager to link it.</p>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-5 gap-y-4">
            <HrInfo label="Job title" value={emp.job_title} />
            <HrInfo label="Outlet" value={emp.location} />
            <HrInfo label="Phone" value={emp.phone} />
            <HrInfo label="Joined" value={dayLabel(emp.joining_date)} />
            <HrInfo label="Civil ID" value={emp.civil_id} />
            <HrInfo label="Residency expiry" value={dayLabel(emp.residency_expiry)} />
            <HrInfo label="Work permit expiry" value={dayLabel(emp.work_permit_expiry)} />
            <HrInfo label="Login" value={user?.email} />
          </div>
        )}
      </section>

      {/* Everything I have asked for, and the way to ask for different hours.
          Neither existed on this app: a request could be raised and then only
          watched, and a schedule could only be changed by somebody at a desk. */}
      <MyRequests userId={user?.id ?? null} />
      <div>
        <AskForSchedule employeeId={emp?.id ?? null} userId={user?.id ?? null} onSent={load} />
      </div>
    </div>
  );
}