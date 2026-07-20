export type CaseType = 'Sale' | 'Follow-up' | 'Lost Sale' | 'No Interaction';

export type CaseStatus = 'Open' | 'Won' | 'Lost' | 'No Response' | 'Closed';

export type ProductType = 'Watch' | 'Strap' | 'Box / Winder' | 'Accessories' | 'Service' | 'Other';

export type Channel = 'Call' | 'WhatsApp' | 'SMS' | 'Email';

export const PRODUCT_TYPES: ProductType[] = [
  'Watch', 'Strap', 'Box / Winder', 'Accessories', 'Service', 'Other',
];

export const LOST_REASONS_QUICK = [
  'Price', 'Not Available', 'Wants Discount', 'Just Checking',
  'Wrong Size / Color', 'Waiting / Later', 'Bought Elsewhere', 'Other',
];

export const FOLLOWUP_ACTIONS_QUICK = [
  'Call', 'WhatsApp', 'Send Photos', 'Check Availability', 'Reserve Item', 'Other',
];

/** @deprecated — kept for backward-compat display of old entries */
export const BROWSING_TAGS = [
  'Looked at watches', 'Looked at straps / accessories',
  'Asked nothing', 'Left quickly', 'Stayed 5+ minutes',
];

/** What section the visitor was looking at (multi-select) */
export const BROWSING_SECTIONS = [
  'Watches', 'Straps', 'Accessories', 'Window Display',
];

/** Visitor behaviour (single-select) */
export const BROWSING_BEHAVIOURS = [
  'Quick glance', 'Browsed 5+ min', 'Picked up items', 'Staff approached — declined',
];

export const STAFF_DEFAULT = [
  'Ahmad Yousri', 'Ahmad Khalaf', 'Raneen', 'Hussein Deeb', 'Fadi',
];

export const LOST_REASONS_DEFAULT = [
  'Price', 'Not Available', 'Wants Discount', 'Just Checking',
  'Wrong Size / Color', 'Waiting / Later', 'Bought Elsewhere', 'Other',
];

export const FOLLOWUP_ACTIONS_DEFAULT = [
  'Call', 'WhatsApp', 'Send Photos', 'Check Availability', 'Reserve Item', 'Other',
];

export const CHANNELS_DEFAULT: Channel[] = ['Call', 'WhatsApp', 'SMS', 'Email'];

export interface Brand {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
  usageCount?: number;
}

export interface AuditEntry {
  timestamp: string;
  action: 'created' | 'edited' | 'deleted' | 'status_changed' | 'reassigned' | 'contacted' | 'converted';
  by: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
  note?: string;
}

export interface SaleItem {
  id?: string;
  brand?: string;
  productType?: ProductType;
  product?: string;
  quantity: number;
  amountKD: number;    // line total (not unit price)
  sortOrder: number;
}

export interface Case {
  id?: string;
  caseId: string;
  dateLogged: string;
  timeLogged: string;
  staff: string;
  outlet?: string;
  customerName?: string;
  contact?: string;
  caseType: CaseType;
  brand?: string;
  productType?: ProductType;
  product: string;
  amountKD?: number;
  lostReason?: string;
  followUpAction?: string;
  promisedCallback?: string;
  lastContactDate?: string;
  channel?: string;
  browsingTags?: string[];
  notes?: string;
  visitorCount?: number;   // for No Interaction entries (default 1)
  status: CaseStatus;
  dayLocked: boolean;
  linkedCaseId?: string;
  auditLog: AuditEntry[];
  deleted?: boolean;
  saleItems?: SaleItem[];
}

export interface DayClose {
  id?: string;
  date: string;
  outlet: string;       // '' = all outlets combined; 'Avenues' / 'TimeGallery' = outlet-specific
  closedAt: string;
  closedBy: string;
  reportSummary?: string;
  autoClosed: boolean;
}

export interface AppSettings {
  id?: string;
  staffRoster: string[];
  lostReasons: string[];
  followUpActions: string[];
  channels: string[];
  outlets: string[];
  managerPin: string;
}

export interface DayStats {
  salesCount: number;
  salesKD: number;
  followupCount: number;
  lostCount: number;
  noInteractionCount: number;
  conversionRate: number;
  interactionRate: number;
}

export type FollowUpOutcome = 'contacted' | 'won' | 'lost' | 'no_response';
