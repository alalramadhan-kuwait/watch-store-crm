import assert from 'node:assert/strict';
import { workload, fairness } from '../workload';

let n = 0; const t = (_: string, f: () => void) => { f(); n++; };
const now = new Date('2026-09-17T15:00:00Z');

const rec = (who: string, date: string, from: string, to: string | null, outlet = 'Avenues') =>
  ({ who, date, outlet, clockIn: `${date}T${from}:00Z`, clockOut: to ? `${date}T${to}:00Z` : null });

t('a split shift is one day, not two', () => {
  const [r] = workload([
    rec('Ranin', '2026-09-15', '06:00', '09:00'),
    rec('Ranin', '2026-09-15', '12:00', '14:00'),
  ], {}, now);
  assert.equal(r.daysWorked, 1);
  assert.equal(r.shifts, 2);
  assert.equal(r.hours, 5);
  assert.equal(r.perDay, 5);
});

t('outlets are matched however they are spelled', () => {
  const recs = [
    rec('Fadi', '2026-09-15', '06:00', '14:00', 'TimeGallery'),
    rec('Ahmad', '2026-09-15', '06:00', '14:00', 'Avenues'),
  ];
  assert.deepEqual(workload(recs, { outlet: 'Time Gallery' }, now).map(r => r.who), ['Fadi']);
  assert.deepEqual(workload(recs, { outlet: 'Time Keeper - Avenues' }, now).map(r => r.who), ['Ahmad']);
});

t('a period excludes what falls outside it', () => {
  const recs = [
    rec('Ranin', '2026-09-10', '06:00', '14:00'),
    rec('Ranin', '2026-09-15', '06:00', '14:00'),
  ];
  assert.equal(workload(recs, { from: '2026-09-12', to: '2026-09-18' }, now)[0].daysWorked, 1);
});

t('a day nobody clocked out of is a gap, not a light day', () => {
  const [r] = workload([
    rec('Meriam', '2026-09-15', '06:00', '14:00'),
    rec('Meriam', '2026-09-16', '07:00', null),   // abandoned, 30h ago
  ], {}, now);
  assert.equal(r.daysWorked, 1, 'the unclosed day is not counted as worked');
  assert.equal(r.unusableShifts, 1);
  assert.equal(r.hours, 8, 'and its hours are not invented');
});

t('a shift still running counts the hours so far', () => {
  const [r] = workload([rec('Hussain', '2026-09-17', '09:00', null)], {}, now);
  assert.equal(r.hours, 6);
});

t('fairness compares hours per day due, not raw totals', () => {
  const recs = [
    // a part-timer: 4 days at 8h
    ...['2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16'].map(d => rec('Part', d, '06:00', '14:00')),
    // a full-timer: 6 days at 8h
    ...['2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16']
        .map(d => rec('Full', d, '06:00', '14:00')),
  ];
  const due = new Map([['Part', 4], ['Full', 6]]);
  const rows = workload(recs, { daysDue: due }, now);
  assert.equal(rows[0].who, 'Full', 'raw hours put the full-timer on top');
  assert.equal(rows[0].hours, 48);
  assert.equal(rows[1].hours, 32);

  const f = fairness(rows);
  assert.equal(f.spread, 0, 'but per day due they are carrying the same load');
  assert.ok(!f.uneven, 'so nothing is flagged');
});

t('a genuinely uneven week is flagged', () => {
  const rows = workload([
    ...['2026-09-14', '2026-09-15', '2026-09-16'].map(d => rec('Long', d, '05:00', '16:00')), // 11h
    ...['2026-09-14', '2026-09-15', '2026-09-16'].map(d => rec('Short', d, '09:00', '14:00')), // 5h
  ], { daysDue: new Map([['Long', 3], ['Short', 3]]) }, now);
  const f = fairness(rows);
  assert.equal(f.busiest?.who, 'Long');
  assert.equal(f.quietest?.who, 'Short');
  assert.equal(f.spread, 6);
  assert.ok(f.uneven);
});

t('one person alone is never unfair', () => {
  const f = fairness(workload([rec('Solo', '2026-09-15', '06:00', '14:00')], { daysDue: new Map([['Solo', 1]]) }, now));
  assert.ok(!f.uneven);
  assert.equal(f.spread, null);
});

console.log(`${n} workload checks passed`);
