import assert from 'node:assert/strict';
import { resolveOutlet, sameOutlet, tracksStoreDay, shops, sellingOutlets, outletName, isDigital, resolveChannel, splitsByStaff } from '../outlets';
import { shiftHours, dayHours, formatHours, ABANDON_AFTER_HOURS } from '../workedHours';
import { standing, teamStanding, kuwaitDate } from '../attendanceStatus';
import { isExpectedOn, scheduleOn, describeDays, weekdayOf, KUWAIT_WEEK, type Schedule } from '../schedule';
import { storeDay } from '../storeDay';

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; };

// ── outlet identity ─────────────────────────────────────────────────────────
t('every spelling in the live database resolves', () => {
  const live: Array<[string, string]> = [
    ['Avenues', 'avenues'], ['Time Keeper - Avenues', 'avenues'],
    ['TimeGallery', 'time_gallery'], ['Time Gallery', 'time_gallery'],
    ['Time Keeper', 'whatsapp'], ['WhatsApp', 'whatsapp'],
    ['Timekeeper HQ', 'hq'], ['Online', 'online'],
  ];
  for (const [text, code] of live) assert.equal(resolveOutlet(text), code, text);
});

t('spelling differences do not make two outlets', () => {
  assert.ok(sameOutlet('TimeGallery', 'Time Gallery'));
  assert.ok(sameOutlet('time gallery', 'TIME-GALLERY'));
  assert.ok(!sameOutlet('Time Gallery', 'Avenues'));
  assert.ok(!sameOutlet('Time Keeper', 'Time Keeper - Avenues')); // whatsapp vs avenues
  assert.ok(!sameOutlet('Timekeeper HQ', 'Time Keeper'));         // office vs whatsapp
});

t('an unknown outlet is null, not a guess', () => {
  assert.equal(resolveOutlet('Mall of Kuwait'), null);
  assert.equal(resolveOutlet(null), null);
  assert.equal(resolveOutlet(''), null);
});

t('only the two shops open and close', () => {
  assert.ok(tracksStoreDay('Avenues'));
  assert.ok(tracksStoreDay('TimeGallery'));
  assert.ok(!tracksStoreDay('WhatsApp'));
  assert.ok(!tracksStoreDay('Online'));
  assert.ok(!tracksStoreDay('Timekeeper HQ'));
  assert.deepEqual(shops().map((o) => o.code), ['avenues', 'time_gallery']);
});

t('all four channels sell; the office does not', () => {
  assert.deepEqual(sellingOutlets().map((o) => o.code),
    ['avenues', 'time_gallery', 'whatsapp', 'online']);
  assert.ok(isDigital('WhatsApp') && isDigital('Online'));
  assert.equal(outletName('TimeGallery'), 'Time Gallery');
});

t('one till register splits into two channels by who rang the sale up', () => {
  // the register's real users, as Lightspeed spells them
  assert.equal(resolveChannel('Time Keeper', 'Eman Salman'), 'whatsapp');
  assert.equal(resolveChannel('Time Keeper', 'TK - Online Orders'), 'online');
  assert.equal(resolveChannel('Time Keeper', 'Ali Akbar Modi'), 'online');
  // anyone else, and nobody at all, is the online shop — the rule's catch-all
  assert.equal(resolveChannel('Time Keeper', null), 'online');
  assert.equal(resolveChannel('Time Keeper', ''), 'online');
});

t('the shops are unaffected by who was serving', () => {
  assert.equal(resolveChannel('Time Gallery', 'Eman Salman'), 'time_gallery');
  assert.equal(resolveChannel('Time Keeper - Avenues', 'Eman Salman'), 'avenues');
  assert.equal(resolveChannel('TimeGallery', null), 'time_gallery');
  assert.ok(splitsByStaff('Time Keeper'));
  assert.ok(!splitsByStaff('Time Gallery'));
  assert.ok(!splitsByStaff('Time Keeper - Avenues'));
});

t('a register nobody recognises resolves to nothing, not to a guess', () => {
  assert.equal(resolveChannel('Mall of Kuwait', 'Eman Salman'), null);
  assert.equal(resolveChannel(null, 'Eman Salman'), null);
});

// ── worked hours ────────────────────────────────────────────────────────────
const now = new Date('2026-09-17T15:00:00Z'); // 18:00 Kuwait

t('a completed shift is its length', () => {
  const s = shiftHours({ clockIn: '2026-09-17T06:00:00Z', clockOut: '2026-09-17T14:30:00Z' }, now);
  assert.equal(s.hours, 8.5);
  assert.equal(s.isOpen, false);
});

t('an open shift is hours so far, never zero', () => {
  const s = shiftHours({ clockIn: '2026-09-17T09:00:00Z', clockOut: null }, now);
  assert.equal(s.hours, 6);
  assert.ok(s.isOpen && s.isLive && !s.isAbandoned);
});

