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

  // Last-used staff name (persisted in localStorage for quick re-selection)
  lastStaff: string;
  setLastStaff: (staff: string) => void;
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
}));
