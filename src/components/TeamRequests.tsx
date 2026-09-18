/**
 * The store manager's approval queue, on the phone he actually carries.
 *
 * Until now his authority existed only in a back-office app on a laptop: he was
 * scoped in the database to both shops and could not see a single request. Every
 * approval waited for somebody to open a different application.
 *
 * What a request means — which stage it is at, who it is waiting on, whether it
 * changes anything — is not decided here. It comes from src/shared/requests,
 * which reads v_requests, which the database computes. This screen and the
 * owner's Inbox render the same answers differently because a phone on a shop
 * floor and a laptop at a desk are different places, not different rules.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, X, AlertTriangle, Clock, Inbox } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  loadRequests, decide, tabOf, stageOf, standingLine, waitedFor, fieldChanges,
  type RequestRow, type MyStage,
} from '../shared/requests';

const kuwaitDay = (d: string | null) => (!d ? '' : new Date(`${d}T12:00:00+03:00`)
  .toLocaleDateString('en-GB', { timeZone: 'Asia/Kuwait', day: '2-digit', month: 'short' }));

type Pane = 'pending' | 'done';

export function TeamRequests() {
  const { role } = useAuth();
  const mine: MyStage = stageOf(role);
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [pane, setPane] = useState<Pane>('pending');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [remarks, setRemarks] = useState<Record<string, string>>({});

  async function reload() { setRows(await loadRequests()); }
  useEffect(() => { reload(); }, []);

  /* Two panes here rather than the owner's three. He does not need "waiting on
     manager" as a category — he IS the manager. What he needs is everything
     still open, with his own first, and everything finished. */
  const { pending, done, mineCount } = useMemo(() => {
    const all = rows ?? [];
    const open = all.filter((r) => r.stage_owner !== 'nobody');
    const needsHim = open.filter((r) => tabOf(r, mine) === 'action');
    return {
      pending: [...needsHim, ...open.filter((r) => tabOf(r, mine) !== 'action')],
      done: all.filter((r) => r.stage_owner === 'nobody'),
      mineCount: needsHim.length,
    };
  }, [rows, mine]);

  async function act(r: RequestRow, verdict: 'Approved' | 'Rejected') {
    setBusy(r.id); setErr(null);
    const message = await decide(r, verdict, { stage: mine, remarks: remarks[r.id] });
    if (message) { setErr(message); setBusy(null); return; }
    await reload(); setBusy(null);
  }

  const shown = pane === 'pending' ? pending : done;

  return (
    <section className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
        <Inbox className="w-4 h-4 text-slate-400" />
        <h2 className="font-semibold text-slate-800">Requests</h2>
        {mineCount > 0 && (
          <span className="ml-auto text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
            {mineCount} need you
          </span>
        )}
      </div>

      <div className="flex gap-1 px-3 pb-2 border-b border-slate-100">
        {(['pending', 'done'] as Pane[]).map((p) => (
          <button key={p} type="button" onClick={() => setPane(p)}
            className={`px-3 py-1.5 rounded-xl text-sm font-semibold transition-colors
              ${pane === p ? 'bg-brand-50 text-brand-700' : 'text-slate-400 hover:text-slate-600'}`}>
            {p === 'pending' ? 'Pending' : 'Completed'}
            {p === 'pending' && pending.length > 0 && (
              <span className="ml-1.5 text-xs tabular-nums opacity-70">{pending.length}</span>
            )}
          </button>
        ))}
      </div>

      {err && (
        <p className="m-3 text-sm text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">{err}</p>
      )}

      {rows === null ? (
        <p className="px-4 py-8 text-center text-sm text-slate-400">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-slate-400">
          {pane === 'pending' ? 'Nothing waiting.' : 'Nothing settled yet.'}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {shown.map((r) => (
            <RequestItem
              key={r.id} r={r} mine={mine} busy={busy === r.id}
              remark={remarks[r.id] ?? ''}
              onRemark={(v) => setRemarks((s) => ({ ...s, [r.id]: v }))}
              onDecide={(v) => act(r, v)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function RequestItem({ r, mine, busy, remark, onRemark, onDecide }: {
  r: RequestRow; mine: MyStage; busy: boolean; remark: string;
  onRemark: (v: string) => void; onDecide: (v: 'Approved' | 'Rejected') => void;
}) {
  const changes = fieldChanges(r);
  const isMine = r.stage_owner === mine;

  return (
    <li className="px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-slate-800 truncate">{r.employee_name ?? 'Someone'}</p>
          <p className="text-sm text-slate-500">
            {r.kind}
            {r.attendance_date && <> · {kuwaitDay(r.attendance_date)}</>}
            {r.kind === 'Leave' && r.proposed_from && <> · {kuwaitDay(r.proposed_from)}</>}
          </p>
        </div>
        {r.stage_owner !== 'nobody' && (
          <span className={`shrink-0 text-[11px] tabular-nums px-2 py-0.5 rounded-full
            ${r.is_overdue ? 'bg-rose-100 text-rose-700 font-semibold' : 'bg-slate-100 text-slate-500'}`}>
            <Clock className="w-3 h-3 inline -mt-0.5 mr-0.5" />{waitedFor(r.hours_pending)}
          </span>
        )}
      </div>

      {!isMine && (
        <p className="mt-1 text-xs text-slate-400">{standingLine(r, mine)}</p>
      )}
      {r.on_behalf_name && (
        <p className="mt-1 text-xs text-slate-400">Filed by {r.on_behalf_name} on their behalf.</p>
      )}

      {changes.length > 0 && (
        <div className="mt-2.5 rounded-xl bg-slate-50 px-3 py-2">
          {changes.map((c) => (
            <div key={c.field} className="flex items-baseline gap-2 text-sm py-0.5">
              <span className="text-slate-500 w-20 shrink-0">{c.field}</span>
              <span className="text-slate-500 tabular-nums">{c.current}</span>
              <span className="text-slate-300">→</span>
              <span className={c.same ? 'text-slate-400' : 'font-semibold text-slate-900 tabular-nums'}>
                {c.requested}
              </span>
            </div>
          ))}
        </div>
      )}

      {r.current_shifts > 1 && (
        <p className="mt-1.5 text-xs text-slate-400">
          {r.current_shifts} shifts that day — first in, last out.
        </p>
      )}

      <p className="mt-2 text-sm text-slate-600">
        <span className="text-slate-400">Reason: </span>
        {r.reason?.trim() ? r.reason : <span className="italic text-slate-400">none given</span>}
      </p>

      {r.changes_nothing && (
        <p className="mt-2 text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2 flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>This asks for the times already recorded, so approving changes nothing.</span>
        </p>
      )}

      {isMine && (
        <div className="mt-3 space-y-2">
          <input
            id={`dsr-remark-${r.id}`} value={remark} onChange={(e) => onRemark(e.target.value)}
            placeholder="Remarks (optional)"
            className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2
                       focus:outline-none focus:ring-2 focus:ring-brand-200" />
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => onDecide('Approved')}
              className="flex-1 inline-flex items-center justify-center gap-1.5 font-semibold text-sm
                         py-2.5 rounded-xl bg-emerald-600 text-white active:bg-emerald-700
                         disabled:opacity-50 touch-manipulation">
              <Check className="w-4 h-4" /> Approve
            </button>
            <button type="button" disabled={busy} onClick={() => onDecide('Rejected')}
              className="flex-1 inline-flex items-center justify-center gap-1.5 font-semibold text-sm
                         py-2.5 rounded-xl border border-slate-200 text-slate-600 active:bg-slate-50
                         disabled:opacity-50 touch-manipulation">
              <X className="w-4 h-4" /> Reject
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
