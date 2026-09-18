/**
 * Every request, for both inboxes.
 *
 * There are two inboxes — the owner's in the back office, the store manager's
 * on the shop floor — because a person at a desk and a person on a phone want
 * different screens. They must not want different answers. Before this, leave
 * ran on a two-step chain and attendance corrections on a single status, each
 * app worked out its own idea of what a request meant, and the two disagreed.
 *
 * The rule here is narrow and worth stating: **nothing in this file decides a
 * stage**. The database does, in `v_requests.stage_owner`, and both apps read
 * it. What this file does is read that view, bucket rows into the three tabs
 * from the viewer's point of view, and write a decision back. Everything that
 * needed a join — the manager's name, the attendance actually on record,
 * whether a request changes anything at all — is already a column.
 *
 * Pure rules only — no network, so a test can run them without a Supabase
 * client, the same split as portalRules.ts and portal.ts. Everything that talks
 * to the database lives in requests.ts next door.
 *
 * Mirrored byte-for-byte in timekeeper-online and watch-store-crm. See
 * src/shared/README.md before editing.
 */

/** Which table a request actually lives in. Leave keeps its own. */
export type Source = 'employee_requests' | 'leave_records';

/** Who the request is waiting on. Computed in the database, never here. */
export type StageOwner = 'manager' | 'owner' | 'nobody';

/** Which stage the person looking at the screen is responsible for. */
export type MyStage = 'manager' | 'owner';

/** The three tabs, meaning the same thing in both apps. */
export type Tab = 'action' | 'waiting' | 'done';

export type Verdict = 'Approved' | 'Rejected';

/** One row of v_requests. Field for field, no reshaping. */
export interface RequestRow {
  source: Source;
  id: string;
  kind: string;                       // 'Attendance correction' | 'Leave' | …
  employee_id: string | null;
  employee_name: string | null;
  employee_user_id: string | null;
  outlet: string | null;

  details: string | null;
  reason: string | null;
  attendance_date: string | null;
  attendance_record_id: string | null;
  proposed_clock_in: string | null;
  proposed_clock_out: string | null;
  proposed_from: string | null;
  proposed_until: string | null;
  proposed_shift_start: string | null;
  proposed_shift_end: string | null;

  current_clock_in: string | null;
  current_clock_out: string | null;
  current_shifts: number;
  changes_nothing: boolean;

  status: string;
  manager_status: string;
  stage_owner: StageOwner;
  hours_pending: number;
  is_overdue: boolean;

  submitted_at: string;
  on_behalf_by: string | null;
  on_behalf_name: string | null;
  first_approver_id: string | null;
  first_approver_name: string | null;
  manager_remarks: string | null;
  manager_decided_by: string | null;
  manager_decided_name: string | null;
  manager_decided_at: string | null;
  final_decided_by: string | null;
  final_decided_name: string | null;
  final_decided_at: string | null;
  withdrawn_at: string | null;
  override_by: string | null;
  override_name: string | null;
  override_at: string | null;
  override_reason: string | null;
  override_stage: string | null;
}

/* ------------------------------------------------------------------ reading */

/**
 * Which stage this viewer is responsible for.
 *
 * An owner gives the final word; everybody else who can approve is somebody's
 * store manager. This is the only place the two roles diverge, which is why the
 * rest of the file takes a stage rather than a role.
 */
export const stageOf = (role: string | null | undefined): MyStage =>
  role === 'admin' ? 'owner' : 'manager';

/**
 * Which tab a request belongs in, from where this person is standing.
 *
 * The same request sits in "Waiting on Manager" for the owner and in "Action
 * Required" for the manager, at the same moment. That is not two states — it is
 * one state, read from two chairs.
 */
export function tabOf(r: Pick<RequestRow, 'stage_owner'>, mine: MyStage): Tab {
  if (r.stage_owner === 'nobody') return 'done';
  return r.stage_owner === mine ? 'action' : 'waiting';
}

/** The tab counts behind the dashboard cards. */
export function counts(rows: RequestRow[], mine: MyStage) {
  let action = 0, waiting = 0, done = 0, overdue = 0;
  for (const r of rows) {
    const t = tabOf(r, mine);
    if (t === 'action') action++; else if (t === 'waiting') waiting++; else done++;
    if (r.is_overdue) overdue++;
  }
  return { action, waiting, done, overdue, total: rows.length };
}

/** "Waiting for Hussein Deeb" / "Your approval required" / "Approved". */
export function standingLine(r: RequestRow, mine: MyStage): string {
  if (r.stage_owner === 'nobody') {
    if (r.status === 'Withdrawn' || r.status === 'Cancelled') return 'Withdrawn by the employee';
    const who = r.final_decided_name ?? r.manager_decided_name;
    return who ? `${r.status} by ${who}` : r.status;
  }
  if (r.stage_owner === mine) return 'Your approval required';
  if (r.stage_owner === 'manager') {
    return r.first_approver_name ? `Waiting for ${r.first_approver_name}` : 'Waiting for the store manager';
  }
  return 'Waiting for the final approval';
}

/** "8h" / "3d" — how long it has been sitting, for the people it is sitting with. */
export function waitedFor(hours: number): string {
  if (hours < 1) return 'just now';
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/* ------------------------------------------- what the request actually asks */

export interface FieldChange {
  field: string;
  current: string;
  requested: string;
  /** True when this line is not a change, so a screen can grey it out. */
  same: boolean;
}

const hm = (iso: string | null): string | null => (!iso ? null : new Intl.DateTimeFormat('en-GB',
  { timeZone: 'Asia/Kuwait', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)));

/**
 * The Current → Requested table, built once for both apps.
 *
 * "Arrived 14:12 / Left unchanged" told an approver nothing: there was no way
 * to tell a missing clock-in from one being moved by an hour. Every line now
 * says what is on the record and what is being asked, and a line that asks for
 * no change says so rather than being silently absent.
 */
export function fieldChanges(r: RequestRow): FieldChange[] {
  if (r.kind === 'Attendance correction') {
    const curIn = hm(r.current_clock_in), curOut = hm(r.current_clock_out);
    const reqIn = hm(r.proposed_clock_in), reqOut = hm(r.proposed_clock_out);
    return [
      {
        field: 'Check-in',
        current: curIn ?? 'Missing',
        requested: reqIn ?? 'No change',
        same: !reqIn || reqIn === curIn,
      },
      {
        field: 'Check-out',
        current: curOut ?? (curIn ? 'Still clocked in' : 'Missing'),
        requested: reqOut ?? 'No change',
        same: !reqOut || reqOut === curOut,
      },
    ];
  }
  if (r.kind === 'Schedule change') {
    return [
      {
        field: 'Hours',
        current: 'As scheduled',
        requested: r.proposed_shift_start && r.proposed_shift_end
          ? `${r.proposed_shift_start.slice(0, 5)}–${r.proposed_shift_end.slice(0, 5)}`
          : 'Hours vary',
        same: false,
      },
      {
        field: 'From',
        current: '—',
        requested: r.proposed_until ? `${r.proposed_from} until ${r.proposed_until}` : `${r.proposed_from}`,
        same: false,
      },
    ];
  }
  return [];
}
