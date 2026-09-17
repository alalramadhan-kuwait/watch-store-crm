import assert from 'node:assert/strict';
import { dayPunctuality, punctualityTotals, lateClassOf, shiftTimesOn } from '../punctuality';
import type { Schedule } from '../schedule';

let n = 0; const t = (_: string, f: () => void) => { f(); n++; };

const sched = (start: string | null, end: string | null): Schedule[] => ([{
  employeeId: 'e1', effectiveFrom: '2020-01-01', effectiveTo: null,
  workingDays: [0, 1, 2, 3, 4, 6], shiftStart: start, shiftEnd: end,
}]);
/** Kuwait wall-clock on 15 Sep 2026 as an instant. */
const at = (hhmm: string) => `2026-09-15T${hhmm}:00+03:00`;
const office = { defaultStart: '09:00', defaultEnd: '17:00' };

t('the office day: arriving inside the grace hour is on time', () => {
  const d = dayPunctuality({ records: [{ clockIn: at('09:55'), clockOut: at('18:00') }], schedules: sched(null, null), date: '2026-09-15' }, office);
  assert.equal(d.hoursLate, 0);
  assert.equal(d.lateClass, 'On time');
  assert.equal(d.hoursEarly, 0);
  assert.equal(d.shift.source, 'default');
});

t('an afternoon shift is not six hours late for turning up on time', () => {
  // the real case: Avenues opens in the afternoon, judged against 09:00
  const recs = [{ clockIn: at('16:00'), clockOut: at('23:00') }];
  const wrong = dayPunctuality({ records: recs, schedules: sched(null, null), date: '2026-09-15' }, office);
  assert.ok((wrong.hoursLate as number) > 5, 'the old office-hours rule says hours late');

  const right = dayPunctuality({ records: recs, schedules: sched('16:00', '23:00'), date: '2026-09-15' }, office);
  assert.equal(right.hoursLate, 0, 'against his own shift he is on time');
  assert.equal(right.hoursEarly, 0);
  assert.equal(right.shift.source, 'schedule');
});

t('an early finisher is not leaving early every day', () => {
  // the real case: in 08:36, out 16:00, scored against a 17:00 end
  const recs = [{ clockIn: at('08:36'), clockOut: at('16:00') }];
  const wrong = dayPunctuality({ records: recs, schedules: sched(null, null), date: '2026-09-15' }, office);
  assert.equal(wrong.hoursEarly, 1);

  const right = dayPunctuality({ records: recs, schedules: sched('08:30', '16:00'), date: '2026-09-15' }, office);
  assert.equal(right.hoursEarly, 0);
});

t('lateness is counted in hours, not just occurrences', () => {
  const d = dayPunctuality({ records: [{ clockIn: at('11:30'), clockOut: at('17:00') }], schedules: sched('09:00', '17:00'), date: '2026-09-15' }, office);
  assert.equal(d.hoursLate, 1.5);          // 10:00 deadline, in at 11:30
  assert.equal(d.lateClass, 'Serious late');
});

t('only the clock-in that opened the day can be late', () => {
  const d = dayPunctuality({ records: [
    { clockIn: at('09:30'), clockOut: at('12:00') },
    { clockIn: at('16:00'), clockOut: at('21:00') },   // back after a break
  ], schedules: sched('09:00', '21:00'), date: '2026-09-15' }, office);
  assert.equal(d.hoursLate, 0);
  assert.equal(d.hoursEarly, 0, 'and the last clock-out decides leaving early');
});

t('an excused late arrival costs nothing but is still recorded', () => {
  const d = dayPunctuality({ records: [{ clockIn: at('12:00'), clockOut: at('17:00'), justified: true }], schedules: sched('09:00', '17:00'), date: '2026-09-15' }, office);
  assert.equal(d.hoursLate, 0);
  assert.ok(d.excused);
  assert.equal(d.lateClass, 'Serious late', 'the arrival was still late; somebody excused it');
});

t('a day nobody clocked out of has no leaving time to judge', () => {
  const d = dayPunctuality({ records: [{ clockIn: at('09:30'), clockOut: null }], schedules: sched('09:00', '17:00'), date: '2026-09-15' }, office);
  assert.equal(d.hoursEarly, null, 'unknown, not "left on time"');
  assert.equal(d.hoursLate, 0);
});

t('with no shift set anywhere, nothing is claimed', () => {
  const d = dayPunctuality({ records: [{ clockIn: at('14:00'), clockOut: at('20:00') }], schedules: sched(null, null), date: '2026-09-15' }, {});
  assert.equal(d.hoursLate, null);
  assert.equal(d.hoursEarly, null);
  assert.equal(d.shift.source, 'none');
});

t('last month is judged by last month s shift', () => {
  const history: Schedule[] = [
    { employeeId: 'e1', effectiveFrom: '2026-01-01', effectiveTo: '2026-08-31', workingDays: [0,1,2,3,4,6], shiftStart: '09:00', shiftEnd: '17:00' },
    { employeeId: 'e1', effectiveFrom: '2026-09-01', effectiveTo: null,        workingDays: [0,1,2,3,4,6], shiftStart: '16:00', shiftEnd: '23:00' },
  ];
  assert.equal(shiftTimesOn(history, '2026-08-20').start, '09:00');
  assert.equal(shiftTimesOn(history, '2026-09-15').start, '16:00');
});

t('a month adds up, and says what it could not judge', () => {
  const days = [
    dayPunctuality({ records: [{ clockIn: at('11:00'), clockOut: at('17:00') }], schedules: sched('09:00','17:00'), date: '2026-09-15' }, office), // 1h late
    dayPunctuality({ records: [{ clockIn: at('09:30'), clockOut: at('15:30') }], schedules: sched('09:00','17:00'), date: '2026-09-16' }, office), // 1.5h early
    dayPunctuality({ records: [{ clockIn: at('10:00'), clockOut: null }],        schedules: sched('09:00','17:00'), date: '2026-09-17' }, office),
    dayPunctuality({ records: [{ clockIn: at('14:00'), clockOut: at('20:00') }], schedules: sched(null, null),      date: '2026-09-18' }, {}),
  ];
  const tot = punctualityTotals(days);
  assert.equal(tot.days, 4);
  assert.equal(tot.hoursLate, 1);
  assert.equal(tot.hoursEarly, 1.5);
  assert.equal(tot.timesLate, 1);
  assert.equal(tot.timesEarly, 1);
  assert.equal(tot.daysWithoutShift, 1, 'the day with no shift set is flagged, not counted as on time');
});

t('the words still step at fifteen and thirty minutes past grace', () => {
  assert.equal(lateClassOf(0), 'On time');
  assert.equal(lateClassOf(15), 'Minor late');
  assert.equal(lateClassOf(16), 'Late');
  assert.equal(lateClassOf(31), 'Serious late');
});

console.log(`${n} punctuality checks passed`);
