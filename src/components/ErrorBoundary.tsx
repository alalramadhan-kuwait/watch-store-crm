/**
 * A crash that shows something.
 *
 * React unmounts the whole tree when a render throws, so before this the result
 * of one bad value reaching one component was an empty page — indistinguishable
 * from the app failing to load at all, and equally silent. The failsafe in
 * index.html catches a bundle that never arrives; this catches the app arriving
 * and then falling over.
 *
 * The reload clears the caches and the service worker on its way out, because a
 * crash is sometimes the tail of a half-stale build rather than a bug in the
 * code, and a plain reload would land straight back on it.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

async function clearAndReload() {
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch { /* private mode, or an API this browser withholds */ }
  window.location.reload();
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Nobody reads a phone's console, but this is what a screenshot of the
    // remote inspector will show when somebody does go looking.
    console.error('render failed', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-slate-900 text-slate-200">
        <div className="max-w-sm text-center">
          <p className="text-lg font-semibold text-slate-50">Something went wrong</p>
          <p className="mt-2 text-slate-400">
            The page stopped before it finished drawing. Reloading starts it again on the current version.
          </p>
          <button type="button" onClick={clearAndReload}
            className="mt-5 font-semibold px-5 py-2.5 rounded-lg bg-slate-50 text-slate-900 hover:bg-white">
            Reload
          </button>
        </div>
      </div>
    );
  }
}
