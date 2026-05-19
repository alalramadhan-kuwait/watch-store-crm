export type CaseType = 'Sale' | 'Follow-up' | 'Lost Sale';

export type CaseStatus = 'Open' | 'Won' | 'Lost' | 'No Response';

export type Channel = 'Call' | 'WhatsApp' | 'SMS' | 'Email';

export const STAFF_DEFAULT = [
  'Ahmad Yousri',
  'Ahmad Khalaf',
  'Raneen',
  'Hussein Deeb',
  'Fadi',
];

export const LOST_REASONS_DEFAULT = [
  'Out of stock',
  'Size not available',
  'Color not available',
  'Price issue',
  'Customer changed mind',
  'Product not suitable',
  'Not available in branch',
  'Need approval/discount',
  'Other',
];

export const FOLLOWUP_ACTIONS_DEFAULT = [
  'Call customer',
  'WhatsApp customer',
  'Send pictures',
  'Check stock',
  'Transfer from branch',
  'Reorder item',
  'Inform when available',
];

export const CHANNELS_DEFAULT: Channel[] = ['Call', 'WhatsApp', 'SMS', 'Email'];

export interface AuditEntry {
  timestamp: string;
  action: 'created' | 'edited' | 'deleted' | 'status_changed' | 'reassigned' | 'contacted' | 'converted';
  by: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
  note?: string;
}

export interface Case {
  id?: string;           // Supabase UUID
  caseId: string;
  dateLogged: string;
  timeLogged: string;
  staff: string;
  customerName?: string;
  contact?: string;
  caseType: CaseType;
  product: string;
  amountKD?: number;
  lostReason?: string;
  followUpAction?: string;
  promisedCallback?: string;
  lastContactDate?: string;
  channel?: string;
  status: CaseStatus;
  dayLocked: boolean;
  linkedCaseId?: string;
  auditLog: AuditEntry[];
  deleted?: boolean;
}

export interface DayClose {
  id?: string;
  date: string;
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
  managerPin: string;
  staffPin: string;
}

export interface DayStats {
  salesCount: number;
  salesKD: number;
  followupCount: number;
  lostCount: number;
  conversionRate: number;
}

export type FollowUpOutcome = 'contacted' | 'won' | 'lost' | 'no_response';
