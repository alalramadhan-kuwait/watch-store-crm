import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

export function Modal({ open, onClose, title, children, footer, size = 'md' }: ModalProps) {
  useEffect(() => {
    if (open) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  if (!open) return null;

  const widths = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl' };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end sm:items-center justify-center px-4 pb-4 sm:pb-0"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" />
      <div
        className={`relative bg-white rounded-3xl shadow-2xl w-full ${widths[size]} max-h-[90vh] flex flex-col overflow-hidden`}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100">
          <h2 className="text-lg font-bold text-slate-900">{title}</h2>
          <button onClick={onClose} className="p-2 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="px-6 pb-6 pt-4 border-t border-slate-100 flex gap-3 justify-end">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function ConfirmModal({
  open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', danger = false, loading = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <button onClick={onClose} className="btn-ghost" disabled={loading}>Cancel</button>
          <button
            onClick={onConfirm}
            className={danger ? 'btn-danger' : 'btn-primary'}
            disabled={loading}
          >
            {loading ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-slate-600">{message}</p>
    </Modal>
  );
}
