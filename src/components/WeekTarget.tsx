import { type TargetState, type WeekProgress, neededPerDay } from '../shared/weeklyTarget';

const WORD: Record<TargetState, string> = {
  done: 'Target reached', ahead: 'Ahead of the week', on_track: 'On track', behind: 'Behind', none: 'No target set',
};
const TONE: Record<TargetState, string> = {
  done: 'text-emerald-700', ahead: 'text-emerald-700', on_track: 'text-slate-600', behind: 'text-rose-600', none: 'text-slate-400',
};
const BAR: Record<TargetState, string> = {
  done: 'bg-emerald-500', ahead: 'bg-emerald-500', on_track: 'bg-slate-500', behind: 'bg-rose-500', none: 'bg-slate-300',
};

/**
 * Customers messaged on WhatsApp this week against the weekly target, with a mark
 * for where the week itself has got to: a bar short of the mark is behind, a bar
 * past it is ahead. `compact` is the one-line version for the Team list.
 */
export function WeekBar({ customers, target, messages, state, week, compact }: {
  customers: number; target: number | null; messages: number; state: TargetState; week: WeekProgress; compact?: boolean;
}) {
  const pct = target ? Math.min(100, (customers / target) * 100) : 0;
  const need = neededPerDay(customers, target, week);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className={`${compact ? 'text-sm' : 'text-2xl'} font-bold text-slate-900 tabular-nums`}>
          {customers}{target ? <span className="text-slate-400 font-semibold"> of {target} customers</span> : <span className="text-slate-400 font-semibold"> {customers === 1 ? 'customer' : 'customers'}</span>}
        </p>
        <span className={`text-xs font-semibold ${TONE[state]}`}>{WORD[state]}</span>
      </div>
      <div className="relative h-2 rounded-full bg-slate-200 mt-2">
        <div className={`absolute inset-y-0 left-0 rounded-full ${BAR[state]}`} style={{ width: `${pct}%` }} />
        {target ? <div className="absolute -top-[3px] -bottom-[3px] w-0.5 rounded bg-slate-800" style={{ left: `${week.fraction * 100}%` }} aria-hidden /> : null}
      </div>
      <p className="mt-1.5 text-[11px] text-slate-400">
        {messages} {messages === 1 ? 'message' : 'messages'} opened
        {need !== null && <> · {need} a day to finish</>}
        {target && !compact ? <> · the mark is where the week is today</> : null}
      </p>
    </div>
  );
}
