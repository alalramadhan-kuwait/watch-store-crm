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

  lastStaff: string;
  setLastStaff: (staff: string) => void;

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

  lastStaff: localStorage.getItem('lastStaff') || '',
  setLastStaff: (staff) => {
    localStorage.setItem('lastStaff', staff);
    set({ lastStaff: staff });
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
