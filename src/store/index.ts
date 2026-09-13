import { create } from 'zustand';

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface AppStore {
  toasts: Toast[];
  showToast: (message: string, type?: Toast['type']) => void;
  dismissToast: (id: number) => void;

  // Last staff picked in Quick Entry, remembered per login (the shared
  // account is used from one phone by several people, so it must not leak
  // from one login to the next on the same device).
  lastStaff: string;
  lastStaffKey: string | null;
  setLastStaff: (staff: string) => void;
  hydrateForUser: (userId: string) => void;
  clearSessionState: () => void;

  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;

  refreshLog: number;
  bumpRefreshLog: () => void;

  // Active outlet for the current session (set at login for staff; null = not yet chosen)
  activeOutlet: string | null;
  setActiveOutlet: (outlet: string | null) => void;
}

let toastCounter = 0;

export const useAppStore = create<AppStore>((set, get) => ({
  toasts: [],
  showToast: (message, type = 'success') => {
    const id = ++toastCounter;
    set(s => ({ toasts: [...s.toasts, { id, message, type }] }));
    setTimeout(() => get().dismissToast(id), 3000);
  },
  dismissToast: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),

  lastStaff: '',
  lastStaffKey: null,
  setLastStaff: (staff) => {
    const key = get().lastStaffKey;
    if (key) localStorage.setItem(key, staff);
    set({ lastStaff: staff });
  },
  hydrateForUser: (userId) => {
    const key = `lastStaff:${userId}`;
    let value = localStorage.getItem(key);
    if (value === null) {
      // one-time carry-over from the device-wide key this used to be
      const legacy = localStorage.getItem('lastStaff');
      if (legacy) { value = legacy; localStorage.setItem(key, legacy); }
      localStorage.removeItem('lastStaff');
    }
    set({ lastStaff: value || '', lastStaffKey: key });
  },
  clearSessionState: () => {
    sessionStorage.removeItem('activeOutlet');
    set({ activeOutlet: null, lastStaff: '', lastStaffKey: null });
  },

  sidebarCollapsed: localStorage.getItem('sidebarCollapsed') === 'true',
  setSidebarCollapsed: (v) => {
    localStorage.setItem('sidebarCollapsed', String(v));
    set({ sidebarCollapsed: v });
  },

  refreshLog: 0,
  bumpRefreshLog: () => set(s => ({ refreshLog: s.refreshLog + 1 })),

  activeOutlet: sessionStorage.getItem('activeOutlet') || null,
  setActiveOutlet: (outlet) => {
    if (outlet) sessionStorage.setItem('activeOutlet', outlet);
    else sessionStorage.removeItem('activeOutlet');
    set({ activeOutlet: outlet });
  },
}));
