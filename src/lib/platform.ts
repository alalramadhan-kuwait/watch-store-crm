/* What the DSR needs to behave like an installed application rather than a page
   that happens to be open: the browser's own zoom refused, the place you were
   remembered, and a new version offered rather than imposed. */

const standalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  ('standalone' in navigator && (navigator as unknown as { standalone: boolean }).standalone === true);

/* ── zoom ─────────────────────────────────────────────────────────
   The viewport tag says the interface does not scale and Chrome obeys
   it; Safari decided years ago to ignore user-scalable, so the gesture
   events are refused here too. Double tap is handled in the stylesheet
   by touch-action: manipulation — refusing it here would mean
   swallowing the second of two quick taps on the same button, and this
   app is used at speed with one thumb. */
function refuseZoom() {
  const stop = (e: Event) => e.preventDefault();
  (['gesturestart', 'gesturechange', 'gestureend'] as const).forEach((t) =>
    document.addEventListener(t, stop, { passive: false }),
  );
  /* The trackpad pinch, on touch devices only. At a desk, zooming a page
     of figures with a trackpad is a reasonable thing to do and taking it
     away would be an accessibility loss for no gain. */
  if (window.matchMedia('(pointer: coarse)').matches) {
    window.addEventListener(
      'wheel',
      (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); },
      { passive: false },
    );
  }
}

/* ── where you were ───────────────────────────────────────────────
   A phone locks itself between customers. Reopening used to land on
   Quick Entry whatever you had been doing; it now comes back to the
   page you left — but only when the app was opened cold at its start
   URL, so a link always wins, and only for a shift's length. */
const ROUTE_KEY = 'dsr:lastRoute';
const ROUTE_TTL = 8 * 60 * 60 * 1000;

function rememberRoute() {
  const save = () => {
    const h = window.location.hash;
    if (!h || h === '#/') return;
    try { localStorage.setItem(ROUTE_KEY, JSON.stringify({ hash: h, at: Date.now() })); } catch { /* private mode */ }
  };
  window.addEventListener('hashchange', save);
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
  setInterval(save, 5000);
}

export function restoreRoute() {
  const h = window.location.hash;
  if (h && h !== '#/' && h !== '#') return;
  if (!standalone()) return;
  try {
    const raw = localStorage.getItem(ROUTE_KEY);
    if (!raw) return;
    const { hash, at } = JSON.parse(raw) as { hash: string; at: number };
    if (!hash || typeof at !== 'number' || Date.now() - at > ROUTE_TTL) return;
    window.location.replace(window.location.pathname + window.location.search + hash);
  } catch { /* nothing to restore */ }
}

/* ── a new version ────────────────────────────────────────────────
   The worker installs the new build in the background and waits. */
let bar: HTMLElement | null = null;
let reloading = false;

function updateBar(onTake: () => void) {
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = 'tk-update';
  bar.innerHTML =
    '<span>A new version is ready.</span>' +
    '<button type="button" class="tk-go">Update</button>' +
    '<button type="button" class="tk-later">Later</button>';
  document.body.appendChild(bar);
  bar.querySelector('.tk-go')!.addEventListener('click', onTake);
  bar.querySelector('.tk-later')!.addEventListener('click', () => bar!.classList.remove('tk-show'));
  return bar;
}

export function watchForUpdates(reg: ServiceWorkerRegistration) {
  const take = () => {
    const w = reg.waiting;
    if (!w) { window.location.reload(); return; }
    reloading = true;
    w.postMessage({ type: 'SKIP_WAITING' });
    setTimeout(() => { if (reloading) window.location.reload(); }, 2500);
  };
  const offer = () => {
    const el = updateBar(take);
    void el.offsetHeight;
    el.classList.add('tk-show');
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) { reloading = false; window.location.reload(); }
  });

  if (reg.waiting && navigator.serviceWorker.controller) offer();
  reg.addEventListener('updatefound', () => {
    const nw = reg.installing;
    if (!nw) return;
    nw.addEventListener('statechange', () => {
      if (nw.state === 'installed' && navigator.serviceWorker.controller) offer();
    });
  });

  let last = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - last < 9e5) return;
    last = Date.now();
    reg.update().catch(() => {});
  });
}

export async function registerSW(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try {
    return await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' });
  } catch { return null; }
}

export function initPlatform() {
  refuseZoom();
  rememberRoute();
}
