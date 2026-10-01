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

console.log(`${n} customer group checks passed`);
