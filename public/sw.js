/* DSR service worker — the app shell held on the device.

   PRECACHE is rewritten at build time with the hashed filenames Vite emits,
   which is also what makes this file differ between builds — the only signal a
   browser uses to decide a worker has changed. */
const BUILD = '__BUILD__';
const PRECACHE = ['./', './index.html', './manifest.webmanifest'];
const CACHE = 'dsr-' + BUILD;

/* How long a navigation waits for the server before falling back to the copy on
   the device. Long enough for a phone on a shop's connection, short enough that
   nobody is left looking at nothing. */
const SHELL_TIMEOUT_MS = 3500;

/* The files without which the app is not an app. Icons and the manifest are
   nice to have offline; the HTML and Vite's hashed JavaScript and CSS — the
   lazily loaded chunks included — are the difference between a working install
   and a blank screen. */
const essential = (u) => u === './' || u === './index.html' || /\.(js|css)$/.test(u);

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

self.addEventListener('install', (event) => {
  /* Deliberately no skipWaiting: the running page is asked first, so an update
     cannot replace the app underneath someone halfway through logging a sale. */
  event.waitUntil((async () => {
    const c = await caches.open(CACHE);

    /* Store only what the server actually returned, and wait for the write.
       Both halves of that were bugs, and together they are how a phone ended up
       serving a page whose scripts were missing. A 404 or a 503 — which is what
       GitHub Pages hands out for the seconds a deploy is landing — is a
       Response like any other, so it was cached as though it were the app. And
       because the put was never awaited, a worker killed straight after install
       (iOS does this readily) left the shell cached without the JavaScript it
       asks for. */
    const store = async (u) => {
      const res = await fetch(new Request(u, { cache: 'reload' }));
      if (!res.ok) throw new Error(u + ' -> ' + res.status);
      await c.put(u, res);
    };

    /* The shell installs completely or not at all. Failing here is the good
       outcome: the worker already running stays in charge, which is a working
       old version rather than a broken new one. */
    await Promise.all(PRECACHE.filter(essential).map(store));
    await Promise.all(PRECACHE.filter((u) => !essential(u)).map((u) => store(u).catch(() => {})));
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

/* This device is running a shell older than the site.

   Every deploy rebuilds the published branch from scratch, so the previous
   build's hashed filenames are gone from the server. A page holding on to one
   of them cannot be rescued — the script it needs does not exist anywhere any
   more. So throw the stale cache away and tell the app to start again; the
   reload lands on the build that is actually published. */
let recovering = false;
async function recoverFromStaleShell() {
  if (recovering) return;
  recovering = true;
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k.startsWith('dsr-')).map((k) => caches.delete(k)));
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of windows) { try { w.postMessage({ type: 'stale-shell' }); } catch (_e) { /* gone */ } }
}

/* What is safe to serve from a cache, and what is never.

   Everything the app reads and writes while it runs is live data from
   Supabase: today's cases, the roster, the day-close state. Those requests are
   cross-origin and are never touched here. A cached sales figure is not a
   faster answer, it is a wrong one — and a cached write would be worse. */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_e) { return; }
  if (url.origin !== self.location.origin) return;         // Supabase, and anything else

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      /* The server first, with a deadline.

         This used to answer every navigation from the cache and never ask the
         server again. A phone therefore stayed on whichever build it had until
         somebody noticed the update bar and tapped it — and because each deploy
         deletes the previous build's hashed files, that shell was asking for
         JavaScript the server no longer had. The 404 came back, nothing ran,
         and the result was a white page: silent, and survivable only by using a
         browser with no service worker at all.

         Offline still opens instantly. The cached shell is the fallback, and it
         is deliberately not overwritten with what the network returns, so it
         stays paired with the assets precached alongside it. */
      try {
        const fresh = await withTimeout(fetch(req), SHELL_TIMEOUT_MS);
        if (fresh && fresh.ok) return fresh;
      } catch (_e) { /* offline, or slower than the deadline */ }

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
      if (res && res.ok && res.type === 'basic') await c.put(req, res.clone());
      if (res && res.status === 404 && /\.(js|css)$/.test(url.pathname)) await recoverFromStaleShell();
      return res;
    } catch (_e) {
      return new Response('', { status: 504 });
    }
  })());
});
