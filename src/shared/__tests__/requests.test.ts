import assert from 'node:assert/strict';
import { tabOf, counts, stageOf, standingLine, waitedFor, fieldChanges, type RequestRow } from '../requestRules';

let n = 0; const t = (_: string, f: () => void) => { f(); n++; };

const at = (hhmm: string) => `2026-09-17T${hhmm}:00+03:00`;

const row = (p: Partial<RequestRow> = {}): RequestRow => ({
  source: 'employee_requests', id: 'r1', kind: 'Attendance correction',
  employee_id: 'e1', employee_name: 'Ahmed Yasari', employee_user_id: 'u1', outlet: 'Avenues',
  details: 'Forgot to clock out: out 22:03', reason: 'Forgot to clock out',
  attendance_date: '2026-09-17', attendance_record_id: 'a1',
  proposed_clock_in: null, proposed_clock_out: null,
  proposed_from: null, proposed_until: null, proposed_shift_start: null, proposed_shift_end: null,
  current_clock_in: null, current_clock_out: null, current_shifts: 0, changes_nothing: false,
  status: 'Pending', manager_status: 'Pending', stage_owner: 'manager',
  hours_pending: 3, is_overdue: false,
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

t('a schedule change says what it wants and from when', () => {
  const c = fieldChanges(row({
    kind: 'Schedule change', proposed_from: '2026-09-20', proposed_until: '2026-09-27',
    proposed_shift_start: '14:00:00', proposed_shift_end: '22:00:00',
  }));
  assert.equal(c[0].requested, '14:00–22:00');
  assert.equal(c[1].requested, '2026-09-20 until 2026-09-27');
});

console.log(`${n} request checks passed`);
