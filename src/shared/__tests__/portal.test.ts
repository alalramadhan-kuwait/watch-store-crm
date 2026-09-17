import assert from 'node:assert/strict';
// pure helpers only — the query functions need a browser client
import { leaveBalance, metresBetween, fencesNear, todayKuwait, kuwaitISO } from '../portalRules';

let n = 0; const t = (_: string, f: () => void) => { f(); n++; };
const now = new Date('2026-09-17T15:00:00Z');

t('Kuwait is three hours ahead', () => {
  assert.equal(todayKuwait(new Date('2026-09-17T21:30:00Z')), '2026-09-18');
  assert.equal(kuwaitISO('2026-09-17', '09:00'), '2026-09-17T06:00:00.000Z');
});

t('pending leave is not deducted from the balance', () => {
  const b = leaveBalance([
    { approval_status: 'Approved', leave_type: 'Annual', leave_end: '2026-08-10', days: 5 },
    { approval_status: 'Approved', leave_type: 'Annual', leave_end: '2026-12-20', days: 7 },
    { approval_status: 'Pending',  leave_type: 'Annual', leave_end: '2026-11-01', days: 4 },
  ] as never, 30, now);
  assert.deepEqual(b, { entitlement: 30, taken: 5, booked: 7, remaining: 18 });
});

t('sick leave is not a holiday', () => {
  const b = leaveBalance([
    { approval_status: 'Approved', leave_type: 'Sick', leave_end: '2026-08-10', days: 3 },
  ] as never, 30, now);
  assert.equal(b.remaining, 30);
});

t('cancelled leave gives the days back', () => {
  const b = leaveBalance([
    { approval_status: 'Cancelled', leave_type: 'Annual', leave_end: '2026-12-01', days: 6 },
  ] as never, 30, now);
  assert.equal(b.remaining, 30);
});

t('a balance never goes below zero', () => {
  const b = leaveBalance([
    { approval_status: 'Approved', leave_type: 'Annual', leave_end: '2026-08-01', days: 40 },
  ] as never, 30, now);
  assert.equal(b.remaining, 0);
  assert.equal(b.taken, 40);
});

t('distance to the Time Gallery geofence is metres, not degrees', () => {
  // Salhiya Complex, from ~250m away
  const d = metresBetween(29.364062, 47.967188, 29.366_3, 47.967_188);
  assert.ok(d > 200 && d < 300, `${d}`);
  assert.equal(Math.round(metresBetween(29.364062, 47.967188, 29.364062, 47.967188)), 0);
});

t('every workplace is offered, nearest first', () => {
  const fences = [
    { id: 'a', name: 'Avenues', lat: 29.3000, lng: 47.9400, radius_m: 250, active: true },
    { id: 'g', name: 'Time Gallery', lat: 29.364062, lng: 47.967188, radius_m: 250, active: true },
  ];
  const near = fencesNear(fences, { latitude: 29.3641, longitude: 47.9672, accuracy: 20 });
  assert.equal(near[0].fence.name, 'Time Gallery');
  assert.ok(near[0].inside, 'standing in the Gallery counts as inside it');
  assert.ok(!near[1].inside, 'and not as inside Avenues');
  assert.equal(near.length, 2, 'the far one is still offered, with its distance');
});

console.log(`${n} portal checks passed`);
