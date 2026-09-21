/**
 * What an entry is called on screen.
 *
 * The database has always stored four kinds of entry — No Interaction,
 * Follow-up, Lost Sale, Sale — and every report in both apps filters on those
 * exact words. The floor now talks about a customer visit and its outcome:
 * Browsing, Interested, Lost Opportunity. So the stored value stays what it is
 * and the word on the screen is looked up here, old entries included. Nothing
 * that reads the database has to change, and a stored value never has to.
 *
 * Mirrored byte-for-byte in timekeeper-online and watch-store-crm. See
 * src/shared/README.md before editing.
 */

export type StoredCaseType = 'No Interaction' | 'Follow-up' | 'Lost Sale' | 'Sale';

export type VisitOutcome = 'browsing' | 'interested' | 'lost' | 'sale';

interface CaseLabel {
  outcome: VisitOutcome;
  /** The word on a button or a badge. */
  label: string;
  /** Right-to-left counterpart, for the bilingual screens. */
  labelAr: string;
  /** What the outcome asks of the customer. */
  hint: string;
}

export const CASE_LABELS: Record<StoredCaseType, CaseLabel> = {
  'No Interaction': { outcome: 'browsing',   label: 'Browsing',         labelAr: 'تصفّح',        hint: 'Looked around; no details taken' },
  'Follow-up':      { outcome: 'interested', label: 'Interested',       labelAr: 'مهتم',         hint: 'Wants to hear back from us' },
  'Lost Sale':      { outcome: 'lost',       label: 'Lost Opportunity', labelAr: 'فرصة ضائعة',   hint: 'Wanted something and left without it' },
  'Sale':           { outcome: 'sale',       label: 'Manual Sale',      labelAr: 'بيع يدوي',     hint: 'Recorded here until POS matching is live' },
};

const BY_OUTCOME: Record<VisitOutcome, StoredCaseType> = {
  browsing: 'No Interaction', interested: 'Follow-up', lost: 'Lost Sale', sale: 'Sale',
};

/** The display label for a stored value. Unknown values come back unchanged. */
export function caseLabel(stored: string, lang: 'en' | 'ar' = 'en'): string {
  const l = CASE_LABELS[stored as StoredCaseType];
  if (!l) return stored;
  return lang === 'ar' ? l.labelAr : l.label;
}

/** The stored value for an outcome chosen on screen. */
export const storedCaseType = (outcome: VisitOutcome): StoredCaseType => BY_OUTCOME[outcome];

/** The outcome an entry represents, for a screen that branches on it. */
export function outcomeOf(stored: string): VisitOutcome | null {
  return CASE_LABELS[stored as StoredCaseType]?.outcome ?? null;
}
