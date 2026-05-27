import type { CaseType, CaseStatus } from '../../types';

export function CaseTypeBadge({ type }: { type: CaseType }) {
  const styles: Record<CaseType, string> = {
    'Sale': 'bg-emerald-100 text-emerald-800',
    'Follow-up': 'bg-amber-100 text-amber-800',
    'Lost Sale': 'bg-rose-100 text-rose-800',
    'No Interaction': 'bg-slate-100 text-slate-600',
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${styles[type]}`}>
      {type}
    </span>
  );
}

export function StatusBadge({ status }: { status: CaseStatus }) {
  const styles: Record<CaseStatus, string> = {
    'Open': 'bg-blue-100 text-blue-700',
    'Won': 'bg-emerald-100 text-emerald-700',
    'Lost': 'bg-rose-100 text-rose-700',
    'No Response': 'bg-slate-100 text-slate-600',
    'Closed': 'bg-slate-100 text-slate-500',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${styles[status]}`}>
      {status}
    </span>
  );
}

export function DayStatusBadge({ closed, closedAt }: { closed: boolean; closedAt?: string }) {
  if (closed) {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-100 text-slate-600 text-xs font-semibold">
        <span className="w-2 h-2 rounded-full bg-slate-400 inline-block" />
        Closed {closedAt ? `at ${closedAt}` : ''}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-100 text-emerald-700 text-xs font-semibold">
      <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse inline-block" />
      Day Open
    </span>
  );
}
