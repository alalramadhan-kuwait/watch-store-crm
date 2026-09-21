/**
 * What a phone number is — one rule, for both apps.
 *
 * It mirrors public.normalize_phone() in the database, which is what stored
 * data obeys; this is what a form can check before sending, and what a screen
 * uses to show a number the way a person here would write it. The fixtures in
 * __tests__/phone.test.ts were produced by running the SQL function, so the two
 * cannot drift without a test saying so.
 *
 * Kuwait is the default: an 8-digit local number, with or without 965 in
 * front, in any punctuation. A number written as international (+ or 00) keeps
 * its own country code. Bare digits beginning with a country code we recognise
 * are treated as international. Anything else is not a number we can match on
 * and comes back null — the raw text is always kept alongside, never lost.
 *
 * Mirrored byte-for-byte in timekeeper-online and watch-store-crm. See
 * src/shared/README.md before editing.
 */

const KUWAIT_LOCAL = /^[24569]\d{7}$/;

/** Country codes a bare number may begin with and still be trusted as international. */
const KNOWN_CODES = ['966', '971', '974', '973', '968', '964', '962', '961', '963', '20', '91', '92', '44'];

/** E.164 (+96597202422), or null when the text is not a phone number we can match on. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = raw.trim();
  if (!s) return null;
  const intl = /^(\+|00)/.test(s);
  let d = s.replace(/[^0-9]/g, '');
  if (intl && d.startsWith('00')) d = d.slice(2);
  if (!d) return null;
  if (d.length === 8 && KUWAIT_LOCAL.test(d)) return '+965' + d;
  if (d.length === 11 && d.startsWith('965') && KUWAIT_LOCAL.test(d.slice(3))) return '+965' + d.slice(3);
  if (intl && d.length >= 8 && d.length <= 15) return '+' + d;
  for (const cc of KNOWN_CODES) {
    const rest = d.length - cc.length;
    if (d.startsWith(cc) && rest >= 7 && rest <= 12) return '+' + d;
  }
  return null;
}

/** The number as somebody in Kuwait would write it: 8 digits at home, +code abroad. */
export function displayPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  return e164.startsWith('+965') ? e164.slice(4) : e164;
}

/** Two raw entries are the same phone when they normalise to the same E.164. */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizePhone(a);
  return x !== null && x === normalizePhone(b);
}