t('a shift open past the threshold has unknown hours, not enormous ones', () => {
  // The real record: clocked in 6 August, still open six weeks later.
  const s = shiftHours({ clockIn: '2026-08-06T07:22:16Z', clockOut: null }, now);
  assert.equal(s.hours, null);
  assert.ok(s.isAbandoned);
  assert.ok(!s.isLive);
  const edge = shiftHours(
    { clockIn: new Date(now.getTime() - (ABANDON_AFTER_HOURS - 0.5) * 3600000).toISOString(), clockOut: null }, now);
  assert.ok(edge.hours !== null && !edge.isAbandoned, 'just inside the threshold still counts');
});

t('an overnight shift is one shift, not a negative one', () => {
  const s = shiftHours({ clockIn: '2026-09-16T19:00:00Z', clockOut: '2026-09-16T23:30:00Z' }, now);
  assert.equal(s.hours, 4.5);
});

t('clocking out before clocking in is broken, not negative time', () => {
  const s = shiftHours({ clockIn: '2026-09-17T14:00:00Z', clockOut: '2026-09-17T09:00:00Z' }, now);
  assert.equal(s.hours, null);
  assert.ok(s.isInvalid);
});

t('a split shift adds up', () => {
  const d = dayHours([
    { clockIn: '2026-09-17T06:00:00Z', clockOut: '2026-09-17T09:00:00Z' },
    { clockIn: '2026-09-17T12:00:00Z', clockOut: '2026-09-17T14:00:00Z' },
  ], now);
  assert.equal(d.hours, 5);
  assert.equal(d.shifts, 2);
  assert.equal(d.unusableShifts, 0);
});

t('a part-broken day reports what it knows and flags the rest', () => {
  const d = dayHours([
    { clockIn: '2026-09-17T06:00:00Z', clockOut: '2026-09-17T09:00:00Z' },
    { clockIn: '2026-08-06T07:22:16Z', clockOut: null },
  ], now);
  assert.equal(d.hours, 3);
  assert.equal(d.unusableShifts, 1);
  assert.ok(d.hasAbandoned);
});

t('a day with nothing usable is unknown, not zero', () => {
  const d = dayHours([{ clockIn: '2026-08-06T07:22:16Z', clockOut: null }], now);
  assert.equal(d.hours, null);
  assert.equal(formatHours(d.hours), '—');
  assert.equal(formatHours(7.5833), '7h 35m');
});

// ── schedule ────────────────────────────────────────────────────────────────
const emp = 'e1';
const sched = (from: string, to: string | null, days: number[], start: string | null): Schedule =>
  ({ employeeId: emp, effectiveFrom: from, effectiveTo: to, workingDays: days as any, shiftStart: start, shiftEnd: null });

t('Friday is the day off in the Kuwait week', () => {
  assert.equal(weekdayOf('2026-09-18'), 5);        // a Friday
  assert.ok(!KUWAIT_WEEK.includes(5 as any));
  assert.equal(describeDays(KUWAIT_WEEK), 'Sat–Thu');
  assert.equal(describeDays([0, 2, 4] as any), 'Sun, Tue, Thu');
});

t('a future schedule change does not rewrite the past', () => {
  const history = [
    sched('2026-01-01', '2026-09-30', [0, 1, 2, 3, 4, 6], '09:00'),
    sched('2026-10-01', null, [0, 1, 2], '13:00'),   // moves to three days in October
  ];
  assert.equal(isExpectedOn(history, '2026-09-16'), true);  // a Wednesday, under the old shift
  assert.equal(isExpectedOn(history, '2026-10-14'), false); // a Wednesday, under the new one
  assert.equal(scheduleOn(history, '2026-09-16')?.shiftStart, '09:00');
  assert.equal(scheduleOn(history, '2026-10-14')?.shiftStart, '13:00');
});

t('an unknown schedule is unknown, never an absence', () => {
  assert.equal(isExpectedOn([], '2026-09-16'), null);
  assert.equal(isExpectedOn([sched('2026-10-01', null, [0], null)], '2026-09-16'), null);
});

// ── status ──────────────────────────────────────────────────────────────────
const week = [sched('2026-01-01', null, [0, 1, 2, 3, 4, 6], '09:00')];
const on = (date: string, records: any[], extra: any = {}) =>
  standing({ records, schedules: week, date, ...extra }, now).status;

t('somebody on the floor is working, with hours so far', () => {
  const s = standing({ records: [{ clockIn: '2026-09-17T09:00:00Z', clockOut: null }], schedules: week, date: '2026-09-17' }, now);
  assert.equal(s.status, 'working');
  assert.equal(s.hours.hours, 6);
});

t('an abandoned record needs a correction, not a verdict', () => {
  assert.equal(on('2026-09-17', [{ clockIn: '2026-08-06T07:22:16Z', clockOut: null }]), 'needs_correction');
});

