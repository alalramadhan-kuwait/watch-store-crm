/**
 * What the service worker must not do again.
 *
 * Employees were shown a white page on their phones, on and off, and were told
 * to use Chrome instead of Safari. That worked for the wrong reason: Chrome on
 * iOS runs no service worker at all, so it was the only browser still asking
 * the server for anything. Safari had a worker that answered every navigation
 * from its cache and never checked again, while each deploy replaced the site
 * and deleted the previous build's hashed filenames — so the shell on the phone
 * asked for JavaScript that no longer existed, got a 404, and drew nothing.
 *
 * None of that showed up in a build, a typecheck or a test, which is why this
 * exists. It loads the *built* worker — the one with the real precache list
 * written into it — in a fake Service Worker global and puts it through the
 * situations that actually happen: a deploy landing mid-install, a phone a
 * build behind, a dead network, a slow one.
 *
 * Run after `vite build`, from `npm run build`, so a worker that would strand a
 * phone cannot reach the deploy.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';


const SCOPE = 'https://example.com/app/';
const abs = (u) => new URL(u, SCOPE).href;

function makeCaches() {
  const store = new Map();                       // name -> Map(absUrl -> Response)
  const cacheApi = (name) => ({
    async put(k, res) {
      const key = typeof k === 'string' ? abs(k) : abs(k.url);
      store.get(name).set(key, res);
    },
    async match(k) {
      const key = typeof k === 'string' ? abs(k) : abs(k.url);
      return store.get(name).get(key);
    },
  });
  return {
    store,
    api: {
      async open(name) { if (!store.has(name)) store.set(name, new Map()); return cacheApi(name); },
      async keys() { return [...store.keys()]; },
      async delete(name) { return store.delete(name); },
      async match(k) {
        const key = typeof k === 'string' ? abs(k) : abs(k.url);
        for (const m of store.values()) if (m.has(key)) return m.get(key);
        return undefined;
      },
    },
  };
}

function load(path, { server, clients = [] } = {}) {
  const listeners = {};
  const c = makeCaches();
  const posted = [];
  for (const cl of clients) cl.postMessage = (m) => posted.push(m);

  const sandbox = {
    self: {
      addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
      location: { href: SCOPE + 'sw.js', origin: 'https://example.com' },
      clients: { claim: async () => {}, matchAll: async () => clients },
      registration: { scope: SCOPE },
      skipWaiting: () => {},
    },
    caches: c.api,
    // async, because a real fetch always hands back a promise — a synchronous
    // Response here silently broke the network-first path under test
    fetch: async (req) => server(typeof req === 'string' ? req : req.url, req),
    /* A worker resolves a relative URL against its own scope; Node's Request
       refuses one outright, so give the sandbox one that does what the browser does. */
    Request: class extends Request {
      constructor(input, init) { super(typeof input === 'string' ? abs(input) : input, init); }
    },
    Response, URL, setTimeout, clearTimeout, Promise, console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path, 'utf8'), sandbox, { filename: path });

  const fire = async (type, event) => {
    let held, responded;
    const ev = { ...event, waitUntil: (p) => { held = p; }, respondWith: (p) => { responded = p; } };
    for (const fn of listeners[type] ?? []) await fn(ev);
    return { held, responded };
  };
  return { fire, caches: c, posted };
}

const SW = process.argv[2] ?? 'dist/sw.js';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  — ' + extra : '')); }
};

const ASSET = SCOPE + 'assets/index-AAA.js';
const goodServer = (url) => {
  if (url.endsWith('/') || url.endsWith('index.html')) return new Response('<html>v1</html>', { status: 200 });
  if (url.endsWith('.js') || url.endsWith('.css')) return new Response('code', { status: 200 });
  return new Response('icon', { status: 200 });
};

console.log('\nservice worker: ' + SW);

/* 1 — a deploy landing mid-install must not be cached as if it were the app */
{
  const deploying = (url) =>
    url.endsWith('index.html') ? new Response('Not Found', { status: 404 }) : goodServer(url);
  const sw = load(SW, { server: deploying });
  const { held } = await sw.fire('install', {});
  let why = null;
  try { await held; } catch (e) { why = e.message; }
  // the message must name the 404, or this passed for the wrong reason
  ok('install fails when the shell 404s (old worker stays in charge)',
    why !== null && why.includes('404'), 'error was: ' + why);
  ok('nothing poisoned was left behind', !(await sw.caches.api.match('./index.html')));
}

