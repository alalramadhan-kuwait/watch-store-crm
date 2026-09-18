/**
 * Everything the two inboxes do to the database.
 *
 * The rules — which tab a row belongs in, what the standing line says, what a
 * request actually changes — are next door in requestRules.ts, where a test can
 * reach them without a Supabase client. This file is the wire.
 *
 * Mirrored byte-for-byte in timekeeper-online and watch-store-crm. See
 * src/shared/README.md before editing.
 */
import { supabase } from '../lib/supabase';
import type { MyStage, RequestRow, Verdict } from './requestRules';
import { todayKuwait } from './portalRules';

export * from './requestRules';

/* ------------------------------------------------------------------ writing */

/**
 * Record a decision.
 *
 * Which column to write is the only thing that differs between the two stages,
 * and between the two tables. Whether the write is *allowed* is not decided
 * here — the database refuses a manager signing off the final stage, or anybody
 * approving outside their outlet, and the message comes back to be shown. A
 * screen that made that judgement itself would be the second source of truth
 * this whole exercise exists to remove.
 */
export async function decide(
  r: RequestRow, verdict: Verdict, opts: { stage: MyStage; remarks?: string; overrideReason?: string },
): Promise<string | null> {
  const patch: Record<string, unknown> = {};

  if (opts.stage === 'manager') {
    patch.manager_status = verdict;
  } else if (r.source === 'leave_records') {
    patch.approval_status = verdict;
  } else {
    patch.status = verdict;
  }

  if (opts.remarks?.trim() && r.source === 'employee_requests') {
    patch.manager_remarks = opts.remarks.trim();
  }
  /* Deciding while the manager stage is still open costs a written reason. The
     database raises without one; sending it here is what makes the bypass a
     recorded act rather than a silent one. */
  if (opts.overrideReason?.trim()) patch.override_reason = opts.overrideReason.trim();

  const { error } = await supabase.from(r.source).update(patch).eq('id', r.id);
  return error ? error.message : null;
}

/**
 * The employee taking their own request back.
 *
 * Only while it is still Pending, and only into Withdrawn — the database policy
 * says the same, so a screen cannot widen it. Nothing is deleted: the record of
 * having asked is the point.
 */
export async function withdraw(r: RequestRow): Promise<string | null> {
  const patch = r.source === 'leave_records'
    ? { approval_status: 'Cancelled' }
    : { status: 'Withdrawn' };
  const { error } = await supabase.from(r.source).update(patch).eq('id', r.id);
  return error ? error.message : null;
}

/* ------------------------------------------------------------------ loading */

export interface LoadOptions {
  /** Only this employee's own requests — the My Requests screen. */
  employeeUserId?: string;
  /** Leave out the settled ones, for a queue. */
  openOnly?: boolean;
  /** Newest first. Default true. */
  newestFirst?: boolean;
  limit?: number;
}

/**
 * Read requests.
 *
 * Row-level security does the narrowing: an owner sees every outlet, a store
 * manager sees only the outlets they are scoped to, an employee sees their own.
 * No app passes a location filter, because an app that could pass one could
 * pass the wrong one.
 */
export async function loadRequests(opts: LoadOptions = {}): Promise<RequestRow[]> {
  let q = supabase.from('v_requests').select('*');
  if (opts.employeeUserId) q = q.eq('employee_user_id', opts.employeeUserId);
  if (opts.openOnly) q = q.neq('stage_owner', 'nobody');
  q = q.order('submitted_at', { ascending: opts.newestFirst === false });
  if (opts.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) return [];
  return (data ?? []) as unknown as RequestRow[];
}

/* ---------------------------------------------------------------- reminders */

/**
 * Nudge whoever is holding a request up.
 *
 * The cooldown, who may send one, and who receives it are all decided by
 * `remind_request` in the database — the same function the nightly job calls, so
 * a button press and an automatic chase can never disagree about what "recently
 * reminded" means. Returns a sentence when it refused, null when it went.
 */
export async function remind(r: RequestRow): Promise<string | null> {
  const { data, error } = await supabase.rpc('remind_request', {
    p_source: r.source, p_request_id: r.id,
  });
  if (error) return error.message;
  return (data as string | null) ?? null;
}

/* ----------------------------------------------------- the employee's own copy */

export interface EditableFields {
  details?: string;
  proposed_clock_in?: string | null;
  proposed_clock_out?: string | null;
  proposed_from?: string | null;
  proposed_until?: string | null;
  proposed_shift_start?: string | null;
  proposed_shift_end?: string | null;
}

/**
 * Change a request that has not been acted on yet.
 *
 * The row-level policy allows this only while the request is still Pending and
 * only to the person who raised it, so a screen cannot widen it by asking
 * nicely. Once a manager has decided, editing is refused by the database rather
 * than hidden by the UI — the difference matters when two tabs are open.
 */
export async function editRequest(r: RequestRow, patch: EditableFields): Promise<string | null> {
  if (r.source !== 'employee_requests') {
    return 'Leave is changed from the leave screen, not here.';
  }
  const { error } = await supabase.from('employee_requests').update(patch).eq('id', r.id);
  return error ? error.message : null;
}

/* ------------------------------------------------- asking for different hours */

export interface ScheduleAsk {
  employeeId: string;
  userId: string;
  from: string;
  until?: string | null;
  shiftStart?: string | null;
  shiftEnd?: string | null;
  reason: string;
}

/**
 * Ask for different working hours.
 *
 * Until now there was no way to: schedules moved only through set_schedule(),
 * which HR and managers can call and nobody else, so an employee wanting a
 * different shift had to find somebody at a desk. Avenues assigns mornings and
 * nights by the day, which is exactly the case that needs asking.
 *
 * Leaving both times empty is a real request, not an empty one — it asks to go
 * back to hours that vary.
 */
export async function askForSchedule(a: ScheduleAsk): Promise<string | null> {
  if (!a.reason.trim()) return 'Say why, so whoever reads this can decide.';
  if (a.from < todayKuwait()) return 'A schedule change starts today or later.';
  if (a.until && a.until < a.from) return 'The end date comes before the start date.';
  if (!!a.shiftStart !== !!a.shiftEnd) return 'Give both a start and an end time, or neither.';

  const { error } = await supabase.from('employee_requests').insert({
    user_id: a.userId,
    employee_id: a.employeeId,
    request_type: 'Schedule change',
    status: 'Pending',
    details: a.reason.trim(),
    proposed_from: a.from,
    proposed_until: a.until || null,
    proposed_shift_start: a.shiftStart || null,
    proposed_shift_end: a.shiftEnd || null,
  });
  return error ? error.message : null;
}

/**
 * Write an approved schedule change onto the actual schedule.
 *
 * Approving one and not applying it would leave "Approved" beside an unchanged
 * rota, which is the same two-words-for-one-state failure that attendance
 * corrections had. The database function calls set_schedule, so every rule about
 * dated schedules stays in one place.
 */
export async function applyScheduleChange(r: RequestRow): Promise<string | null> {
  const { data, error } = await supabase.rpc('apply_schedule_change', { p_request_id: r.id });
  if (error) return error.message;
  return (data as string | null) ?? null;
}
