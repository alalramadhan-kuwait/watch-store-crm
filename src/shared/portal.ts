/**
 * Everything My Portal does to the database, in one place.
 *
 * There are two My Portals — one in the back office, one on the shop floor —
 * because a manager at a desk and a salesperson on a phone want different
 * screens. They do not want different rules. Written twice, the two drifted:
 * one counted an open shift as worked and the other as nothing, and a fix to
 * clocking in had to be remembered twice.
 *
 * The screens stay separate. What they ask the database, and what counts as a
 * valid answer, lives here. Both import the same `supabase` client from
 * ../lib/supabase, which exists at that path in both apps.
 *
 * Mirrored byte-for-byte in timekeeper-online and watch-store-crm. See
 * src/shared/README.md before editing.
 */
import { supabase } from '../lib/supabase';
import { dayHours, type DayHours, type ShiftInput } from './workedHours';
import { resolveOutlet } from './outlets';

/* ── shapes ──────────────────────────────────────────────────────────────── */

export interface PortalEmployee {
  id: string;
  full_name: string;
  user_id: string | null;
  location: string | null;
  job_title: string | null;
  joining_date: string | null;
  status: string | null;
  annual_leave_entitlement: number | null;
  portal_enabled: boolean | null;
  dsr_staff_name: string | null;
  expected_days: number[] | null;
  shift_start: string | null;
  shift_end: string | null;
}

export interface PortalShift {
  id: string;
  clock_in: string;
  clock_out: string | null;
  is_late: boolean | null;
  justified: boolean | null;
  location: string | null;
  correction_reason: string | null;
}

export interface PortalLeave {
  id: string;
  employee_id: string;
  leave_type: string | null;
  leave_start: string;
  leave_end: string;
  days: number | null;
  approval_status: string;
  manager_status: string | null;
  notes: string | null;
  document_url: string | null;
  created_at: string;
}

export interface PortalRequest {
  id: string;
  user_id: string;
  employee_id: string | null;
  request_type: string;
  details: string;
  status?: string | null;
  created_at: string;
  attendance_date?: string | null;
  proposed_clock_in?: string | null;
  proposed_clock_out?: string | null;
  attendance_record_id?: string | null;
}

export interface Geofence {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
  active: boolean;
}

export interface PortalSettings {
  workStart: string;
  maxAccuracyM: number | null;
}

export interface PortalState {
  employee: PortalEmployee | null;
  today: PortalShift[];
  month: PortalShift[];
  leaves: PortalLeave[];
  requests: PortalRequest[];
  geofences: Geofence[];
  settings: PortalSettings;
}

/** yyyy-mm-dd as Kuwait reads the calendar. UTC+3 all year, no daylight saving. */
export const todayKuwait = (at: Date = new Date()): string =>
  new Date(at.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);

/** A Kuwait date and HH:mm as an instant. */
export const kuwaitISO = (date: string, time: string): string =>
  new Date(`${date}T${time}:00+03:00`).toISOString();

const dayStart = (d: string) => `${d}T00:00:00+03:00`;
const dayEnd = (d: string) => `${d}T23:59:59+03:00`;

const SHIFT_COLUMNS = 'id, clock_in, clock_out, is_late, justified, location, correction_reason';

/* ── reading ─────────────────────────────────────────────────────────────── */

/**
 * Everything one person's portal needs, in one round trip.
 *
 * The employee record is found by the link an admin made on the HR page, never
 * by matching names — two people with similar names once saw each other's leave
 * balance that way.
 */
export async function loadPortal(userId: string, at: Date = new Date()): Promise<PortalState> {
  const today = todayKuwait(at);
  const monthStart = `${today.slice(0, 7)}-01`;

  const [empQ, geoQ, setQ, todayQ, monthQ, reqQ] = await Promise.all([
    supabase.from('employees').select('*').eq('user_id', userId).maybeSingle(),
    supabase.from('geofences').select('*').eq('active', true),
    supabase.from('settings').select('work_start_time, geo_max_accuracy_m').limit(1).maybeSingle(),
    supabase.from('attendance_records').select(SHIFT_COLUMNS)
      .eq('user_id', userId).gte('clock_in', dayStart(today)).lte('clock_in', dayEnd(today))
      .order('clock_in', { ascending: true }),
    supabase.from('attendance_records').select(SHIFT_COLUMNS)
      .eq('user_id', userId).gte('clock_in', dayStart(monthStart))
      .order('clock_in', { ascending: true }),
    supabase.from('employee_requests').select('*')
      .eq('user_id', userId).order('created_at', { ascending: false }),
  ]);

  const employee = (empQ.data as PortalEmployee | null) ?? null;

  let leaves: PortalLeave[] = [];
  if (employee) {
    const { data } = await supabase.from('leave_records').select('*')
      .eq('employee_id', employee.id).order('created_at', { ascending: false });
    leaves = (data as PortalLeave[]) ?? [];
  }

  return {
    employee,
    today: (todayQ.data as PortalShift[]) ?? [],
    month: (monthQ.data as PortalShift[]) ?? [],
    leaves,
    requests: (reqQ.data as PortalRequest[]) ?? [],
    geofences: (geoQ.data as Geofence[]) ?? [],
    settings: {
      workStart: (setQ.data?.work_start_time as string) ?? '09:00',
      maxAccuracyM: setQ.data?.geo_max_accuracy_m == null ? null : Number(setQ.data.geo_max_accuracy_m),
    },
  };
}

