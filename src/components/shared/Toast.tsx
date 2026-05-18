import { useEffect } from 'react';
import { CheckCircle, XCircle, Info, X } from 'lucide-react';
import { useAppStore } from '../../store';

export function ToastContainer() {
  const { toasts, dismissToast } = useAppStore();

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 pointer-events-none w-full max-w-sm px-4">
      {toasts.map(t => (
        <Toast key={t.id} {...t} onDismiss={() => dismissToast(t.id)} />
      ))}
    </div>
  );
}

function Toast({ message, type, onDismiss }: { message: string; type: string; onDismiss: () => void }) {
  useEffect(() => {
    // Auto-dismiss handled in store, but allow manual too
  }, []);

  const icons = {
    success: <CheckCircle className="w-5 h-5 text-emerald-500 shrink-0" />,
    error: <XCircle className="w-5 h-5 text-rose-500 shrink-0" />,
    info: <Info className="w-5 h-5 text-blue-500 shrink-0" />,
  };
  const borders = { success: 'border-emerald-200', error: 'border-rose-200', info: 'border-blue-200' };

  return (
    <div
      className={`pointer-events-auto flex items-center gap-3 bg-white rounded-2xl px-4 py-3.5 shadow-lg border ${borders[type as keyof typeof borders]} animate-in slide-in-from-top-2 duration-200`}
      style={{ animation: 'toastIn 0.2s ease-out' }}
    >
      {icons[type as keyof typeof icons]}
      <span className="text-sm font-medium text-slate-800 flex-1">{message}</span>
      <button onClick={onDismiss} className="text-slate-400 hover:text-slate-600 ml-1">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
