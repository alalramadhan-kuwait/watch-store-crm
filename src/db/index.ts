import { supabase } from '../lib/supabase';
import { format } from 'date-fns';
import type { Case, DayClose, AppSettings, CaseType, CaseStatus, AuditEntry, Brand, ProductType } from '../types';
import { STAFF_DEFAULT, LOST_REASONS_DEFAULT, FOLLOWUP_ACTIONS_DEFAULT, CHANNELS_DEFAULT } from '../types';
import { formatKD } from '../utils/formatKD';

// ── DB row types ──────────────────────────────────────────────────────────────

interface DbCase {
  id: string;
  case_id: string;
  date_logged: string;
  time_logged: string;
  staff: string;
  outlet: string | null;
  customer_name: string | null;
  contact: string | null;
  case_type: string;
  brand: string | null;
  product_type: string | null;
  product: string;
  amount_kd: number | null;
  lost_reason: string | null;
  follow_up_action: string | null;
  promised_callback: string | null;
  last_contact_date: string | null;
  channel: string | null;
  browsing_tags: string[] | null;
  status: string;
  day_locked: boolean;
  linked_case_id: string | null;
  audit_log: AuditEntry[];
  deleted: boolean;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

interface DbSettings {
  id: string;
  staff_roster: string[];
  lost_reasons: string[];
  follow_up_actions: string[];
  channels: string[];
  outlets: string[];
  manager_pin: string;
}

interface DbDayClose {
  id: string;
  date: string;
  closed_at: string;
  closed_by: string;
  report_summary: string | null;
  auto_closed: boolean;
}

interface DbBrand {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
}

// ── Mappers ───────────────────────────────────────────────────────────────────

function caseFromDb(row: DbCase): Case {
  return {
    id: row.id,
    caseId: row.case_id,
    dateLogged: row.date_logged,
    timeLogged: row.time_logged,
    staff: row.staff,
    outlet: row.outlet ?? undefined,
    customerName: row.customer_name ?? undefined,
    contact: row.contact ?? undefined,
    caseType: row.case_type as CaseType,
    brand: row.brand ?? undefined,
    productType: row.product_type as ProductType ?? undefined,
    product: row.product,
    amountKD: row.amount_kd ?? undefined,
    lostReason: row.lost_reason ?? undefined,
    followUpAction: row.follow_up_action ?? undefined,
    promisedCallback: row.promised_callback ?? undefined,
    lastContactDate: row.last_contact_date ?? undefined,
    channel: row.channel ?? undefined,
    browsingTags: row.browsing_tags ?? undefined,
    status: row.status as CaseStatus,
    dayLocked: row.day_locked,
    linkedCaseId: row.linked_case_id ?? undefined,
    auditLog: row.audit_log ?? [],
    deleted: row.deleted,
  };
}

function caseToDb(c: Omit<Case, 'id'>): Omit<DbCase, 'id' | 'created_by' | 'created_at' | 'updated_by' | 'updated_at'> {
  return {
    case_id: c.caseId,
    date_logged: c.dateLogged,
    time_logged: c.timeLogged,
    staff: c.staff,
    outlet: c.outlet ?? null,
    customer_name: c.customerName ?? null,
    contact: c.contact ?? null,
    case_type: c.caseType,
    brand: c.brand ?? null,
    product_type: c.productType ?? null,
    product: c.product,
    amount_kd: c.amountKD ?? null,
    lost_reason: c.lostReason ?? null,
    follow_up_action: c.followUpAction ?? null,
    promised_callback: c.promisedCallback ?? null,
    last_contact_date: c.lastContactDate ?? null,
    channel: c.channel ?? null,
    browsing_tags: c.browsingTags ?? null,
    status: c.status,
    day_locked: c.dayLocked,
    linked_case_id: c.linkedCaseId ?? null,
    audit_log: c.auditLog,
    deleted: c.deleted ?? false,
  };
}

function settingsFromDb(row: DbSettings): AppSettings {
  return {
    id: row.id,
    staffRoster: row.staff_roster,
    lostReasons: row.lost_reasons,
    followUpActions: row.follow_up_actions,
    channels: row.channels,
    outlets: row.outlets ?? ['Avenues', 'TimeGallery'],
    managerPin: row.manager_pin,
  };
}

// ── Brands ────────────────────────────────────────────────────────────────────

export async function getBrands(): Promise<Brand[]> {
  const [{ data: brandsData }, { data: usageData }] = await Promise.all([
    supabase.from('brands').select('*').order('sort_order', { ascending: true }),
    supabase.from('cases').select('brand').not('brand', 'is', null).eq('deleted', false),
  ]);

  const counts: Record<string, number> = {};
  for (const row of usageData ?? []) {
    if (row.brand) counts[row.brand] = (counts[row.brand] || 0) + 1;
  }

  return ((brandsData ?? []) as DbBrand[])
    .map(b => ({ ...b, usageCount: counts[b.name] || 0 }))
    .sort((a, b) => (b.usageCount! - a.usageCount!) || (a.sort_order - b.sort_order));
}

export async function getAllBrands(): Promise<Brand[]> {
  const { data } = await supabase.from('brands').select('*').order('sort_order', { ascending: true });
  return (data ?? []) as Brand[];
}

export async function addBrand(name: string): Promise<void> {
  await supabase.from('brands').insert({ name });
}

export async function toggleBrand(id: string, is_active: boolean): Promise<void> {
  await supabase.from('brands').update({ is_active, updated_at: new Date().toISOString() }).eq('id', id);
}

export async function renameBrand(id: string, name: string): Promise<void> {
  await supabase.from('brands').update({ name, updated_at: new Date().toISOString() }).eq('id', id);
}

export async function deleteBrand(id: string): Promise<void> {
  await supabase.from('brands').delete().eq('id', id);
}

// ── Settings ──────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<AppSettings> {
  const { data } = await supabase.from('settings').select('*').single();
  if (!data) {
    return {
      staffRoster: STAFF_DEFAULT,
      lostReasons: LOST_REASONS_DEFAULT,
      followUpActions: FOLLOWUP_ACTIONS_DEFAULT,
      channels: CHANNELS_DEFAULT,
      outlets: ['Avenues', 'TimeGallery'],
      managerPin: '1234',
    };
  }
  return settingsFromDb(data as DbSettings);
}

