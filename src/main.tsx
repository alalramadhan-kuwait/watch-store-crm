import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter as BrowserRouter } from 'react-router-dom';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';
import { initPlatform, restoreRoute, registerSW, watchForUpdates } from './lib/platform';

// Before React renders: refuse the browser's own zoom, and put the app back on
// the page it was left on. Restoring the route first means the router mounts
// straight onto it rather than rendering Quick Entry and then moving.
initPlatform();
restoreRoute();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </BrowserRouter>
  </React.StrictMode>
);

/* Tell the failsafe in index.html that the app is up, so it stands down — and
   clear the repair flag, so a failure weeks from now is still allowed its one
   silent recovery. */
window.__booted = true;
try { sessionStorage.removeItem('dsr:recovering'); } catch { /* private mode */ }

/* The worker found this device asking for a file the server no longer has,
   which means the shell it is running belongs to a replaced build. It has
   already thrown the stale cache away; the reload lands on the current one. */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'stale-shell') window.location.reload();
  });
}

/* Production only: in development the worker would serve a cached shell over
   Vite's hot reloading and nothing you changed would appear. Registered after
   the first paint, because the install fetches the whole bundle again and doing
   that while the app is still starting slows down the one thing it makes fast. */
if (import.meta.env.PROD) {
  window.addEventListener('load', () => {
    setTimeout(() => {
      registerSW().then((reg) => { if (reg) watchForUpdates(reg); });
    }, 1200);
  });
}
