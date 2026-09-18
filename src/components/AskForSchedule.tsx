/**
 * Asking for different working hours.
 *
 * There was no way to. Schedules moved only through `set_schedule()`, which HR,
 * a manager or an owner may call and nobody else — so an employee who wanted a
 * different shift had to find somebody at a desk and hope it got typed in.
 *
 * Avenues is the case that needs it: the manager assigns mornings and nights by
 * the day, so people's hours genuinely change, and "hours vary" is recorded
 * precisely because no fixed pair is true. Asking for a stretch of fixed hours —
 * a week of evenings to cover somebody — is now a request like any other, and
 * goes through the same two stages as everything else.
 */
import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { askForSchedule } from '../shared/requests';
import { todayKuwait } from '../shared/portalRules';

export default function AskForSchedule({ employeeId, userId, onSent }: {
  employeeId: string | null; userId: string | null; onSent: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(todayKuwait());
  const [until, setUntil] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!employeeId || !userId) return null;

  async function send() {
    setBusy(true); setErr(null);
    const problem = await askForSchedule({
      employeeId: employeeId as string, userId: userId as string,
      from, until: until || null, shiftStart: start || null, shiftEnd: end || null, reason,
    });
    setBusy(false);
    if (problem) { setErr(problem); return; }
    setOpen(false); setReason(''); setStart(''); setEnd(''); setUntil('');
    onSent();
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-xl
                   border border-slate-200 text-slate-600 active:bg-slate-50">
        <CalendarClock className="w-4 h-4" /> Ask for different hours
      </button>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-4 space-y-3">
      <h3 className="font-semibold text-slate-800">Ask for different hours</h3>

      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">
          <span className="block text-slate-500 mb-1">From</span>
          <input id="sch-from" type="date" value={from} min={todayKuwait()}
            onChange={(e) => setFrom(e.target.value)}
            className="w-full border border-slate-200 rounded-xl px-2.5 py-2" />
        </label>
        <label className="text-sm">
          <span className="block text-slate-500 mb-1">Until <span className="text-slate-400">(optional)</span></span>
          <input id="sch-until" type="date" value={until} min={from}
            onChange={(e) => setUntil(e.target.value)}
            className="w-full border border-slate-200 rounded-xl px-2.5 py-2" />
        </label>
        <label className="text-sm">
          <span className="block text-slate-500 mb-1">Shift starts</span>
          <input id="sch-start" type="time" value={start}
            onChange={(e) => setStart(e.target.value)}
            className="w-full border border-slate-200 rounded-xl px-2.5 py-2" />
        </label>
        <label className="text-sm">
          <span className="block text-slate-500 mb-1">Shift ends</span>
          <input id="sch-end" type="time" value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="w-full border border-slate-200 rounded-xl px-2.5 py-2" />
        </label>
      </div>

      {/* Leaving both times empty is a real request, not an unfinished form. */}
      <p className="text-xs text-slate-500">
        {start || end
          ? 'Leave both times empty instead to ask for hours that vary.'
          : 'With no times, this asks for hours that vary — no fixed shift to be late against.'}
      </p>

      <label className="block text-sm">
        <span className="block text-slate-500 mb-1">Why</span>
        <input id="sch-why" value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Evening shift coverage while Ranin is away"
          className="w-full border border-slate-200 rounded-xl px-2.5 py-2" />
      </label>

      {err && <p className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">{err}</p>}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)}
          className="text-sm px-3 py-2 rounded-xl text-slate-600 active:bg-slate-50">Cancel</button>
        <button type="button" disabled={busy || !reason.trim()} onClick={send}
          className="text-sm font-medium px-3 py-2 rounded-xl bg-slate-800 text-white
                     active:bg-slate-900 disabled:opacity-40">
          Send to {'my manager'}
        </button>
      </div>
    </div>
  );
}