export async function saveSettings(updates: Partial<AppSettings>): Promise<void> {
  const { data: current } = await supabase.from('settings').select('id').single();
  if (!current) return;
  const { data: { user } } = await supabase.auth.getUser();

  const dbUpdates: Partial<DbSettings> & { updated_by?: string | null; updated_at?: string } = {
    updated_by: user?.id ?? null,
    updated_at: new Date().toISOString(),
  };
  if (updates.staffRoster !== undefined) dbUpdates.staff_roster = updates.staffRoster;
  if (updates.lostReasons !== undefined) dbUpdates.lost_reasons = updates.lostReasons;
  if (updates.followUpActions !== undefined) dbUpdates.follow_up_actions = updates.followUpActions;
  if (updates.channels !== undefined) dbUpdates.channels = updates.channels;
  if (updates.outlets !== undefined) (dbUpdates as Record<string, unknown>).outlets = updates.outlets;
  if (updates.managerPin !== undefined) dbUpdates.manager_pin = updates.managerPin;

  await supabase.from('settings').update(dbUpdates).eq('id', current.id);
}

// ── Case ID ───────────────────────────────────────────────────────────────────

export async function nextCaseId(date: string): Promise<string> {
  const prefix = date.replace(/-/g, '');
  const { count } = await supabase
    .from('cases')
    .select('*', { count: 'exact', head: true })
    .eq('date_logged', date);
  const seq = ((count ?? 0) + 1).toString().padStart(3, '0');
  return `${prefix}-${seq}`;
}

// ── Cases ─────────────────────────────────────────────────────────────────────