/** Every record on one day, for the correction form to propose against. */
export async function loadDay(userId: string, date: string): Promise<PortalShift[]> {
  const { data } = await supabase.from('attendance_records').select(SHIFT_COLUMNS)
    .eq('user_id', userId)
    .gte('clock_in', dayStart(date)).lte('clock_in', dayEnd(date))
    .order('clock_in', { ascending: true });
  return (data as PortalShift[]) ?? [];
}

export const asShiftInputs = (shifts: PortalShift[]): ShiftInput[] =>
  shifts.map((s) => ({ clockIn: s.clock_in, clockOut: s.clock_out }));

/** The day's hours, by the one rule. */
export const hoursOnDay = (shifts: PortalShift[], now?: Date): DayHours =>
  dayHours(asShiftInputs(shifts), now);

/** The shift they are currently standing in, if any. */
export const openShift = (shifts: PortalShift[]): PortalShift | null =>
  shifts.find((s) => !s.clock_out) ?? null;

/* ── clocking in and out ─────────────────────────────────────────────────── */

export interface Position {
  latitude: number;
  longitude: number;
  accuracy: number;
}

export interface NearFence {
  fence: Geofence;
  metres: number;
  inside: boolean;
}

/** Straight-line metres between two points. */
export function metresBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Every workplace, nearest first.
 *
 * All of them, not the one on the employee's HR record: a manager covering the
 * other shop is standing in a real workplace and should be able to clock in to
 * it. Which one they are in is a question about where they are, not about which
 * row somebody typed.
 */
export function fencesNear(fences: Geofence[], at: Position): NearFence[] {
  return fences
    .map((fence) => {
      const metres = metresBetween(at.latitude, at.longitude, Number(fence.lat), Number(fence.lng));
      return { fence, metres, inside: metres <= Number(fence.radius_m) };
    })
    .sort((a, b) => a.metres - b.metres);
}

export interface ClockInAt {
  userId: string;
  employeeName: string;
  fenceName: string;
  position: Position;
  isLate: boolean;
}

/**
 * Open a shift.
 *
 * The geofence is checked here too, but the binding check is the database
 * trigger — this half only explains the problem before a request is sent.
 */
export async function clockIn(input: ClockInAt): Promise<string | null> {
  const { error } = await supabase.from('attendance_records').insert({
    user_id: input.userId,
    employee_name: input.employeeName,
    clock_in: new Date().toISOString(),
    clock_in_lat: input.position.latitude,
    clock_in_lng: input.position.longitude,
    clock_in_accuracy_m: Math.round(input.position.accuracy),
    is_late: input.isLate,
    location: input.fenceName,
  });
  return error?.message ?? null;
}

export async function clockOut(recordId: string, position: Position): Promise<string | null> {
  const { error } = await supabase.from('attendance_records').update({
    clock_out: new Date().toISOString(),
    clock_out_lat: position.latitude,
    clock_out_lng: position.longitude,
    clock_out_accuracy_m: Math.round(position.accuracy),
  }).eq('id', recordId);
  return error?.message ?? null;
}

/** Which workplace a record was taken at, canonically. */
export const shiftOutlet = (shift: PortalShift) => resolveOutlet(shift.location);

/* ── leave ───────────────────────────────────────────────────────────────── */

export interface LeaveApplication {
  employeeId: string;
  userId: string;
  type: string;
  start: string;
  end: string;
  days: number;
  notes?: string | null;
  document?: File | null;
}

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** Apply for leave. Returns a message to show, or null on success. */
export async function applyForLeave(a: LeaveApplication): Promise<string | null> {
  if (!a.start || !a.end || a.end < a.start) return 'Pick a valid start and end date';

  let documentPath: string | null = null;
  if (a.document) {
    if (a.document.size > MAX_DOCUMENT_BYTES) return 'Could not submit: document is larger than 10 MB';
    const safeName = a.document.name.replace(/[^\w.\-]+/g, '_');
    const path = `${a.userId}/${Date.now()}-${safeName}`;
    const { error } = await supabase.storage.from('leave-docs').upload(path, a.document);
    if (error) return `Could not upload document: ${error.message}`;
    documentPath = path;
  }

  const { error } = await supabase.from('leave_records').insert({
    employee_id: a.employeeId,
    leave_type: a.type,
    leave_start: a.start,
    leave_end: a.end,
    days: a.days,
    approval_status: 'Pending',
    notes: a.notes || null,
    document_url: documentPath,
  });
  return error ? `Could not submit: ${error.message}` : null;
}

