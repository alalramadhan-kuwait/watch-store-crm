import assert from 'node:assert/strict';
import { monthSales, eventDates, daysInMonthOf, type TillRow } from '../tillSales';

let n = 0; const t = (_: string, f: () => void) => { f(); n++; };

/* November 2026 as the database had it on 24 Nov: sales to the end of the 23rd,
   and the Expo stand's register (no channel) selling 5–12 Nov. */
const row = (channel_code: string | null, sale_date: string, revenue: number, sale_count: number, outlet?: string): TillRow =>
  ({ channel_code, sale_date, revenue, sale_count, outlet: outlet ?? null });
const nov: TillRow[] = [
  row('avenues', '2026-11-01', 37172 - 1390, 177, 'Time Keeper - Avenues'),
  row('avenues', '2026-11-23', 1390, 8, 'Time Keeper - Avenues'),
  row('time_gallery', '2026-11-02', 3122.5 - 258, 28, 'Time Gallery'),
  row('time_gallery', '2026-11-23', 258, 1, 'Time Gallery'),
  row('online', '2026-11-05', 14562.8 - 70, 81, 'Time Keeper'),
  row('online', '2026-11-23', 70, 2, 'Time Keeper'),
  row('whatsapp', '2026-11-03', 6182 - 288, 21, 'Time Keeper'),
  row('whatsapp', '2026-11-23', 288, 1, 'Time Keeper'),
  row(null, '2026-11-05', 10567, 17, 'Expo'),
  row(null, '2026-11-06', 10420, 14, 'Expo'),
  row(null, '2026-11-07', 11585, 25, 'Expo'),
  row(null, '2026-11-08', 18243, 30, 'Expo'),
  row(null, '2026-11-09', 25076.5, 43, 'Expo'),
  row(null, '2026-11-10', 2810, 3, 'Expo'),
  row(null, '2026-11-11', 1450, 1, 'Expo'),
  row(null, '2026-11-12', 195, 4, 'Expo'),
  // a row from last month, which a wider read may bring along
  row('avenues', '2026-10-31', 5000, 3, 'Time Keeper - Avenues'),
];
const targets = { avenues: 45000, time_gallery: 9000, online: 41000, whatsapp: 15000 };
const m = monthSales(nov, { month: '2026-11', targets, monthTarget: 110000 });
const close = (a: number | null, b: number, eps = 0.05) => assert.ok(a !== null && Math.abs(a - b) < eps, `${a} ≈ ${b}`);

t('the target is judged on the four regular channels only', () => {
  close(m.regular.sales, 61039.3);
  assert.equal(m.regular.target, 110000);
  assert.equal(Math.round(m.regular.pct!), 55);
});

t('pace is counted in till days', () => {
  assert.equal(m.lastSaleDay, '2026-11-23');
  assert.equal(m.tillDays, 23);
  assert.equal(m.daysInMonth, 30);
  assert.equal(Math.round(m.paceFrac! * 100), 77);
});

t('the projection runs the regular rate forward, never the event', () => {
  assert.equal(Math.round(m.regular.projected! / 100) / 10, 79.6);
  assert.equal(Math.round(m.regular.projectedShort! / 100) / 10, 30.4);
});

t('an unregistered register is an event row with its dates, count and no target', () => {
  assert.equal(m.events.length, 1);
  const [e] = m.events;
  assert.equal(e.name, 'Expo');
  close(e.sales, 80346.5);
  assert.equal(e.count, 137);
  assert.equal(e.from, '2026-11-05');
  assert.equal(e.to, '2026-11-12');
  assert.equal(eventDates(e.from, e.to), '5–12 Nov');
  assert.ok(!('target' in e));
});

t('each channel carries its own figure and target', () => {
  const by = Object.fromEntries(m.channels.map((c) => [c.code, c]));
  assert.deepEqual(m.channels.map((c) => c.code), ['avenues', 'time_gallery', 'whatsapp', 'online']);
  close(by.avenues.sales, 37172);
  assert.equal(by.avenues.count, 185);
  assert.equal(Math.round(by.online.pct!), 36);
  assert.equal(Math.round(by.time_gallery.pct!), 35);
  close(m.channels.reduce((s, c) => s + c.sales, 0), m.regular.sales);
});

t('a month with no till days has no pace and no projection', () => {
  const empty = monthSales([], { month: '2026-12', targets, monthTarget: 110000 });
  assert.equal(empty.tillDays, null);
  assert.equal(empty.paceFrac, null);
  assert.equal(empty.regular.projected, null);
  assert.equal(empty.regular.pct, 0);
  assert.equal(empty.events.length, 0);
});

t('no monthly target means no percentage, not a percentage of nothing', () => {
  const none = monthSales(nov, { month: '2026-11', targets: {}, monthTarget: null });
  assert.equal(none.regular.pct, null);
  assert.equal(none.regular.projectedShort, null);
  assert.equal(none.channels[0].pct, null);
});

t('month lengths and event date spans read the calendar', () => {
  assert.equal(daysInMonthOf('2026-02'), 28);
  assert.equal(daysInMonthOf('2028-02'), 29);
  assert.equal(eventDates('2026-11-12', '2026-11-12'), '12 Nov');
  assert.equal(eventDates('2026-10-28', '2026-11-02'), '28 Oct – 2 Nov');
});

console.log(`tillSales: ${n} checks passed`);
