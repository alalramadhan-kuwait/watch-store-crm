import assert from 'node:assert/strict';
import {
  tabOf, counts, stageOf, standingLine, waitedFor, fieldChanges, reminderState, whenShort,
  REMIND_COOLDOWN_HOURS, type RequestRow,
} from '../requestRules';

let n = 0; const t = (_: string, f: () => void) => { f(); n++; };

const at = (hhmm: string) => `2026-09-17T${hhmm}:00+03:00`;

const row = (p: Partial<RequestRow> = {}): RequestRow => ({
  source: 'employee_requests', id: 'r1', kind: 'Attendance correction',
  employee_id: 'e1', employee_name: 'Ahmed Yasari', employee_user_id: 'u1', outlet: 'Avenues',
  details: 'Forgot to clock out: out 22:03', reason: 'Forgot to clock out',
  attendance_date: '2026-09-17', attendance_record_id: 'a1',
  proposed_clock_in: null, proposed_clock_out: null,
  proposed_from: null, proposed_until: null, proposed_shift_start: null, proposed_shift_end: null,
  current_clock_in: null, current_clock_out: null, current_shifts: 0,
  current_shift_start: null, current_shift_end: null, current_working_days: null,
  changes_nothing: false,
  status: 'Pending', manager_status: 'Pending', stage_owner: 'manager',
  hours_pending: 3, is_overdue: false, last_reminder_at: null, reminder_count: 0,
  submitted_at: at('14:20'), on_behalf_by: null, on_behalf_name: null,
  first_approver_id: 'm1', first_approver_name: 'Hussein Deeb',
  manager_remarks: null,
  manager_decided_by: null, manager_decided_name: null, manager_decided_at: null,
  final_decided_by: null, final_decided_name: null, final_decided_at: null,
  withdrawn_at: null,
  override_by: null, override_name: null, override_at: null, override_reason: null, override_stage: null,
  ...p,
});

t('one request, two chairs: the same row is Action for one and Waiting for the other', () => {
  const waitingOnHussein = row({ stage_owner: 'manager' });
  assert.equal(tabOf(waitingOnHussein, 'manager'), 'action', 'Hussein must act');
  assert.equal(tabOf(waitingOnHussein, 'owner'), 'waiting', 'the owner watches');

  const waitingOnOwner = row({ stage_owner: 'owner', manager_status: 'Approved' });
  assert.equal(tabOf(waitingOnOwner, 'owner'), 'action');
  assert.equal(tabOf(waitingOnOwner, 'manager'), 'waiting');
});

t('a settled request is done for everybody', () => {
  const r = row({ stage_owner: 'nobody', status: 'Approved' });
  assert.equal(tabOf(r, 'owner'), 'done');
  assert.equal(tabOf(r, 'manager'), 'done');
});

t('the owner is the only one who gives the final word', () => {
  assert.equal(stageOf('admin'), 'owner');
  assert.equal(stageOf('manager'), 'manager');
  assert.equal(stageOf('hr'), 'manager', 'HR is not the final approver');
  assert.equal(stageOf(null), 'manager');
});

t('the dashboard cards count what each tab holds', () => {
  const rows = [
    row({ id: '1', stage_owner: 'manager' }),
    row({ id: '2', stage_owner: 'manager', is_overdue: true }),
    row({ id: '3', stage_owner: 'owner' }),
    row({ id: '4', stage_owner: 'nobody', status: 'Approved' }),
  ];
  const owner = counts(rows, 'owner');
  assert.deepEqual([owner.action, owner.waiting, owner.done, owner.overdue], [1, 2, 1, 1]);

  const mgr = counts(rows, 'manager');
  assert.deepEqual([mgr.action, mgr.waiting, mgr.done], [2, 1, 1],
    'the same four rows, counted from the shop floor');
});

t('the standing line names the person it is waiting on', () => {
  assert.equal(standingLine(row({ stage_owner: 'manager' }), 'owner'), 'Waiting for Hussein Deeb');
  assert.equal(standingLine(row({ stage_owner: 'manager' }), 'manager'), 'Your approval required');
  assert.equal(
    standingLine(row({ stage_owner: 'nobody', status: 'Approved', final_decided_name: 'Ali' }), 'owner'),
    'Approved by Ali');
  assert.equal(
    standingLine(row({ stage_owner: 'nobody', status: 'Withdrawn' }), 'owner'),
    'Withdrawn by the employee');
});

t('a manager with no scope set still gets a sentence', () => {
  assert.equal(
    standingLine(row({ stage_owner: 'manager', first_approver_name: null }), 'owner'),
    'Waiting for the store manager');
});

t('how long it has waited reads in hours, then days', () => {
  assert.equal(waitedFor(0.4), 'just now');
  assert.equal(waitedFor(8), '8h');
  assert.equal(waitedFor(47), '47h');
  assert.equal(waitedFor(72), '3d');
});