/** Change the dates on a request. Always lands back in Pending — HR approves
 *  the dates, so changed dates need approving again. */
export async function reviseLeave(id: string, start: string, end: string, days: number): Promise<string | null> {
  if (!start || !end || end < start) return 'Pick a valid start and end date';
  const { error } = await supabase.from('leave_records')
    .update({ leave_start: start, leave_end: end, days, approval_status: 'Pending' })
    .eq('id', id);
  return error ? `Could not update: ${error.message}` : null;
}

export async function cancelLeave(id: string): Promise<string | null> {
  const { error } = await supabase.from('leave_records')
    .update({ approval_status: 'Cancelled' }).eq('id', id);
  return error ? `Could not cancel: ${error.message}` : null;
}

/** A short-lived link to a sick note, which lives in a private bucket. */
export async function leaveDocumentUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from('leave-docs').createSignedUrl(path, 300);
  return error || !data?.signedUrl ? null : data.signedUrl;
}

export interface LeaveBalance {
  entitlement: number;
  taken: number;
  booked: number;
  remaining: number;
}

/**
 * Where their annual leave stands.
 *
 * Approved days in the past are taken; approved days still to come are booked.
 * Pending requests are neither — nobody has agreed to them yet. Only annual
 * leave counts against the entitlement; sick leave is not a holiday.
 */
export function leaveBalance(
  leaves: PortalLeave[],
  entitlement: number | null,
  at: Date = new Date(),
): LeaveBalance {
  const today = todayKuwait(at);
  const annual = leaves.filter(
    (l) => l.approval_status === 'Approved' && (l.leave_type ?? 'Annual') === 'Annual',
  );
  const taken = annual.filter((l) => l.leave_end < today).reduce((t, l) => t + Number(l.days ?? 0), 0);
  const booked = annual.filter((l) => l.leave_end >= today).reduce((t, l) => t + Number(l.days ?? 0), 0);
  const total = Number(entitlement ?? 0);
  return { entitlement: total, taken, booked, remaining: Math.max(0, total - taken - booked) };
}

/* ── corrections and other requests ──────────────────────────────────────── */

export interface CorrectionRequest {
  userId: string;
  employeeId: string | null;
  date: string;
  /** HH:mm in Kuwait, or blank to leave that end of the day alone. */
  arrivedAt?: string;
  leftAt?: string;
  reason: string;
  /** The record being corrected, when there is one. */
  recordId?: string | null;
}

/**
 * Ask for a day to be corrected.
 *
 * Both times are optional because the two halves fail separately: people forget
 * to clock out far more often than they forget to clock in. What is not
 * optional is the reason — a correction is a claim about a day that the record
 * disagrees with, and whoever approves it needs to know what is being claimed.
 */
export async function requestCorrection(c: CorrectionRequest, at: Date = new Date()): Promise<string | null> {
  if (!c.reason.trim()) return 'Say why the change is needed';
  if (!c.date) return 'Pick the day to correct';
  if (c.date > todayKuwait(at)) return 'That day has not happened yet';
  if (!c.arrivedAt && !c.leftAt) return 'Give the time you arrived, the time you left, or both';
  if (c.arrivedAt && c.leftAt && c.leftAt <= c.arrivedAt) {
    return 'The leaving time is before the arrival time — check both';
  }

  const asks = [c.arrivedAt && `in ${c.arrivedAt}`, c.leftAt && `out ${c.leftAt}`].filter(Boolean).join(', ');
  const { error } = await supabase.from('employee_requests').insert({
    user_id: c.userId,
    employee_id: c.employeeId,
    request_type: 'Attendance correction',
    attendance_date: c.date,
    proposed_clock_in: c.arrivedAt ? kuwaitISO(c.date, c.arrivedAt) : null,
    proposed_clock_out: c.leftAt ? kuwaitISO(c.date, c.leftAt) : null,
    attendance_record_id: c.recordId ?? null,
    details: `${c.date} — ${asks}${c.recordId ? '' : ' (no record for that day)'}: ${c.reason.trim()}`,
  });
  return error ? `Could not submit: ${error.message}` : null;
}

/** Any other request to HR — a document, a detail to change. */
export async function submitRequest(
  userId: string, employeeId: string | null, type: string, details: string,
): Promise<string | null> {
  if (!details.trim()) return 'Say what you need';
  const { error } = await supabase.from('employee_requests').insert({
    user_id: userId, employee_id: employeeId, request_type: type, details: details.trim(),
  });
  return error ? `Could not submit: ${error.message}` : null;
}
