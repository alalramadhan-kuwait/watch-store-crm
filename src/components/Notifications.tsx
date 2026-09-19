/**
 * The shop floor's notification centre — the first one it has ever had.
 *
 * The database has been raising notifications for months: a request arriving, a
 * leave decision, an account change. The back office read them; this app did
 * not subscribe at all, so the person who most needed to act on a request — the
 * store manager, holding this phone — found out when somebody told him.
 *
 * The feed itself comes from src/shared/notifications, the same reader the back
 * office uses. What is app-specific is only where a tap lands: a notification is
 * written with the back office's routing, because the trigger that wrote it
 * cannot know which app will open it, so it is translated here.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { loadMyNotifications, markRead, routeFor, type FeedNotif } from '../shared/notifications';

/**
 * Back-office destinations, translated to this app's.
 *
 * A request notification points an owner at the Inbox; here the same request
 * lives under Team. Anything not listed is shown but not clickable, which is
 * honest — better than a tap that lands on a blank screen.
 */
const WHERE: Record<string, string> = {
  '/inbox': '/team',
  '/me': '/portal',
  '/attendance': '/team',
  '/leave': '/team',
  '/team': '/team',
};

const ago = (iso: string) => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return new Date(iso).toLocaleDateString('en-GB',
    { timeZone: 'Asia/Kuwait', day: '2-digit', month: 'short' });
};

export function Notifications() {
  const { user, role } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState<FeedNotif[] | null>(null);

  const load = useCallback(async () => {
    if (!user) { setRows([]); return; }
    setRows(await loadMyNotifications(user.id, role, { shopFloorOnly: true }));
  }, [user, role]);

  useEffect(() => { void load(); }, [load]);

  const unread = (rows ?? []).filter((n) => !n.read);

  async function open(n: FeedNotif) {
    if (user && !n.read) {
      await markRead(user.id, [n.id]);
      setRows((s) => (s ?? []).map((r) => (r.id === n.id ? { ...r, read: true } : r)));
    }
    const to = routeFor(n.url, WHERE);
    if (to) navigate(to);
  }

  async function readAll() {
    if (!user || unread.length === 0) return;
    await markRead(user.id, unread.map((n) => n.id));
    setRows((s) => (s ?? []).map((r) => ({ ...r, read: true })));
  }

  return (
    <div className="p-4 pb-28 space-y-4 max-w-2xl mx-auto">
      <div className="flex items-center gap-2">
        <Bell className="w-5 h-5 text-slate-400" />
        <h1 className="text-lg font-bold text-slate-900">Notifications</h1>
        {unread.length > 0 && (
          <button type="button" onClick={readAll}
            className="ml-auto inline-flex items-center gap-1.5 text-xs font-semibold
                       text-slate-500 px-2.5 py-1.5 rounded-xl active:bg-slate-100 touch-manipulation">
            <CheckCheck className="w-3.5 h-3.5" /> Mark all read
          </button>
        )}
      </div>

      {rows === null ? (
        <p className="py-10 text-center text-sm text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-400">Nothing yet.</p>
      ) : (
        <ul className="bg-white rounded-2xl border border-slate-100 divide-y divide-slate-100 overflow-hidden">
          {rows.map((n) => {
            const clickable = !!routeFor(n.url, WHERE);
            return (
              <li key={n.id}>
                <button
                  type="button" onClick={() => open(n)} disabled={!clickable && n.read}
                  className={`w-full text-left px-4 py-3 touch-manipulation
                              ${clickable ? 'active:bg-slate-50' : ''}
                              ${n.read ? '' : 'bg-brand-50/40'}`}>
                  <div className="flex items-start gap-2.5">
                    {!n.read && <span className="mt-1.5 w-2 h-2 rounded-full bg-brand-600 shrink-0" />}
                    <div className={`min-w-0 ${n.read ? 'pl-[18px]' : ''}`}>
                      <p className={`text-sm ${n.read ? 'text-slate-600' : 'font-semibold text-slate-900'}`}>
                        {n.title}
                      </p>
                      <p className="text-sm text-slate-500">{n.body}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{ago(n.created_at)}</p>
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
