import assert from 'node:assert/strict';
import { kuwaitDateOf, kuwaitTimeOf, workingDaysBetween, todayKuwait, LEAVE_TYPES } from '../kuwaitTime';

let n = 0; const t = (_: string, f: () => void) => { f(); n++; };

t('an instant late in the UTC evening is already tomorrow in Kuwait', () => {
  assert.equal(kuwaitDateOf('2026-11-13T21:30:00Z'), '2026-11-14');
  assert.equal(kuwaitDateOf('2026-11-13T20:59:59Z'), '2026-11-13');
  assert.equal(kuwaitTimeOf('2026-11-13T21:30:00Z'), '00:30');
  assert.equal(kuwaitTimeOf('2026-11-09T14:25:00+00:00'), '17:25');
});

t('they agree with the Intl versions the screens used to carry', () => {
  for (const iso of ['2026-01-01T00:00:00Z', '2026-06-30T20:59:00Z', '2026-06-30T21:00:00Z', '2026-12-31T23:59:59Z', '2026-03-29T01:30:00+02:00']) {
    assert.equal(kuwaitDateOf(iso), new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kuwait' }));
    assert.equal(kuwaitTimeOf(iso), new Intl.DateTimeFormat('en-GB',
      { timeZone: 'Asia/Kuwait', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)));
  }
  assert.equal(todayKuwait(new Date('2026-11-13T21:30:00Z')), '2026-11-14');
});

t('something that is not a date gives nothing rather than throwing', () => {
  assert.equal(kuwaitDateOf('not a date'), '');
  assert.equal(kuwaitTimeOf(''), '');
});

t('leave days skip Fridays and count both ends', () => {
  assert.equal(workingDaysBetween('2026-06-14', '2026-06-25'), 11); // 12 days, one Friday inside
  assert.equal(workingDaysBetween('2026-11-10', '2026-11-10'), 1);
  assert.equal(workingDaysBetween('2026-11-13', '2026-11-13'), 0);  // a Friday
  assert.equal(workingDaysBetween('2026-11-12', '2026-11-14'), 2);  // Thu, Fri, Sat
  assert.equal(workingDaysBetween('2026-11-14', '2026-11-10'), 0);  // end before start
  assert.equal(workingDaysBetween('', '2026-11-10'), 0);
});

t('three kinds of leave', () => { assert.deepEqual([...LEAVE_TYPES], ['Annual', 'Sick', 'WFH']); });

console.log(`${n} Kuwait time checks passed`);
