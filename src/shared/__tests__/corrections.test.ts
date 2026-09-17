import assert from 'node:assert/strict';
import { planCorrection, nextKuwaitDay, kuwaitHM, type RecordedShift } from '../portalRules';

let n = 0; const t = (_: string, f: () => void) => { f(); n++; };
const now = new Date('2026-09-17T15:00:00Z'); // 18:00 Kuwait

/** The real record from the incident: clocked in 14:12:25.914 Kuwait, never out. */
const openShift: RecordedShift = {
  id: 'rec-1', clock_in: '2026-09-17T11:12:25.914Z', clock_out: null,
};
const ask = (over: Partial<Parameters<typeof planCorrection>[0]>) =>
  planCorrection({ date: '2026-09-17', reason: 'Phone died', ...over }, now);

t('kuwaitHM reads an instant as Kuwait wall-clock', () => {
  assert.equal(kuwaitHM('2026-09-17T11:12:25.914Z'), '14:12');
  assert.equal(kuwaitHM('2026-09-17T21:30:00Z'), '00:30');
  assert.equal(kuwaitHM(null), null);
});

t('THE INCIDENT: a leaving time alone no longer drags the arrival with it', () => {
  const p = ask({ record: openShift, leftAt: '17:30' });
  assert.equal(p.problem, null);
  assert.equal(p.proposedClockIn, null, 'the arrival he never touched is not proposed');
  assert.equal(p.proposedClockOut, '2026-09-17T14:30:00.000Z');
  assert.deepEqual(p.changes, ['out']);
  assert.ok(!p.details.includes('in 14:12'), 'and it is not in the sentence either');
  assert.ok(p.details.includes('out 17:30'));
  assert.equal(p.summary, 'Ask to set leaving time to 17:30');
});

t('typing the recorded arrival back is not a change', () => {
  // the form used to prefill this, and kuwaitHM drops seconds — approving it
  // would have rewritten 14:12:25.914 as 14:12:00
  const p = ask({ record: openShift, arrivedAt: '14:12', leftAt: '17:30' });
  assert.equal(p.proposedClockIn, null);
  assert.deepEqual(p.changes, ['out']);
});

t('a request that changes nothing is refused', () => {
  const p = ask({ record: openShift, arrivedAt: '14:12' });
  assert.match(p.problem ?? '', /Nothing here is different/);
  assert.deepEqual(p.changes, []);
});

t('both boxes empty is refused', () => {
  assert.match(ask({ record: openShift }).problem ?? '', /different from what is recorded/);
  assert.match(ask({}).problem ?? '', /Give the time you arrived/);
});

t('a genuine arrival change still goes through, at the minute asked for', () => {
  const p = ask({ record: openShift, arrivedAt: '14:15' });
  assert.equal(p.proposedClockIn, '2026-09-17T11:15:00.000Z');
  assert.deepEqual(p.changes, ['in']);
  assert.equal(p.summary, 'Ask to set arrival to 14:15');
});

t('an overnight shift is accepted when it is said', () => {
  const evening: RecordedShift = { id: 'r', clock_in: '2026-09-17T18:00:00Z', clock_out: null }; // 21:00
  const p = ask({ record: evening, leftAt: '02:30', leftNextDay: true });
  assert.equal(p.problem, null);
  assert.equal(p.proposedClockOut, '2026-09-17T23:30:00.000Z', 'resolved against the next Kuwait day');
});

t('and refused with the right advice when it is not', () => {
  const evening: RecordedShift = { id: 'r', clock_in: '2026-09-17T18:00:00Z', clock_out: null };
  const p = ask({ record: evening, leftAt: '02:30' });
  assert.match(p.problem ?? '', /after midnight/, 'offers the tick, does not call it backwards');
});

t('a thirty-hour day is a typo, not a shift', () => {
  const p = ask({ record: openShift, leftAt: '13:00', leftNextDay: true });
  assert.match(p.problem ?? '', /more than 16 hours/);
});

t('the record the employee pointed at is the one corrected', () => {
  const evening: RecordedShift = { id: 'evening', clock_in: '2026-09-17T15:00:00Z', clock_out: null };
  assert.equal(ask({ record: evening, leftAt: '22:00' }).recordId, 'evening');
  assert.equal(ask({ record: openShift, leftAt: '17:30' }).recordId, 'rec-1');
});

t('a day with no record needs the arrival too', () => {
  assert.match(ask({ leftAt: '17:30' }).problem ?? '', /time you arrived is needed/);
  const p = ask({ arrivedAt: '09:00', leftAt: '17:30' });
  assert.equal(p.problem, null);
  assert.ok(p.details.includes('(no record for that day)'));
});

t('a reason is required, and the future is not correctable', () => {
  assert.match(ask({ record: openShift, leftAt: '17:30', reason: '  ' }).problem ?? '', /Say why/);
  assert.match(
    planCorrection({ date: '2026-09-20', reason: 'x', leftAt: '17:30', record: openShift }, now).problem ?? '',
    /has not happened yet/);
});

t('the details line keeps one ": " so the approver can split the reason back out', () => {
  const p = ask({ record: openShift, leftAt: '17:30', reason: 'Phone died at the end' });
  const [, reason] = p.details.split(/: (.*)/s);
  assert.equal(reason, 'Phone died at the end');
});

t('nextKuwaitDay crosses months and years', () => {
  assert.equal(nextKuwaitDay('2026-09-30'), '2026-10-01');
  assert.equal(nextKuwaitDay('2026-12-31'), '2027-01-01');
  assert.equal(nextKuwaitDay('2028-02-28'), '2028-02-29');
});

console.log(`${n} correction checks passed`);
