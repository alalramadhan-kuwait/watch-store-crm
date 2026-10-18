/**
 * Applying an approved attendance correction to the record it is about.
 *
 * Approving one used to set a status and stop there, so "Approved" and "fixed"
 * were two different states wearing the same word: the manager still had to
 * open HR → Attendance, find the day, and retype the times out of the
 * employee's paragraph. That is where a 17:30 becomes a 17:00, and where an
 * agreed correction quietly never happens.
 *
 * Kept out of the Inbox screen because what it does is not a screen's job and
 * because it is the part worth testing on its own.
 *
 * Shared by both apps since 18 Oct 2026: the store manager's Team screen in the
 * DSR approved corrections without this step, so five of them said "Approved"
 * for eleven days while the days stayed open. Whichever app gives the final
 * approval now writes the record the same way.
 */
import { supabase } from '../lib/supabase';
import { kuwaitHM } from './portalRules';
import { dayPunctuality } from './punctuality';
import { scheduleFromRow, type ScheduleRow } from './schedule';
import type { RequestRow } from './requestRules';

interface DayDefaults { work_start_time?: string; work_end_time?: string; late_grace_minutes?: number }

/**
 * Was this arrival late, against the shift this person was actually on?
 *
 * Judged through the shared engine and the schedule in force on that date, the
 * same as every other lateness question in both apps. It used to be judged
 * against the company's 09:00, which scored an afternoon shop shift as hours
 * late on a day somebody turned up on time.
 */
async function arrivedLate(
  r: CorrectionRequest, clockIn: string, s: DayDefaults | null,
): Promise<boolean> {
  let schedules: ReturnType<typeof scheduleFromRow>[] = [];
  if (r.employee_id) {
    const { data } = await supabase.from('employee_schedules')
      .select('id, employee_id, effective_from, effective_to, working_days, shift_start, shift_end, grace_minutes, note')
      .eq('employee_id', r.employee_id);
    schedules = ((data ?? []) as ScheduleRow[]).map(scheduleFromRow);
  }
  const day = dayPunctuality(
    { date: r.attendance_date as string, schedules, records: [{ clockIn, clockOut: null }] },
    {
      defaultStart: s?.work_start_time ?? '09:00',
      defaultEnd: s?.work_end_time ?? '17:00',
      graceMinutes: s?.late_grace_minutes ?? 60,
    },
  );
  return (day.hoursLate ?? 0) > 0;
}

export interface CorrectionRequest {
  id: string;
  request_type: string;
  details: string;
  requester: string;
  attendance_date: string | null;
  proposed_clock_in: string | null;
  proposed_clock_out: string | null;
  attendance_record_id: string | null;
  /** The employee whose schedule decides whether a corrected arrival was late. */
  employee_id: string | null;
  user_id: string | null;
  employee_name: string | null;
  employee_location: string | null;
}

/** A v_requests row in the shape applyCorrection expects. */
export const correctionFromRequest = (r: RequestRow, requester = r.employee_name ?? 'Someone'): CorrectionRequest => ({
  id: r.id,
  request_type: r.kind,
  details: r.details ?? '',
  requester,
  attendance_date: r.attendance_date,
  proposed_clock_in: r.proposed_clock_in,
  proposed_clock_out: r.proposed_clock_out,
  attendance_record_id: r.attendance_record_id,
  employee_id: r.employee_id,
  user_id: r.employee_user_id,
  employee_name: r.employee_name,
  employee_location: r.outlet,
});

/** True when approving this request should change an attendance record. */
export const isApplicable = (r: CorrectionRequest): boolean =>
  r.request_type === 'Attendance correction'
  && !!r.attendance_date
  && !!(r.proposed_clock_in || r.proposed_clock_out);

/**
 * Write the correction onto the record.
 *
 * Returns null when it worked and a sentence when it did not, so the caller can
 * refuse to mark the request Approved — a request that says Approved while the
 * record still says otherwise is worse than one that is plainly stuck.
 *
 * A time the employee did not give is left alone. Null means "this end was
 * already right", never "clear it": clearing a clock-out turns a finished day
 * into an unfinished one, which is the opposite of a correction.
 */
export async function applyCorrection(
  r: CorrectionRequest, remark?: string,
): Promise<string | null> {
  if (!isApplicable(r)) return null;

  const { data: st } = await supabase.from('settings')
    .select('work_start_time, work_end_time, late_grace_minutes').maybeSingle();
  const setting = st as { work_start_time?: string; work_end_time?: string; late_grace_minutes?: number } | null;
  const why = remark?.trim() || r.details;

  /* The record named on the request, if it is still there. A manager may have
     deleted the day in the meantime — that turns this into an insert rather
     than a failure. */
  type Target = { id: string; clock_in: string; clock_out: string | null; justified: boolean | null };
  let target: Target | null = null;
  if (r.attendance_record_id) {
    const { data } = await supabase.from('attendance_records')
      .select('id, clock_in, clock_out, justified').eq('id', r.attendance_record_id).maybeSingle();
    target = (data as unknown as Target) ?? null;
  }

  if (target) {
    const patch: Record<string, unknown> = { correction_reason: `[correction approved] ${why}` };

    /* A proposal equal to what is already there is not a change, and writing it
       is not harmless: the form only ever showed minutes, so re-applying an
       "unchanged" arrival would shave the seconds off it. Requests raised before
       the form stopped sending untouched fields are still sitting in the Inbox,
       so this has to hold here too. */
    const movesIn = !!r.proposed_clock_in && kuwaitHM(r.proposed_clock_in) !== kuwaitHM(target.clock_in);
    const movesOut = !!r.proposed_clock_out && kuwaitHM(r.proposed_clock_out) !== kuwaitHM(target.clock_out);
    if (movesIn) patch.clock_in = r.proposed_clock_in;
    if (movesOut) patch.clock_out = r.proposed_clock_out;

    if (!movesIn && !movesOut) {
      return 'This asks for the times already on the record, so there is nothing to apply.';
    }

    const inAt = (patch.clock_in as string) ?? target.clock_in;
    const outAt = (patch.clock_out as string) ?? target.clock_out;
    if (outAt && new Date(outAt).getTime() <= new Date(inAt).getTime()) {
      return 'That would end the day before it started. Check the times on the request.';
    }

    /* Lateness follows the corrected arrival — but only when the arrival
       actually moved. Recomputing it on a clock-out fix silently re-judges a
       morning somebody may already have settled. And it is judged against this
       person's own shift, not the office's hours. */
    if (movesIn && !target.justified) {
      patch.is_late = await arrivedLate(r, inAt, setting);
    }

    const { error } = await supabase.from('attendance_records').update(patch).eq('id', target.id);
    return error ? error.message : null;
  }

  /* No record for that day — a shift nobody clocked in for, which is the
     commonest reason to ask. One is created, and that needs a start: if only a
     leaving time was given there is nothing to open the day with, so it is
     refused rather than invented. */
  if (!r.proposed_clock_in) {
    return 'There is no record for that day, so a start time is needed. Ask for the arrival time as well.';
  }
  if (!r.user_id) return 'This request has no linked login, so no attendance record can be created.';

  const { error } = await supabase.from('attendance_records').insert({
    user_id: r.user_id,
    employee_name: r.employee_name ?? r.requester,
    clock_in: r.proposed_clock_in,
    clock_out: r.proposed_clock_out ?? null,
    is_late: await arrivedLate(r, r.proposed_clock_in, setting),
    location: r.employee_location,
    correction_reason: `[added from an approved correction] ${why}`,
  });
  return error ? error.message : null;
}
