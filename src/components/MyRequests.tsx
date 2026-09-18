/**
 * What an employee can see and do about their own requests.
 *
 * Until now: nothing. They could raise one and then watch it. There was no
 * UPDATE policy on their own row, so a request sent by mistake — the 17
 * September one that asked for the times already recorded — could only be
 * cleared by a manager, and the employee had no way to say "ignore that, I meant
 * the other end of the day".
 *
 * Two rules, both enforced by the database rather than by this screen:
 * while it is still Pending they may edit or withdraw; once a manager has acted
 * it locks, and a further correction is a new request. Nothing is ever deleted —
 * the record of having asked is worth keeping, and a withdrawn request explains
 * a gap that a deleted one leaves mysterious.
 */
import { useCallback, useEffect, useState } from 'react';
import { Pencil, Undo2, Check, X } from 'lucide-react';
import {
  loadRequests, withdraw, editRequest, fieldChanges, standingLine, whenShort,
  type RequestRow,
} from '../shared/requests';

const kuwaitDay = (d: string | null) => (!d ? '' : new Date(`${d}T12:00:00+03:00`)
  .toLocaleDateString('en-GB', { timeZone: 'Asia/Kuwait', day: '2-digit', month: 'short' }));

const STATUS_TONE: Record<string, string> = {
  Pending: 'bg-amber-100 text-amber-700 border-amber-200',
  Approved: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  Rejected: 'bg-rose-100 text-rose-700 border-rose-200',
  Withdrawn: 'bg-slate-100 text-slate-500 border-slate-200',
  Cancelled: 'bg-slate-100 text-slate-500 border-slate-200',
};

export default function MyRequests({ userId }: { userId: string | null }) {
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const load = useCallback(async () => {
    if (!userId) { setRows([]); return; }
    setRows(await loadRequests({ employeeUserId: userId }));
  }, [userId]);
  useEffect(() => { void load(); }, [load]);

  async function take(r: RequestRow) {
    setBusy(r.id); setErr(null);
    const message = await withdraw(r);
    if (message) setErr(message);
    await load(); setBusy(null);
  }

  async function saveReason(r: RequestRow) {
    setBusy(r.id); setErr(null);
    const message = await editRequest(r, { details: draft.trim() });
    if (message) setErr(message);
    setEditing(null);
    await load(); setBusy(null);
  }

  if (!rows) return null;

  return (
    <section className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100">
        <h2 className="font-semibold text-slate-800">My requests</h2>
      </div>

      {err && (
        <p className="m-3 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">{err}</p>
      )}

      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-slate-400">You have not asked for anything yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((r) => {
            /* Pending means nobody has looked at it. The moment a manager
               decides, this closes — the database refuses the write either way,
               so this only spares somebody typing into a dead box. */
            const open = r.status === 'Pending' && r.manager_status !== 'Approved';
            const changes = fieldChanges(r);
            return (
              <li key={r.id} className="px-4 py-3.5">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-800">
                      {r.kind}
                      {r.attendance_date && <span className="text-slate-400 font-normal"> · {kuwaitDay(r.attendance_date)}</span>}
                      {r.kind === 'Leave' && r.proposed_from && <span className="text-slate-400 font-normal"> · {kuwaitDay(r.proposed_from)}</span>}
                    </p>
                    <p className="text-xs text-slate-400">Sent {whenShort(r.submitted_at)}</p>
                  </div>
                  <span className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded border ${STATUS_TONE[r.status] ?? STATUS_TONE.Pending}`}>
                    {r.status}
                  </span>
                </div>

                {changes.length > 0 && (
                  <div className="mt-2 text-sm text-slate-600">
                    {changes.filter((c) => !c.same).map((c) => (
                      <div key={c.field} className="flex gap-2">
                        <span className="text-slate-400 w-20 shrink-0">{c.field}</span>
                        <span className="tabular-nums">{c.current} → <b className="text-slate-900">{c.requested}</b></span>
                      </div>
                    ))}
                  </div>
                )}

                {editing === r.id ? (
                  <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                    <input
                      id={`reason-${r.id}`} value={draft} onChange={(e) => setDraft(e.target.value)}
                      placeholder="Why you are asking"
                      className="flex-1 min-w-[10rem] text-sm border border-slate-200 rounded-xl px-2.5 py-2
                                 focus:outline-none focus:ring-2 focus:ring-brand-200" />
                    <button type="button" disabled={busy === r.id} onClick={() => saveReason(r)}
                      className="inline-flex items-center gap-1 text-sm px-3 py-2 rounded-xl
                                 bg-slate-800 text-white active:bg-slate-900 disabled:opacity-50">
                      <Check className="w-4 h-4" /> Save
                    </button>
                    <button type="button" onClick={() => setEditing(null)}
                      className="inline-flex items-center gap-1 text-sm px-3 py-2 rounded-xl touch-manipulation text-slate-500 active:bg-slate-50">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="mt-2 text-sm text-slate-600">
                      <span className="text-slate-400">Reason: </span>
                      {r.reason?.trim() ? r.reason : <span className="italic text-slate-400">none given</span>}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">{standingLine(r, 'owner')}</p>
                  </>
                )}

                {r.manager_remarks && (
                  <p className="mt-1.5 text-sm text-slate-600">
                    <span className="text-slate-400">Reply: </span>{r.manager_remarks}
                  </p>
                )}

                {open && editing !== r.id && (
                  <div className="mt-2.5 flex items-center gap-2">
                    <button type="button"
                      onClick={() => { setEditing(r.id); setDraft(r.reason ?? ''); }}
                      className="inline-flex items-center gap-1 text-sm px-3 py-2 rounded-xl touch-manipulation
                                 border border-slate-200 text-slate-600 active:bg-slate-50">
                      <Pencil className="w-3.5 h-3.5" /> Edit
                    </button>
                    <button type="button" disabled={busy === r.id} onClick={() => take(r)}
                      className="inline-flex items-center gap-1 text-sm px-3 py-2 rounded-xl touch-manipulation
                                 border border-slate-200 text-slate-600 active:bg-slate-50 disabled:opacity-50">
                      <Undo2 className="w-3.5 h-3.5" /> Withdraw
                    </button>
                  </div>
                )}
                {!open && r.status === 'Pending' && (
                  <p className="mt-2 text-xs text-slate-400">
                    Your manager has approved this, so it can no longer be changed. Ask again if something else needs correcting.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