export async function getTodayCases(): Promise<Case[]> {
  const today = format(new Date(), 'yyyy-MM-dd');
  const { data } = await supabase
    .from('cases')
    .select('*')
    .eq('date_logged', today)
    .eq('deleted', false)
    .order('time_logged', { ascending: true });
  return (data ?? []).map(r => caseFromDb(r as DbCase));
}

export async function getOpenFollowUps(): Promise<Case[]> {
  const { data } = await supabase
    .from('cases')
    .select('*')
    .eq('case_type', 'Follow-up')
    .eq('status', 'Open')
    .eq('deleted', false)
    .order('promised_callback', { ascending: true });
  return (data ?? []).map(r => caseFromDb(r as DbCase));
}

export async function getCasesForRange(from: string, to: string): Promise<Case[]> {
  const { data } = await supabase
    .from('cases')
    .select('*')
    .eq('deleted', false)
    .gte('date_logged', from)
    .lte('date_logged', to)
    .order('date_logged', { ascending: true })
    .order('time_logged', { ascending: true });
  return (data ?? []).map(r => caseFromDb(r as DbCase));
}

export async function countOpenFollowUps(): Promise<number> {
  const { count } = await supabase
    .from('cases')
    .select('*', { count: 'exact', head: true })
    .eq('case_type', 'Follow-up')
    .eq('status', 'Open')
    .eq('deleted', false);
  return count ?? 0;
}

export async function insertCase(c: Omit<Case, 'id'>): Promise<Case> {
  const { data: { user } } = await supabase.auth.getUser();
  const row = {
    ...caseToDb(c),
    created_by: user?.id ?? null,
    updated_by: user?.id ?? null,
  };
  const { data, error } = await supabase.from('cases').insert(row).select().single();
  if (error) throw error;
  return caseFromDb(data as DbCase);
}

export async function updateCase(id: string, updates: Partial<Case>): Promise<void> {
  // If this update includes a soft-delete (deleted=true), use the SECURITY DEFINER
  // RPC so it can bypass the SELECT policy that blocks setting deleted=true directly.
  if (updates.deleted === true) {
    await supabase.rpc('admin_soft_delete_case', {
      p_case_id: id,
      p_audit_log: updates.auditLog ?? [],
    });
    return;
  }

  const { data: { user } } = await supabase.auth.getUser();
  const dbUpdates: Record<string, unknown> = { updated_by: user?.id ?? null };

  if (updates.staff !== undefined) dbUpdates.staff = updates.staff;
  if (updates.outlet !== undefined) dbUpdates.outlet = updates.outlet;
  if (updates.customerName !== undefined) dbUpdates.customer_name = updates.customerName;
  if (updates.contact !== undefined) dbUpdates.contact = updates.contact;
  if (updates.caseType !== undefined) dbUpdates.case_type = updates.caseType;
  if (updates.brand !== undefined) dbUpdates.brand = updates.brand;
  if (updates.productType !== undefined) dbUpdates.product_type = updates.productType;
  if (updates.product !== undefined) dbUpdates.product = updates.product;
  if (updates.amountKD !== undefined) dbUpdates.amount_kd = updates.amountKD;
  if (updates.lostReason !== undefined) dbUpdates.lost_reason = updates.lostReason;
  if (updates.followUpAction !== undefined) dbUpdates.follow_up_action = updates.followUpAction;
  if (updates.promisedCallback !== undefined) dbUpdates.promised_callback = updates.promisedCallback;
  if (updates.lastContactDate !== undefined) dbUpdates.last_contact_date = updates.lastContactDate;
  if (updates.channel !== undefined) dbUpdates.channel = updates.channel;
  if (updates.browsingTags !== undefined) dbUpdates.browsing_tags = updates.browsingTags;
  if (updates.status !== undefined) dbUpdates.status = updates.status;
  if (updates.dayLocked !== undefined) dbUpdates.day_locked = updates.dayLocked;
  if (updates.linkedCaseId !== undefined) dbUpdates.linked_case_id = updates.linkedCaseId;
  if (updates.auditLog !== undefined) dbUpdates.audit_log = updates.auditLog;

  await supabase.from('cases').update(dbUpdates).eq('id', id);
}

