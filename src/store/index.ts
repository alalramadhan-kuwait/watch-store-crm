import { create } from 'zustand';

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface AppStore {
  // Staff auth (persisted in localStorage)
  isStaffAuthed: boolean;
  setStaffAuthed: (v: boolean) => void;

  // Manager auth (session only)
  isManagerAuthed: boolean;
  setManagerAuthed: (v: boolean) => void;

  // Toast notifications
  toasts: Toast[];
  showToast: (message: string, type?: Toast['type']) => void;
  dismissToast: (id: number) => void;

  // Last-used staff (persisted in localStorage)
  lastStaff: string;
  setLastStaff: (staff: string) => void;
}

let toastCounter = 0;

export const useAppStore = create<AppStore>((set, get) => ({
  isStaffAuthed: localStorage.getItem('staffAuthed') === '1',
  setStaffAuthed: (v) => {
    if (v) localStorage.setItem('staffAuthed', '1');
    else localStorage.removeItem('staffAuthed');
    set({ isStaffAuthed: v });
  },

  isManagerAuthed: false,
  setManagerAuthed: (v) => set({ isManagerAuthed: v }),

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