t('expected today, shift started, not here yet = late', () => {
  assert.equal(on('2026-09-17', []), 'late'); // 18:00 Kuwait, due at 09:00
});

t('expected today but the shift has not started = due later', () => {
  const early = new Date('2026-09-17T04:00:00Z'); // 07:00 Kuwait
  assert.equal(standing({ records: [], schedules: week, date: '2026-09-17' }, early).status, 'due_later');
});

t('a past day they were due in and never came = missing', () => {
  assert.equal(on('2026-09-16', []), 'missing');
});

t('Friday is off duty, not missing', () => {
  assert.equal(on('2026-09-11', []), 'off');  // a Friday
});

t('nobody is missing on a day we cannot say they were expected', () => {
  assert.equal(standing({ records: [], schedules: [], date: '2026-09-16' }, now).status, 'no_schedule');
});

t('leave outranks everything', () => {
  assert.equal(on('2026-09-16', [], { onLeave: true }), 'on_leave');
});

t('arriving late is recorded without calling the day absent', () => {
  const s = standing({ records: [{ clockIn: '2026-09-17T08:30:00Z', clockOut: '2026-09-17T14:00:00Z' }], schedules: week, date: '2026-09-17' }, now);
  assert.equal(s.status, 'completed');       // 11:30 Kuwait start, due 09:00
  assert.ok(s.arrivedLate);
});

t('coming back from lunch is not arriving late', () => {
  const s = standing({ records: [
    { clockIn: '2026-09-17T05:55:00Z', clockOut: '2026-09-17T09:00:00Z' },  // 08:55 Kuwait
    { clockIn: '2026-09-17T11:00:00Z', clockOut: '2026-09-17T14:00:00Z' },  // 14:00 Kuwait
  ], schedules: week, date: '2026-09-17' }, now);
  assert.ok(!s.arrivedLate);
});

t('what needs acting on sorts to the top', () => {
  const roster = [
    { id: 'a', name: 'Aisha', records: [{ clockIn: '2026-09-17T09:00:00Z', clockOut: null }], schedules: week },
    { id: 'b', name: 'Bader', records: [], schedules: week },
    { id: 'c', name: 'Cem', records: [{ clockIn: '2026-08-06T07:22:16Z', clockOut: null }], schedules: week },
  ];
  assert.deepEqual(teamStanding(roster, '2026-09-17', {}, now).map((m) => m.status),
    ['needs_correction', 'late', 'working']);
});

// ── store day ───────────────────────────────────────────────────────────────
const floor = [
  { outlet: 'Avenues', who: 'Hussain', clockIn: '2026-09-17T07:45:00Z', clockOut: null },
  { outlet: 'Avenues', who: 'Ranin', clockIn: '2026-09-17T08:24:00Z', clockOut: '2026-09-17T13:00:00Z' },
  { outlet: 'TimeGallery', who: 'Fadi', clockIn: '2026-09-17T06:59:00Z', clockOut: '2026-09-17T10:31:00Z' },
];

t('a shop is open while anyone is still in it', () => {
  const d = storeDay(floor, 'Avenues', '2026-09-17', now)!;
  assert.ok(d.isOpen);
  assert.equal(d.openedAt, '2026-09-17T07:45:00Z');
  assert.equal(d.closedAt, null);
  assert.equal(d.staffIn, 1);
  assert.equal(d.staffTotal, 2);
});

t('a shop closes when the last person leaves', () => {
  const d = storeDay(floor, 'Time Gallery', '2026-09-17', now)!; // resolved by alias
  assert.ok(!d.isOpen);
  assert.equal(d.closedAt, '2026-09-17T10:31:00Z');
});

t('an abandoned clock-in does not hold a shop open for weeks', () => {
  const stale = [{ outlet: 'Avenues', who: 'Ghost', clockIn: '2026-08-06T07:22:16Z', clockOut: null }];
  const d = storeDay(stale, 'Avenues', '2026-08-06', now)!;
  assert.ok(!d.isOpen);
  assert.equal(d.abandoned, 1);
});

t('digital channels and the office have no opening hours at all', () => {
  assert.equal(storeDay(floor, 'WhatsApp', '2026-09-17', now), null);
  assert.equal(storeDay(floor, 'Online', '2026-09-17', now), null);
  assert.equal(storeDay(floor, 'Timekeeper HQ', '2026-09-17', now), null);
  assert.equal(storeDay(floor, 'Mall of Kuwait', '2026-09-17', now), null);
});

t('Kuwait is three hours ahead when the date rolls over', () => {
  assert.equal(kuwaitDate(new Date('2026-09-17T21:30:00Z')), '2026-09-18');
  assert.equal(kuwaitDate(new Date('2026-09-17T20:30:00Z')), '2026-09-17');
});

console.log(`${n} checks passed`);