// ── Day close ─────────────────────────────────────────────────────────────────

export async function getAllDayCloses(): Promise<DayClose[]> {
  const { data } = await supabase
    .from('day_closes')
    .select('*')
    .order('date', { ascending: false });
  return (data ?? []).map(row => {
    const r = row as DbDayClose;
    return { id: r.id, date: r.date, closedAt: r.closed_at, closedBy: r.closed_by, reportSummary: r.report_summary ?? undefined, autoClosed: r.auto_closed };
  });
}

export async function getCasesByDate(date: string): Promise<Case[]> {
  const { data } = await supabase
    .from('cases')
    .select('*')
    .eq('date_logged', date)
    .eq('deleted', false)
    .order('time_logged', { ascending: true });
  return (data ?? []).map(r => caseFromDb(r as DbCase));
}

export async function getDayClose(date: string): Promise<DayClose | null> {
  const { data } = await supabase.from('day_closes').select('*').eq('date', date).single();
  if (!data) return null;
  const row = data as DbDayClose;
  return { id: row.id, date: row.date, closedAt: row.closed_at, closedBy: row.closed_by, reportSummary: row.report_summary ?? undefined, autoClosed: row.auto_closed };
}

export async function isDayClosed(date: string): Promise<boolean> {
  const { count } = await supabase.from('day_closes').select('*', { count: 'exact', head: true }).eq('date', date);
  return (count ?? 0) > 0;
}

export async function closeDay(date: string, closedBy: string): Promise<string> {
  const { data: rows } = await supabase.from('cases').select('*').eq('date_logged', date).eq('deleted', false);
  const { data: { user } } = await supabase.auth.getUser();

  for (const row of rows ?? []) {
    const upd: Record<string, unknown> = { day_locked: true, updated_by: user?.id ?? null };
    if (row.case_type === 'Sale') upd.status = 'Won';
    else if (row.case_type === 'Lost Sale') upd.status = 'Lost';
    else if (row.case_type === 'No Interaction') upd.status = 'Closed';
    await supabase.from('cases').update(upd).eq('id', row.id);
  }

  const cases = (rows ?? []).map(r => caseFromDb(r as DbCase));
  const sales = cases.filter(c => c.caseType === 'Sale');
  const followups = cases.filter(c => c.caseType === 'Follow-up');
  const lost = cases.filter(c => c.caseType === 'Lost Sale');
  const noInteraction = cases.filter(c => c.caseType === 'No Interaction');
  const revenue = sales.reduce((s, c) => s + (c.amountKD || 0), 0);
  const interactions = sales.length + followups.length + lost.length;
  const convRate = interactions > 0 ? Math.round((sales.length / interactions) * 100) : 0;
  const totalVisitors = cases.length;
  const visitorConv = totalVisitors > 0 ? Math.round((sales.length / totalVisitors) * 100) : 0;

  const { count: openFU } = await supabase
    .from('cases').select('*', { count: 'exact', head: true })
    .eq('case_type', 'Follow-up').eq('status', 'Open').eq('deleted', false);

  const staffSales: Record<string, { count: number; kd: number }> = {};
  for (const c of sales) {
    if (!staffSales[c.staff]) staffSales[c.staff] = { count: 0, kd: 0 };
    staffSales[c.staff].count++;
    staffSales[c.staff].kd += c.amountKD || 0;
  }
  let topStaff = '', topKD = 0;
  for (const [name, d] of Object.entries(staffSales)) {
    if (d.kd > topKD) { topKD = d.kd; topStaff = name; }
  }

  const summary =
    `📊 Daily Report — ${format(new Date(date + 'T12:00:00'), 'd MMM yyyy')}\n` +
    `Total Visitors: ${totalVisitors} | Interactions: ${interactions} | Browsing: ${noInteraction.length}\n` +
    `Total Sales: ${formatKD(revenue)} KD (${sales.length} sale${sales.length !== 1 ? 's' : ''})\n` +
    `Follow-ups: ${followups.length} | Lost: ${lost.length}\n` +
    `Conv. (interactions): ${convRate}% | Conv. (visitors): ${visitorConv}%\n` +
    (topStaff ? `Top: ${topStaff} — ${formatKD(topKD)} KD (${staffSales[topStaff].count} sales)\n` : '') +
    `Open follow-ups outstanding: ${openFU ?? 0}`;

  await supabase.from('day_closes').insert({
    date, closed_at: new Date().toISOString(), closed_by: closedBy,
    report_summary: summary, auto_closed: false, created_by: user?.id ?? null,
  });

  return summary;
}

