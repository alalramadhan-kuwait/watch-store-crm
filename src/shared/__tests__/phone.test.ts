import assert from 'node:assert/strict';
import { normalizePhone, displayPhone, samePhone } from '../phoneRules';

let n = 0; const t = (_: string, f: () => void) => { f(); n++; };

/* Every pair here is the SQL function's actual output on 2026-09-21
   (select normalize_phone(in)), so the two implementations are pinned together. */
const FIXTURES: [string | null, string | null][] = [
  ['97202422',           '+96597202422'],
  ['9720 2422',          '+96597202422'],
  ['9720-2422',          '+96597202422'],
  ['(9720) 2422',        '+96597202422'],
  ['+965 9720 2422',     '+96597202422'],
  ['+96597202422',       '+96597202422'],
  ['0096597202422',      '+96597202422'],
  ['96597202422',        '+96597202422'],
  ['965 97202422',       '+96597202422'],
  ['22412345',           '+96522412345'],
  ['51234567',           '+96551234567'],
  ['66778899',           '+96566778899'],
  ['12345678',           null],            // no Kuwait number starts with 1
  ['9720242',            null],            // seven digits
  ['972024221',          null],            // nine digits, no country code
  ['+966 50 123 4567',   '+966501234567'],
  ['00966501234567',     '+966501234567'],
  ['966501234567',       '+966501234567'], // bare, but begins with a code we know
  ['+971501234567',      '+971501234567'],
  ['971 50 123 4567',    '+971501234567'],
  ['+201001234567',      '+201001234567'],
  ['+44 7700 900123',    '+447700900123'],
  ['0501234567',         null],            // a foreign local number: country unknown
  ['abc',                null],
  ['',                   null],
  ['   ',                null],
  [null,                 null],
  ['97202422 / 66778899', null],           // two numbers in one field is not a number
  ['+965',               null],
];

for (const [input, expected] of FIXTURES) {
  t(`normalize ${JSON.stringify(input)}`, () => assert.equal(normalizePhone(input), expected));
}

t('display: Kuwait numbers lose the code, others keep it', () => {
  assert.equal(displayPhone('+96597202422'), '97202422');
  assert.equal(displayPhone('+966501234567'), '+966501234567');
  assert.equal(displayPhone(null), null);
});

t('same phone across formatting', () => {
  assert.equal(samePhone('9720 2422', '+965 97202422'), true);
  assert.equal(samePhone('97202422', '97202423'), false);
  assert.equal(samePhone('abc', 'abc'), false);   // unmatchable is never "the same"
});

console.log(`${n} phone checks passed`);
