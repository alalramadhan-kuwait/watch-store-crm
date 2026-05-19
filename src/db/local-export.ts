/**
 * One-time local data export from IndexedDB (Dexie).
 * Use the exportLocalData() function to download all local data as JSON
 * before the app fully migrates to Supabase.
 */
import Dexie, { type Table } from 'dexie';
import type { Case, DayClose, AppSettings } from '../types';

class LocalDB extends Dexie {
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

export async function exportLocalData(): Promise<void> {
  try {
    const localDb = new LocalDB();
    const [cases, dayCloses, settings] = await Promise.all([
      localDb.cases.toArray(),
      localDb.dayCloses.toArray(),
      localDb.settings.toArray(),
    ]);
    await localDb.close();

    const payload = { exportedAt: new Date().toISOString(), cases, dayCloses, settings };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `timekeeper-local-export-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    // If Dexie isn't available or DB is empty, nothing to export
    alert('No local data found to export.');
  }
}
