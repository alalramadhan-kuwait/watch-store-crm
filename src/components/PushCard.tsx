import { useEffect, useState } from 'react';
import { Bell, BellRing, Check, Share } from 'lucide-react';
import { enablePush, pushState, type PushState } from '../lib/push';
import { useAppStore } from '../store';

/**
 * "Get alerts on this phone". Shown to a person's own login only: the shared shop phone has
 * nobody to alert. Says what to do in the three situations that stop people — iPhone not yet
 * on the home screen, alerts refused once, and the plain case — instead of one button that
 * quietly fails.
 */
export function PushCard({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const showToast = useAppStore(s => s.showToast);

  useEffect(() => { void pushState().then(setState); }, []);
  if (!state || state === 'unsupported') return null;
  if (state === 'on') {
    return compact ? null : (
      <div className="card p-4 flex items-center gap-3">
        <span className="w-9 h-9 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0"><Check className="w-5 h-5" /></span>
        <div><p className="font-semibold text-slate-900 text-sm">Alerts are on</p><p className="text-xs text-slate-500">This phone will buzz for requests, reminders and birthdays.</p></div>
      </div>
    );
  }

  async function turnOn() {
    setBusy(true); setError('');
    try {
      const r = await enablePush();
      if (r.ok) { setState('on'); showToast('Alerts are on', 'success'); }
      else { setError(r.error ?? 'Could not turn alerts on.'); setState(await pushState()); }
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not turn alerts on.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="card p-4 space-y-3 border-brand-100">
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 rounded-xl bg-brand-50 text-brand-700 flex items-center justify-center shrink-0"><BellRing className="w-5 h-5" /></span>
        <div className="min-w-0">
          <p className="font-semibold text-slate-900 text-sm">Get alerts on this phone</p>
          <p className="text-xs text-slate-500 mt-0.5">So you hear about a decided request, a customer’s birthday or an overdue follow-up without opening the app.</p>
        </div>
      </div>

      {state === 'needs-install' && (
        <ol className="text-xs text-slate-600 space-y-1.5 bg-slate-50 rounded-xl p-3 list-decimal list-inside">
          <li>Tap <Share className="inline w-3.5 h-3.5 -mt-0.5" /> <b>Share</b> in Safari, then <b>Add to Home Screen</b>.</li>
          <li>Open Time Keeper from the new icon on your home screen.</li>
          <li>Come back here and tap <b>Turn on alerts</b>.</li>
        </ol>
      )}
      {state === 'blocked' && (
        <p className="text-xs text-slate-600 bg-amber-50 border border-amber-100 rounded-xl p-3">
          Alerts were blocked for this app. Open your phone’s <b>Settings → Notifications → Time Keeper</b> and allow them, then reopen the app.
        </p>
      )}
      {state === 'off' && (
        <button type="button" onClick={turnOn} disabled={busy}
          className="btn-primary w-full py-3 inline-flex items-center justify-center gap-2 disabled:opacity-50">
          <Bell className="w-4 h-4" /> {busy ? 'Turning on…' : 'Turn on alerts'}
        </button>
      )}
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  );
}
