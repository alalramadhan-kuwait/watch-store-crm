/* DSR service worker — the app shell held on the device.

   PRECACHE is rewritten at build time with the hashed filenames Vite emits,
   which is also what makes this file differ between builds — the only signal a
   browser uses to decide a worker has changed. */
const BUILD = '__BUILD__';
const PRECACHE = ['./', './index.html', './manifest.webmanifest'];
const CACHE = 'dsr-' + BUILD;

self.addEventListener('install', (event) => {
  /* Deliberately no skipWaiting: the running page is asked first, so an update
     cannot replace the app underneath someone halfway through logging a sale. */
  event.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(PRECACHE.map(async (u) => {
      // cache:"reload" so a stale copy in the HTTP cache cannot be installed as the new one
      try { c.put(u, await fetch(new Request(u, { cache: 'reload' }))); } catch (_e) { /* one missing file must not fail the install */ }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('dsr-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* What is safe to serve from a cache, and what is never.

   The shell — the HTML, the wordmark's face and Vite's content-hashed
   JavaScript and CSS — is immutable for a given build, so it is served from the
   cache and the app opens at once, with or without a network.

   Everything the app reads and writes while it runs is live data from Supabase:
   today's cases, the roster, the day-close state. Those requests are
   cross-origin and are never touched here. A cached sales figure is not a
   faster answer, it is a wrong one — and a cached write would be worse. */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_e) { return; }
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
      try { return await fetch(req); }
      catch (_e) {
        return new Response('Offline, and the DSR is not installed on this device yet.',
          { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') c.put(req, res.clone());
      return res;
    } catch (_e) {
      return hit || new Response('', { status: 504 });
    }
  })());
});
