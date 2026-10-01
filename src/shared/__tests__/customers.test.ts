import assert from 'node:assert/strict';
import { groupOf, isTop, lastSeen, GROUP_LABEL } from '../customerTiers';

let n = 0; const t = (_: string, f: () => void) => { f(); n++; };

const NOW = new Date('2026-10-01T09:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const c = (o: Partial<Parameters<typeof groupOf>[0]> = {}) =>
  ({ isVip: false, purchases: 0, purchasesKD: 0, lastVisit: null, lastPurchase: null, ...o });

t('big spenders and repeat buyers are top', () => {
  assert.equal(isTop(c({ purchasesKD: 1000 })), true);
  assert.equal(isTop(c({ purchasesKD: 999 })), false);
  assert.equal(isTop(c({ purchases: 3 })), true);
  assert.equal(isTop(c({ purchases: 2 })), false);
  assert.equal(isTop(c({ isVip: true })), true);
});
t('top and seen this year stays top; top and gone a year is win back', () => {
  assert.equal(groupOf(c({ purchasesKD: 1500, purchases: 1, lastPurchase: ago(100) }), NOW), 'top');
  assert.equal(groupOf(c({ purchasesKD: 1500, purchases: 1, lastPurchase: ago(400) }), NOW), 'win_back');
});
t('a logged visit counts as being seen', () => {
  assert.equal(groupOf(c({ purchases: 4, lastPurchase: ago(500), lastVisit: ago(10) }), NOW), 'top');
  assert.equal(lastSeen(c({ lastPurchase: ago(500), lastVisit: ago(10) })), ago(10));
});
t('a first purchase in the last 60 days is new, a second is not', () => {
  assert.equal(groupOf(c({ purchases: 1, purchasesKD: 150, lastPurchase: ago(20) }), NOW), 'new');
  assert.equal(groupOf(c({ purchases: 1, purchasesKD: 150, lastPurchase: ago(90) }), NOW), 'other');
  assert.equal(groupOf(c({ purchases: 2, purchasesKD: 300, lastPurchase: ago(20) }), NOW), 'other');
});
t('top wins over new, and nobody seen never is top by accident', () => {
  assert.equal(groupOf(c({ purchases: 1, purchasesKD: 2000, lastPurchase: ago(5) }), NOW), 'top');
  assert.equal(groupOf(c({ purchases: 3 }), NOW), 'win_back');
  assert.equal(groupOf(c(), NOW), 'other');
});
t('every group has a label, other has none', () => {
  assert.equal(GROUP_LABEL.top, 'Top'); assert.equal(GROUP_LABEL.win_back, 'Win back');
  assert.equal(GROUP_LABEL.new, 'New'); assert.equal(GROUP_LABEL.other, '');
});


import { weekProgress, targetState, neededPerDay, weekStart } from '../weeklyTarget';
import { DEFAULT_PRODUCT } from '../messageRules';
import { outletNameAr } from '../outlets';

t('the week runs Saturday to Friday', () => {
  assert.equal(weekStart('2026-10-01'), '2026-09-26'); // a Thursday
  assert.equal(weekStart('2026-09-26'), '2026-09-26'); // the Saturday itself
  assert.equal(weekStart('2026-10-02'), '2026-09-26'); // the Friday
  const w = weekProgress('2026-10-01');
  assert.equal(w.day, 6); assert.equal(w.end, '2026-10-02'); assert.equal(w.daysLeft, 1);
  assert.equal(weekProgress('2026-09-26').day, 1);
});
t('progress is judged against how much of the week has gone', () => {
  const tue = weekProgress('2026-09-29'); // day 4
  assert.equal(targetState(3500, 3500, tue), 'done');
  assert.equal(targetState(1000, 3500, tue), 'behind');
  assert.equal(targetState(2000, 3500, tue), 'on_track');
  assert.equal(targetState(3000, 3500, tue), 'ahead');
  assert.equal(targetState(100, null, tue), 'none');
  // a slow first two days say nothing
  assert.equal(targetState(0, 3500, weekProgress('2026-09-27')), 'on_track');
});
t('what is still needed each day counts today', () => {
  assert.equal(neededPerDay(1500, 3500, weekProgress('2026-10-01')), 1000); // Thu: today and Fri left
  assert.equal(neededPerDay(3500, 3500, weekProgress('2026-10-01')), null);
});
t('a message with no product says "the watch", and shops have Arabic names', () => {
  assert.equal(DEFAULT_PRODUCT.en, 'watch'); assert.equal(DEFAULT_PRODUCT.ar, 'الساعة');
  assert.equal(outletNameAr('Avenues'), 'الأفنيوز');
  assert.equal(outletNameAr('Time Keeper - Avenues'), 'الأفنيوز');
  assert.equal(outletNameAr('Time Gallery'), 'تايم جاليري');
  assert.equal(outletNameAr('Somewhere new'), 'Somewhere new');
});

console.log(`${n} customer group checks passed`);
