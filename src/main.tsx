import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter as BrowserRouter } from 'react-router-dom';
import App from './App';
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
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

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