t('a missing check-in is not the same as one being moved', () => {
  const missing = fieldChanges(row({ current_clock_in: null, proposed_clock_in: at('14:12') }));
  assert.deepEqual(
    [missing[0].current, missing[0].requested, missing[0].same],
    ['Missing', '14:12', false]);

  const moved = fieldChanges(row({ current_clock_in: at('13:00'), proposed_clock_in: at('14:12') }));
  assert.deepEqual([moved[0].current, moved[0].requested, moved[0].same], ['13:00', '14:12', false]);
});

t('a line nobody asked to change says so, instead of vanishing', () => {
  const c = fieldChanges(row({ current_clock_in: at('14:12'), current_clock_out: at('22:03') }));
  assert.equal(c[1].current, '22:03');
  assert.equal(c[1].requested, 'No change');
  assert.ok(c[1].same);
});

t('an open shift reads as still clocked in, not as missing', () => {
  const c = fieldChanges(row({ current_clock_in: at('14:12'), current_clock_out: null }));
  assert.equal(c[1].current, 'Still clocked in');
});

t('asking for the time already recorded is marked as no change at all', () => {
  // the real 17 September request: the form pre-filled the arrival, he only
  // wanted the leaving time, and what he sent moved nothing
  const c = fieldChanges(row({
    current_clock_in: at('14:12'), current_clock_out: at('22:00'),
    proposed_clock_in: at('14:12'), proposed_clock_out: null,
  }));
  assert.ok(c[0].same, 'the arrival he "asked for" is the arrival on record');
  assert.ok(c[1].same, 'and he asked for nothing else');
});

t('leave carries no field table; its dates are the request', () => {
  assert.deepEqual(fieldChanges(row({ kind: 'Leave' })), []);
});

t('a schedule change compares the hours somebody is on against the ones they want', () => {
  // the Avenues case: hours vary today, a fixed evening shift asked for
  const c = fieldChanges(row({
    kind: 'Schedule change', proposed_from: '2026-09-20', proposed_until: '2026-09-27',
    current_shift_start: null, current_shift_end: null,
    proposed_shift_start: '14:00:00', proposed_shift_end: '22:00:00',
  }));
  assert.equal(c[0].current, 'Hours vary');
  assert.equal(c[0].requested, '14:00–22:00');
  assert.ok(!c[0].same);
  assert.equal(c[1].requested, '2026-09-20 until 2026-09-27');

  // and asking for what they are already on is marked as no change
  const noop = fieldChanges(row({
    kind: 'Schedule change', proposed_from: '2026-09-20',
    current_shift_start: '10:00:00', current_shift_end: '18:00:00',
    proposed_shift_start: '10:00:00', proposed_shift_end: '18:00:00',
  }));
  assert.ok(noop[0].same);
});

t('you cannot remind yourself, and you cannot remind twice in an hour', () => {
  const now = Date.parse('2026-09-18T12:00:00+03:00');
  const waitingOnHussein = row({ stage_owner: 'manager' });

  const asOwner = reminderState(waitingOnHussein, 'owner', now);
  assert.ok(asOwner.can, 'the owner may chase the manager');
  assert.equal(asOwner.lastLine, null, 'nothing sent yet');

  const asHussein = reminderState(waitingOnHussein, 'manager', now);
  assert.ok(!asHussein.can);
  assert.equal(asHussein.blocked, 'This one is yours');

  const settled = reminderState(row({ stage_owner: 'nobody', status: 'Approved' }), 'owner', now);
  assert.ok(!settled.can);
  assert.equal(settled.blocked, 'Already settled');
});

t('a fresh reminder blocks another, an old one does not', () => {
  const now = Date.parse('2026-09-18T12:00:00+03:00');
  const hoursAgo = (h: number) => new Date(now - h * 3600_000).toISOString();

  const justNudged = reminderState(
    row({ stage_owner: 'manager', last_reminder_at: hoursAgo(1) }), 'owner', now);
  assert.ok(!justNudged.can);
  assert.match(justNudged.blocked as string, /Reminded/);
  assert.ok(justNudged.lastLine?.startsWith('Last reminder:'));

  const stale = reminderState(
    row({ stage_owner: 'manager', last_reminder_at: hoursAgo(REMIND_COOLDOWN_HOURS + 1) }), 'owner', now);
  assert.ok(stale.can, 'past the cooldown it may go again');
});

t('a reminder time reads as today, yesterday, then a date', () => {
  const now = Date.parse('2026-09-18T12:00:00+03:00');
  assert.equal(whenShort('2026-09-18T09:15:00+03:00', now), 'today 09:15');
  assert.equal(whenShort('2026-09-17T17:40:00+03:00', now), 'yesterday 17:40');
  assert.equal(whenShort('2026-09-12T08:00:00+03:00', now), '12 Sep');
});

console.log(`${n} request checks passed`);
