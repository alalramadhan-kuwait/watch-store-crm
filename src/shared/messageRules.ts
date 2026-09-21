/**
 * A message template, filled in.
 *
 * The master text lives in message_templates, in English and Arabic, and only
 * an admin changes it. What an employee sees is the text with the customer's
 * name, their own name, the store and the product put in. This is that step,
 * done on the phone so the message can be read and adjusted before WhatsApp
 * opens. public.render_template() is the same rule in SQL; the fixtures in
 * __tests__/message.test.ts were produced by running it, so the two cannot
 * drift without a test saying so.
 *
 * Nothing here sends anything. The employee presses Send in WhatsApp.
 *
 * Mirrored byte-for-byte in timekeeper-online and watch-store-crm. See
 * src/shared/README.md before editing.
 */

export type TemplateLang = 'en' | 'ar';

export type TemplateKey =
  | 'interested_followup' | 'post_sale_checkin' | 'birthday'
  | 'anniversary' | 'back_in_stock' | 'general_followup';

export interface TemplateVars {
  first_name?: string | null;
  salesperson?: string | null;
  store?: string | null;
  product?: string | null;
}

/**
 * Put the values in. A placeholder with nothing to fill it disappears, and
 * the punctuation it leaves behind is tidied — "Hello , this is" reads as
 * "Hello, this is".
 */
export function renderTemplate(body: string, vars: TemplateVars): string {
  let out = body ?? '';
  for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v ?? '');
  out = out.replace(/\{\{[a-z_]+\}\}/g, '');
  out = out.replace(/ ([,.!?،؟])/g, '$1');
  out = out.replace(/ {2,}/g, ' ');
  return out.trim();
}

/** The first name, as a greeting would use it. "MR MOHAMMED AL AJEEL" → "Mohammed". */
export function greetingName(fullName: string | null | undefined): string {
  if (!fullName) return '';
  const words = fullName.trim().split(/\s+/).filter((w) => !/^(mr|mrs|ms|miss|dr|sheikh|sheikha|eng|sayed|sayyed)\.?$/i.test(w));
  const first = words[0] ?? '';
  if (!first) return '';
  return /^[A-Z ]+$/.test(first) ? first.charAt(0) + first.slice(1).toLowerCase() : first;
}

/**
 * The link that opens WhatsApp to this number with this text. Null when the
 * number is not one WhatsApp can open, so a screen can say why rather than
 * open a chat to nobody.
 */
export function whatsappLink(phoneE164: string | null | undefined, text: string): string | null {
  if (!phoneE164 || !/^\+\d{8,15}$/.test(phoneE164)) return null;
  return `https://wa.me/${phoneE164.slice(1)}?text=${encodeURIComponent(text)}`;
}
