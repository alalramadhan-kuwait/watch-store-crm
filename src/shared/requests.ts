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
