import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { loadStoreDay, type StoreDayData } from '../db/storeToday';
import { storeDay, standings, STANDING_WORD, type TeamStanding } from '../utils/storeDay';
import { sameOutlet } from '../utils/outlet';
import { rangeDayLabel } from '../utils/dateLabel';

const todayKuwait = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuwait' });
const ymdAdd = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const hhmm = (iso: string | null) => (!iso ? '—' : new Date(iso)
  .toLocaleTimeString('en-KW', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kuwait' }));
const hm = (hours: number) => `${Math.floor(hours)}h ${String(Math.round((hours % 1) * 60)).padStart(2, '0')}m`;

const TONE: Record<string, string> = {
  on_floor: 'bg-emerald-100 text-emerald-700', finished: 'bg-slate-100 text-slate-600',
  late: 'bg-amber-100 text-amber-700', leave: 'bg-sky-100 text-sky-700',
  missing: 'bg-rose-100 text-rose-700', due_later: 'bg-slate-100 text-slate-500',
  off: 'bg-slate-50 text-slate-400',
};

/**
 * One shop, one day: when it opened, who worked, and for how long.
 *
 * The same component for today, yesterday and any day back through the records —
 * a separate history page would be the same query and the same rows behind a
 * second door. The arrows move the date; nothing else changes.
 */
export function StoreDayDetail({ outlet, workStart, role, startDate }: {
  outlet: string; workStart: string; role?: string | null; startDate?: string;
}) {
  const today = todayKuwait();
  const [date, setDate] = useState(startDate ?? today);
  const [data, setData] = useState<StoreDayData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await loadStoreDay(outlet, date)); } finally { setLoading(false); }
  }, [outlet, date]);
  useEffect(() => { void load(); }, [load]);

  const shop = useMemo(() => (data ? storeDay(data.shifts, outlet, date) : null), [data, outlet, date]);
  const team = useMemo(() => {
    if (!data) return [] as TeamStanding[];
    const here = data.roster.filter((r) => sameOutlet(r.location, outlet));
    return standings(here, data.shifts, data.onLeave, date, { workStart, graceMinutes: 60 });
  }, [data, outlet, date, workStart]);

  // Nobody needs an empty sheet for a day that has not happened.
  const canGoForward = date < today;
  const worked = team.filter((t) => t.shifts.length);
  const away = team.filter((t) => !t.shifts.length && t.standing !== 'off');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={() => setDate(ymdAdd(date, -1))} aria-label="Previous day"
          className="shrink-0 p-2 rounded-xl border border-slate-200 active:scale-95"><ChevronLeft className="w-4 h-4" /></button>
        <span className="flex-1 min-w-0 truncate text-center font-bold text-slate-900">{rangeDayLabel(date)}</span>
        <button onClick={() => setDate(ymdAdd(date, 1))} disabled={!canGoForward} aria-label="Next day"
          className="shrink-0 p-2 rounded-xl border border-slate-200 disabled:opacity-30 active:scale-95"><ChevronRight className="w-4 h-4" /></button>
        {date !== today && (
          <button onClick={() => setDate(today)} className="shrink-0 px-3 py-2 rounded-xl border border-slate-200 text-xs font-semibold">Today</button>
        )}
      </div>

      {loading && !data ? (
        <div className="h-24 rounded-2xl bg-slate-100 animate-pulse" />
      ) : (
        <>
          <div className="rounded-2xl border border-slate-200 p-4">
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full ${
                shop?.state === 'open' ? 'bg-emerald-500' : shop?.state === 'closed' ? 'bg-slate-400' : 'bg-amber-500'}`} />
              <span className="font-bold text-slate-900">{outlet}</span>
              <span className="text-sm text-slate-500">
                {shop?.state === 'open' ? 'Open now' : shop?.state === 'closed' ? 'Closed' : 'Never opened'}
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 mt-3 text-sm">
              <div><dt className="text-[11px] text-slate-400">Opened</dt>
                <dd className="text-slate-800">{hhmm(shop?.openedAt ?? null)}{shop?.openedBy && <span className="text-slate-400"> · {shop.openedBy}</span>}</dd></div>
              <div><dt className="text-[11px] text-slate-400">Closed</dt>
                <dd className="text-slate-800">{shop?.state === 'open' ? <span className="text-slate-400">still open</span> : hhmm(shop?.closedAt ?? null)}
                  {shop?.closedBy && <span className="text-slate-400"> · {shop.closedBy}</span>}</dd></div>
              <div><dt className="text-[11px] text-slate-400">Worked</dt>
                <dd className="text-slate-800">{hm(shop?.hours ?? 0)}</dd></div>
              <div><dt className="text-[11px] text-slate-400">Day report</dt>
                <dd className="text-slate-800">{data?.dayClosed ? <>Closed{data.closedBy && <span className="text-slate-400"> · {data.closedBy}</span>}</> : <span className="text-amber-700">Not closed</span>}</dd></div>
            </dl>
          </div>

          <div>
            <p className="text-[11px] uppercase tracking-wider font-bold text-slate-400 mb-2">
              Worked ({worked.length})
            </p>
            <div className="space-y-2">
              {worked.map((t) => (
                <div key={t.member.employeeId} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-800 text-sm flex-1 min-w-0 truncate">{t.member.fullName}</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${TONE[t.standing]}`}>{STANDING_WORD[t.standing]}</span>
                    <span className="text-sm font-bold tabular-nums text-slate-700">{hm(t.hoursToday)}</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500 tabular-nums">
                    {t.shifts.map((s, i) => (
                      <span key={i}>{i > 0 && ' · '}{hhmm(s.clockIn)} → {s.clockOut ? hhmm(s.clockOut) : 'still in'}</span>
                    ))}
                  </div>
                </div>
              ))}
              {!worked.length && <p className="text-sm text-slate-400">Nobody clocked in.</p>}
            </div>
          </div>

          {!!away.length && (
            <div>
              <p className="text-[11px] uppercase tracking-wider font-bold text-slate-400 mb-2">Not in ({away.length})</p>
              <div className="space-y-1.5">
                {away.map((t) => (
                  <div key={t.member.employeeId} className="flex items-center gap-2 text-sm">
                    <span className="flex-1 min-w-0 truncate text-slate-600">{t.member.fullName}</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${TONE[t.standing]}`}>
                      {t.standing === 'leave' ? (data?.onLeave(t.member.rosterName, date) ?? 'On leave') : STANDING_WORD[t.standing]}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {role && (
            <p className="text-[11px] text-slate-400">
              Open and close times come from the clock-ins — the first person in opens the shop, the last one out closes it.
            </p>
          )}
        </>
      )}
    </div>
  );
}