/* 2 — a clean install caches the shell and its assets, writes awaited */
let installed;
{
  const sw = load(SW, { server: goodServer });
  const { held } = await sw.fire('install', {});
  await held;
  const shell = await sw.caches.api.match('./index.html');
  ok('clean install caches the shell', !!shell);
  const names = [...sw.caches.store.values()][0];
  ok('and caches the hashed assets alongside it',
    [...names.keys()].some((k) => k.endsWith('.js')) && [...names.keys()].some((k) => k.endsWith('.css')));
  installed = sw;
}

/* 3 — online, a navigation gets what the server has now, not the cached build */
{
  const sw = load(SW, { server: goodServer });
  await (await sw.fire('install', {})).held;
  const fresh = (url) => (url.endsWith('/') ? new Response('<html>v2</html>', { status: 200 }) : goodServer(url));
  const sw2 = load(SW, { server: fresh });
  sw2.caches.store.set([...sw.caches.store.keys()][0], [...sw.caches.store.values()][0]);
  const { responded } = await sw2.fire('fetch', { request: { method: 'GET', url: SCOPE, mode: 'navigate' } });
  const body = await (await responded).clone().text();
  ok('online navigation serves the published build', body.includes('v2'), 'got ' + body);
  const stillCached = await sw2.caches.api.match('./index.html');
  ok('the offline copy is left paired with its own assets', (await stillCached.clone().text()).includes('v1'));
}

/* 4 — offline, it still opens */
{
  const sw = load(SW, { server: goodServer });
  await (await sw.fire('install', {})).held;
  const dead = () => { throw new Error('offline'); };
  const sw2 = load(SW, { server: dead });
  sw2.caches.store.set([...sw.caches.store.keys()][0], [...sw.caches.store.values()][0]);
  const { responded } = await sw2.fire('fetch', { request: { method: 'GET', url: SCOPE, mode: 'navigate' } });
  ok('offline navigation falls back to the cached shell', (await (await responded).clone().text()).includes('v1'));
}

/* 5 — a slow network does not hold the app hostage */
{
  const sw = load(SW, { server: goodServer });
  await (await sw.fire('install', {})).held;
  const slow = () => new Promise((r) => setTimeout(() => r(new Response('late')), 30000));
  const sw2 = load(SW, { server: slow });
  sw2.caches.store.set([...sw.caches.store.keys()][0], [...sw.caches.store.values()][0]);
  const started = Date.now();
  const { responded } = await sw2.fire('fetch', { request: { method: 'GET', url: SCOPE, mode: 'navigate' } });
  const body = await (await responded).clone().text();
  const took = Date.now() - started;
  ok('a stalled network falls back within the deadline', body.includes('v1') && took < 6000, took + 'ms');
}

/* 6 — the stale-shell case itself: an asset the server no longer has */
{
  const client = { id: 'w1' };
  const gone = (url) => (url.endsWith('index-AAA.js') ? new Response('', { status: 404 }) : goodServer(url));
  const sw = load(SW, { server: gone, clients: [client] });
  await (await sw.fire('install', {})).held;
  const before = [...sw.caches.store.keys()].length;
  const { responded } = await sw.fire('fetch', { request: { method: 'GET', url: ASSET, mode: 'no-cors' } });
  await responded;
  ok('a 404 on a hashed asset empties the stale cache', before > 0 && [...sw.caches.store.keys()].length === 0);
  ok('and tells the page to start again', sw.posted.some((m) => m.type === 'stale-shell'));
}

/* 7 — Supabase is never touched */
{
  const sw = load(SW, { server: goodServer });
  const { responded } = await sw.fire('fetch', {
    request: { method: 'GET', url: 'https://ttshgrujnycapugrmyxs.supabase.co/rest/v1/attendance', mode: 'cors' },
  });
  ok('cross-origin data requests are passed straight through', responded === undefined);
}

console.log(`\n  service worker: ${pass} checks passed` + (fail ? `, ${fail} FAILED` : ''));
process.exit(fail ? 1 : 0);
