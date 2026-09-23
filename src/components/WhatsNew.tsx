import { useEffect, useState } from 'react';
import { Modal } from './shared/Modal';
import releases from '../releases.json';
import pkg from '../../package.json';

/**
 * Which version this is, and what changed in it.
 *
 * The number comes from package.json and the notes from src/releases.json; the
 * build refuses to ship if the two disagree (scripts/release-check.mjs), so the
 * number on screen always has words behind it. The seven characters after it
 * are the exact build, set by CI on every deploy.
 *
 * A dot marks a version this phone has not opened the notes for yet. It is kept
 * per device, and prefixed: both apps are served from the same address, so an
 * unprefixed key would let one app's "seen" silence the other's.
 */

interface Release { version: string; date: string; title: string; changes: string[] }
const RELEASES = releases as Release[];
const SEEN_KEY = 'dsr:whatsNewSeen';
const SEEN_EVENT = 'dsr:whatsnew-seen';

export const APP_VERSION: string = pkg.version;
export const versionLabel = () => `v${APP_VERSION}${__BUILD_SHA__ ? ` · ${__BUILD_SHA__}` : ''}`;

function readSeen(): string | null {
  try { return localStorage.getItem(SEEN_KEY); } catch { return null; }
}

/** True until this device has opened the notes for the running version. */
export function useUnseenRelease(): boolean {
  const [seen, setSeen] = useState(readSeen);
  useEffect(() => {
    const sync = () => setSeen(readSeen());
    window.addEventListener(SEEN_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(SEEN_EVENT, sync); window.removeEventListener('storage', sync); };
  }, []);
  return seen !== APP_VERSION;
}

function markSeen() {
  try { localStorage.setItem(SEEN_KEY, APP_VERSION); } catch { /* private mode: the dot simply stays */ }
  window.dispatchEvent(new Event(SEEN_EVENT));
}

const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export function WhatsNewModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => { if (open) markSeen(); }, [open]);
  return (
    <Modal open={open} onClose={onClose} title="What's new" size="md">
      <p className="text-xs text-slate-500 mb-4">
        You are on <span className="font-semibold text-slate-700 tabular-nums">{versionLabel()}</span>
      </p>
      <div className="space-y-6">
        {RELEASES.map((r, i) => (
          <section key={r.version}>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className={`text-sm font-bold tabular-nums ${i === 0 ? 'text-brand-700' : 'text-slate-700'}`}>v{r.version}</span>
              <span className="text-xs text-slate-400">{day(r.date)}</span>
              {r.version === APP_VERSION && (
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-brand-50 text-brand-700">This phone</span>
              )}
            </div>
            <h3 className="font-semibold text-slate-900 mt-0.5">{r.title}</h3>
            <ul className="mt-2 space-y-1.5">
              {r.changes.map((c) => (
                <li key={c} className="flex gap-2 text-sm text-slate-600 leading-snug">
                  <span className="mt-[7px] w-1 h-1 rounded-full bg-slate-400 shrink-0" aria-hidden />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}

/** The version under the title: tap it for the notes. */
export function VersionChip({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const unseen = useUnseenRelease();
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        aria-label={`Version ${APP_VERSION}${unseen ? ', new, see what changed' : ', see what changed'}`}
        className={`relative inline-flex items-center gap-1 px-1.5 py-1 -my-1 rounded-md hover:bg-slate-50 touch-manipulation ${className}`}>
        <span className="leading-none tabular-nums">{versionLabel()}</span>
        {unseen && <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" aria-hidden />}
      </button>
      <WhatsNewModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
