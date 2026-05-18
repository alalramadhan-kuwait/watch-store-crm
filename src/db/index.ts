import Dexie, { type Table } from 'dexie';
import { format } from 'date-fns';
import type { Case, DayClose, AppSettings } from '../types';
import { formatKD } from '../utils/formatKD';
import {
  STAFF_DEFAULT,
  LOST_REASONS_DEFAULT,
  FOLLOWUP_ACTIONS_DEFAULT,
  CHANNELS_DEFAULT,
} from '../types';

class WatchStoreDB extends Dexie {
  cases!: Table<Case, number>;
  dayCloses!: Table<DayClose, number>;
  settings!: Table<AppSettings, number>;

  constructor() {
    super('WatchStoreCRM');
    this.version(1).stores({
      cases: '++id, caseId, dateLogged, staff, caseType, status, dayLocked, promisedCallback, deleted',
      dayCloses: '++id, &date',
      settings: '++id',
    });
  }
}

export const db = new WatchStoreDB();

// Seed default settings on first run
db.on('ready', async () => {
  const count = await db.settings.count();
  if (count === 0) {
    await db.settings.add({
      staffRoster: STAFF_DEFAULT,
      lostReasons: LOST_REASONS_DEFAULT,
      followUpActions: FOLLOWUP_ACTIONS_DEFAULT,
      channels: CHANNELS_DEFAULT,
      managerPin: '1234',
      staffPin: 'TK2018',
    });
  } else {
    // Migrate existing records that don't have staffPin
    const rec = (await db.settings.toArray())[0];
    if (!rec.staffPin) {
      await db.settings.update(rec.id!, { staffPin: 'TK2018' });
    }
  }
});

export async function getSettings(): Promise<AppSettings> {
  const s = await db.settings.toArray();
  if (s.length === 0) {
    const id = await db.settings.add({
      staffRoster: STAFF_DEFAULT,
      lostReasons: LOST_REASONS_DEFAULT,
      followUpActions: FOLLOWUP_ACTIONS_DEFAULT,
      channels: CHANNELS_DEFAULT,
      managerPin: '1234',
      staffPin: 'TK2018',
    });
    return { id, staffRoster: STAFF_DEFAULT, lostReasons: LOST_REASONS_DEFAULT, followUpActions: FOLLOWUP_ACTIONS_DEFAULT, channels: CHANNELS_DEFAULT, managerPin: '1234', staffPin: 'TK2018' };
  }
  return s[0];
}

export async function saveSettings(updates: Partial<AppSettings>) {
  const s = await db.settings.toArray();
  if (s.length > 0 && s[0].id !== undefined) {
    await db.settings.update(s[0].id, updates);
  }
}

export async function nextCaseId(date: string): Promise<string> {
  // date = YYYY-MM-DD
  const prefix = date.replace(/-/g, '');
  const todayCases = await db.cases.where('dateLogged').equals(date).toArray();
  const seq = (todayCases.length + 1).toString().padStart(3, '0');
  return `${prefix}-${seq}`;
}

export async function getProductSuggestions(): Promise<string[]> {
  const all = await db.cases.toArray();
  const set = new Set<string>();
  for (const c of all) if (c.product) set.add(c.product);
  return [...set].sort();
}

export async function isDayClosed(date: string): Promise<boolean> {
  const rec = await db.dayCloses.where('date').equals(date).first();
  return !!rec;
}

export async function getTodayCases(): Promise<Case[]> {
  const today = format(new Date(), 'yyyy-MM-dd');
  return db.cases
    .where('dateLogged').equals(today)
    .filter(c => !c.deleted)
    .sortBy('timeLogged');
}

export async function getOpenFollowUps(): Promise<Case[]> {
  return db.cases
    .where('caseType').equals('Follow-up')
    .filter(c => !c.deleted && (c.status === 'Open'))
    .sortBy('promisedCallback');
}

export async function closeDay(date: string, closedBy: string): Promise<string> {
  const cases = await db.cases.where('dateLogged').equals(date).filter(c => !c.deleted).toArray();

  // Lock all cases for this day (except follow-ups stay open)
  for (const c of cases) {
    const updates: Partial<Case> = { dayLocked: true };
    if (c.caseType !== 'Follow-up') {
      updates.status = c.caseType === 'Sale' ? 'Won' : 'Lost';
    }
    await db.cases.update(c.id!, updates);
  }

  const now = new Date().toISOString();

  // Calculate summary
  const sales = cases.filter(c => c.caseType === 'Sale');
  const followups = cases.filter(c => c.caseType === 'Follow-up');
  const lost = cases.filter(c => c.caseType === 'Lost Sale');
  const revenue = sales.reduce((sum, c) => sum + (c.amountKD || 0), 0);
  const total = sales.length + lost.length;
  const convRate = total > 0 ? Math.round((sales.length / total) * 100) : 0;

  const openFollowUps = await db.cases
    .where('caseType').equals('Follow-up')
    .filter(c => !c.deleted && c.status === 'Open')
    .count();

  // Per-staff top performer
  const staffSales: Record<string, { count: number; kd: number }> = {};
  for (const c of sales) {
    if (!staffSales[c.staff]) staffSales[c.staff] = { count: 0, kd: 0 };
    staffSales[c.staff].count++;
    staffSales[c.staff].kd += c.amountKD || 0;
  }
  let topStaff = '';
  let topKD = 0;
  for (const [name, data] of Object.entries(staffSales)) {
    if (data.kd > topKD) { topKD = data.kd; topStaff = name; }
  }

  const summary =
    `📊 Daily Report — ${format(new Date(date + 'T12:00:00'), 'd MMM yyyy')}\n` +
    `Total Sales: ${formatKD(revenue)} KD (${sales.length} sale${sales.length !== 1 ? 's' : ''})\n` +
    `Follow-ups: ${followups.length} | Lost: ${lost.length}\n` +
    `Conversion: ${convRate}%\n` +
    (topStaff ? `Top: ${topStaff} — ${formatKD(topKD)} KD (${staffSales[topStaff].count} sales)\n` : '') +
    `Open follow-ups outstanding: ${openFollowUps}`;

  await db.dayCloses.add({ date, closedAt: now, closedBy, reportSummary: summary, autoClosed: false });

  return summary;
}

export async function getCasesForRange(from: string, to: string): Promise<Case[]> {
  return db.cases
    .filter(c => !c.deleted && c.dateLogged >= from && c.dateLogged <= to)
    .toArray();
}
