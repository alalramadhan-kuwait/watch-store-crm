import assert from 'node:assert/strict';
import { caseLabel, storedCaseType, outcomeOf, CASE_LABELS } from '../caseLabels';

let n = 0; const t = (_: string, f: () => void) => { f(); n++; };

t('stored values map to the words on screen', () => {
  assert.equal(caseLabel('No Interaction'), 'Browsing');
  assert.equal(caseLabel('Follow-up'), 'Interested');
  assert.equal(caseLabel('Lost Sale'), 'Lost Opportunity');
  assert.equal(caseLabel('Sale'), 'Manual Sale');
});
t('and back again, so a chosen outcome stores the old value', () => {
  assert.equal(storedCaseType('browsing'), 'No Interaction');
  assert.equal(storedCaseType('interested'), 'Follow-up');
  assert.equal(storedCaseType('lost'), 'Lost Sale');
  assert.equal(storedCaseType('sale'), 'Sale');
  for (const stored of Object.keys(CASE_LABELS)) assert.equal(storedCaseType(outcomeOf(stored)!), stored);
});
t('arabic labels exist for every kind', () => {
  for (const stored of Object.keys(CASE_LABELS)) assert.ok(caseLabel(stored, 'ar').length > 0);
});
t('an unknown value is shown as it is, not hidden', () => {
  assert.equal(caseLabel('Repair'), 'Repair');
  assert.equal(outcomeOf('Repair'), null);
});

console.log(`${n} label checks passed`);