// Rebuild and persist the stored summary for a closed day (e.g. after manager edits/deletes).
export async function rebuildDaySummary(date: string): Promise<string> {
  const { data: rows } = await supabase.from('cases').select('*').eq('date_logged', date).eq('deleted', false);
  const cases = (rows ?? []).map(r => caseFromDb(r as DbCase));

  const sales = cases.filter(c => c.caseType === 'Sale');
  const followups = cases.filter(c => c.caseType === 'Follow-up');
  const lost = cases.filter(c => c.caseType === 'Lost Sale');
  const noInteraction = cases.filter(c => c.caseType === 'No Interaction');
  const revenue = sales.reduce((s, c) => s + (c.amountKD || 0), 0);
  const interactions = sales.length + followups.length + lost.length;
  const convRate = interactions > 0 ? Math.round((sales.length / interactions) * 100) : 0;
  const totalVisitors = cases.length;
  const visitorConv = totalVisitors > 0 ? Math.round((sales.length / totalVisitors) * 100) : 0;

  const { count: openFU } = await supabase
    .from('cases').select('*', { count: 'exact', head: true })
    .eq('case_type', 'Follow-up').eq('status', 'Open').eq('deleted', false);

  const staffSales: Record<string, { count: number; kd: number }> = {};
  for (const c of sales) {
    if (!staffSales[c.staff]) staffSales[c.staff] = { count: 0, kd: 0 };
    staffSales[c.staff].count++;
    staffSales[c.staff].kd += c.amountKD || 0;
  }
  let topStaff = '', topKD = 0;
  for (const [name, d] of Object.entries(staffSales)) {
    if (d.kd > topKD) { topKD = d.kd; topStaff = name; }
  }

  const summary =
    `📊 Daily Report — ${format(new Date(date + 'T12:00:00'), 'd MMM yyyy')}\n` +
    `Total Visitors: ${totalVisitors} | Interactions: ${interactions} | Browsing: ${noInteraction.length}\n` +
    `Total Sales: ${formatKD(revenue)} KD (${sales.length} sale${sales.length !== 1 ? 's' : ''})\n` +
    `Follow-ups: ${followups.length} | Lost: ${lost.length}\n` +
    `Conv. (interactions): ${convRate}% | Conv. (visitors): ${visitorConv}%\n` +
    (topStaff ? `Top: ${topStaff} — ${formatKD(topKD)} KD (${staffSales[topStaff].count} sales)\n` : '') +
    `Open follow-ups outstanding: ${openFU ?? 0}`;

  await supabase.from('day_closes').update({ report_summary: summary }).eq('date', date);
  return summary;
}

export async function deleteFullDayReport(date: string): Promise<void> {
  // Soft-delete all cases for the date
  const { data: rows } = await supabase.from('cases').select('id').eq('date_logged', date).eq('deleted', false);
  if (rows && rows.length > 0) {
    const ids = rows.map((r: { id: string }) => r.id);
    await supabase.from('cases').update({ deleted: true }).in('id', ids);
  }
  // Remove the day_closes record so it disappears from Reports History
  await supabase.from('day_closes').delete().eq('date', date);
}
