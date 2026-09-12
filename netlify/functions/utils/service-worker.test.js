/**
 * Tests for public/sw.js — the generated service worker.
 *
 * It lives in this directory because that is the only path `npm test` globs.
 * What it guards is not a Netlify function but the rule that matters most in
 * the Play Store build: a service worker that inserts itself into the payment
 * path can take the shop down in a way the shopkeeper cannot debug, and the
 * only visible symptom would be orders quietly not arriving.
 *
 * The worker is loaded into a fake ServiceWorkerGlobalScope, so these assert
 * the real shipped source, not a copy of its logic.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SW_PATH = path.join(__dirname, '..', '..', '..', 'public', 'sw.js');
const ORIGIN = 'https://inkandchai.in';

function res(body, ok = true) {
  return { ok, status: ok ? 200 : 500, body, clone() { return res(body, ok); } };
}

function loadWorker({ offline = false } = {}) {
  const source = fs.readFileSync(SW_PATH, 'utf8');
  const store = new Map();              // cache name -> Map(url -> response)
  const listeners = new Map();
  const fetched = [];

  const cacheFor = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const entries = store.get(name);
    return {
      async add(request) {
        const url = typeof request === 'string' ? request : request.url;
        if (offline) throw new Error('offline');
        entries.set(url, res('precached:' + url));
      },
      async put(request, value) { entries.set(request.url || request, value); },
      async match(request) {
        const url = request.url || request;
        return entries.get(url) || entries.get(url.replace(/\?.*$/, '')) || undefined;
      },
      async keys() { return [...entries.keys()].map(url => ({ url })); },
      async delete(key) { return entries.delete(key.url || key); },
    };
  };

  const context = {
    console,
    URL,
    Response: { error: () => res('network-error', false) },
    Request: class { constructor(url, init) { this.url = url; Object.assign(this, init); } },
    caches: {
      open: async (name) => cacheFor(name),
      keys: async () => [...store.keys()],
      delete: async (name) => store.delete(name),
      async match(request) {
        for (const name of store.keys()) {
          const hit = await cacheFor(name).match(request);
          if (hit) return hit;
        }
        return undefined;
      },
    },
    fetch: async (request) => {
      const url = request.url || request;
      fetched.push(url);
      if (offline) throw new Error('offline');
      return res('network:' + url);
    },
    setTimeout,
  };
  context.self = {
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    registration: { navigationPreload: { enable: async () => {} } },
    location: { origin: ORIGIN },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'sw.js' });

  const dispatch = async (type, event) => {
    const waits = [];
    const base = { waitUntil: (p) => waits.push(p) };
    for (const fn of listeners.get(type) || []) await fn(Object.assign(base, event));
    await Promise.all(waits);
  };

  /** Run the fetch handler and report whether the worker took the request. */
  const request = async (url, { mode = 'no-cors', destination = '', method = 'GET' } = {}) => {
    let answered = null;
    let intercepted = false;
    await dispatch('fetch', {
      request: { url: ORIGIN + url, method, mode, destination },
      preloadResponse: Promise.resolve(undefined),
      respondWith: (p) => { intercepted = true; answered = p; },
    });
    return { intercepted, response: answered ? await answered : null };
  };

  return { dispatch, request, store, fetched, context };
}

// ── The rule the whole design rests on ───────────────────────────────────────

test('the worker never touches the payment path, the admin panel, or a function', async () => {
  const sw = loadWorker();
  await sw.dispatch('install');
  await sw.dispatch('activate');

  for (const url of [
    '/checkout/',
    '/checkout/?paid=1',
    '/admin/',
    '/admin/index.html',
    '/.netlify/functions/create-order',
    '/refund-upi/abc123',
  ]) {
    const { intercepted } = await sw.request(url, { mode: 'navigate' });
    assert.equal(intercepted, false, `${url} must go straight to the network`);
  }
});

test('a POST is never intercepted, whatever the path', async () => {
  const sw = loadWorker();
  const { intercepted } = await sw.request('/', { mode: 'navigate', method: 'POST' });
  assert.equal(intercepted, false);
});

test('cross-origin requests are left to the browser', async () => {
  const sw = loadWorker();
  let intercepted = false;
  await sw.dispatch('fetch', {
    request: { url: 'https://cdn.example.com/cover.jpg', method: 'GET', mode: 'no-cors', destination: 'image' },
    preloadResponse: Promise.resolve(undefined),
    respondWith: () => { intercepted = true; },
  });
  assert.equal(intercepted, false);
});

// ── Navigation ───────────────────────────────────────────────────────────────

test('pages come from the network first, and are kept for offline', async () => {
  const sw = loadWorker();
  await sw.dispatch('install');
  await sw.dispatch('activate');

  const first = await sw.request('/bestsellers/', { mode: 'navigate' });
  assert.equal(first.intercepted, true);
  assert.match(first.response.body, /^network:/);

  const pages = [...sw.store.keys()].find(k => k.startsWith('iac-pages-'));
  assert.ok(pages, 'a page cache should exist');
  assert.deepEqual([...sw.store.get(pages).keys()], [ORIGIN + '/bestsellers/']);
});

test('a URL with a query string is never stored — ?paid=1 would invent a sale', async () => {
  const sw = loadWorker();
  await sw.dispatch('install');
  await sw.dispatch('activate');
  await sw.request('/thank-you/?paid=1&order=IC-1', { mode: 'navigate' });
  const pages = [...sw.store.keys()].find(k => k.startsWith('iac-pages-'));
  assert.equal(pages ? sw.store.get(pages).size : 0, 0);
});

test('offline, a page already visited is served from cache', async () => {
  const online = loadWorker();
  await online.dispatch('install');
  await online.dispatch('activate');
  await online.request('/bestsellers/', { mode: 'navigate' });

  // Same caches, network now failing.
  const sw = loadWorker({ offline: true });
  for (const [name, entries] of online.store) sw.store.set(name, entries);
  const { response } = await sw.request('/bestsellers/', { mode: 'navigate' });
  assert.match(response.body, /^network:/, 'should replay the cached copy');
});

test('offline, an unvisited page falls back to the offline page', async () => {
  const online = loadWorker();
  await online.dispatch('install');
  await online.dispatch('activate');

  const sw = loadWorker({ offline: true });
  for (const [name, entries] of online.store) sw.store.set(name, entries);
  const { response } = await sw.request('/some/page/never/seen/', { mode: 'navigate' });
  assert.match(response.body, /offline/, 'should be the precached /offline/ document');
});

// ── Housekeeping ─────────────────────────────────────────────────────────────

test('install precaches the offline page and the content-hashed shell', async () => {
  const sw = loadWorker();
  await sw.dispatch('install');
  const assets = [...sw.store.keys()].find(k => k.startsWith('iac-assets-'));
  const urls = [...sw.store.get(assets).keys()];
  assert.ok(urls.includes('/offline/'));
  assert.ok(urls.some(u => /^\/css\/app-shell-[0-9a-f]{8}\.css$/.test(u)), 'hashed css');
  assert.ok(urls.some(u => /^\/js\/app-shell-[0-9a-f]{8}\.js$/.test(u)), 'hashed js');
});

test('a single missing precache entry does not abandon the install', async () => {
  const sw = loadWorker();
  const realOpen = sw.context.caches.open;
  sw.context.caches.open = async (name) => {
    const cache = await realOpen(name);
    const add = cache.add.bind(cache);
    cache.add = async (r) => {
      if (String(r.url || r).includes('manifest')) throw new Error('404');
      return add(r);
    };
    return cache;
  };
  await assert.doesNotReject(() => sw.dispatch('install'));
  const assets = [...sw.store.keys()].find(k => k.startsWith('iac-assets-'));
  assert.ok([...sw.store.get(assets).keys()].includes('/offline/'));
});

test('activate deletes the previous release, and nothing that is not ours', async () => {
  const sw = loadWorker();
  sw.store.set('iac-pages-old', new Map([['/x', res('x')]]));
  sw.store.set('iac-assets-old', new Map());
  sw.store.set('workbox-precache', new Map());   // someone else's
  await sw.dispatch('install');
  await sw.dispatch('activate');
  const names = [...sw.store.keys()];
  assert.ok(!names.includes('iac-pages-old'));
  assert.ok(!names.includes('iac-assets-old'));
  assert.ok(names.includes('workbox-precache'), 'must not delete caches it does not own');
});

test('the long-lived image cache survives a release', async () => {
  const sw = loadWorker();
  sw.store.set('iac-img-v1', new Map([['/spimg/a.jpg', res('a')]]));
  await sw.dispatch('install');
  await sw.dispatch('activate');
  assert.ok(sw.store.has('iac-img-v1'));
});

test('covers are served from cache and the cache is capped', async () => {
  const sw = loadWorker();
  await sw.dispatch('activate');
  for (let i = 0; i < 160; i++) {
    await sw.request(`/spimg/cover-${i}.jpg`, { destination: 'image' });
  }
  // The worker trims without awaiting, so the response is never held up by
  // housekeeping. Give those promises a turn before measuring.
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(sw.store.get('iac-img-v1').size <= 150,
    `image cache must stay capped, got ${sw.store.get('iac-img-v1').size}`);

  sw.fetched.length = 0;
  await sw.request('/spimg/cover-159.jpg', { destination: 'image' });
  assert.equal(sw.fetched.length, 0, 'a cached cover should not hit the network again');
});

test('scripts and styles are served from cache while revalidating', async () => {
  const sw = loadWorker();
  await sw.dispatch('activate');
  const first = await sw.request('/js/app-shell-228cb1b7.js', { destination: 'script' });
  assert.match(first.response.body, /^network:/);
  sw.fetched.length = 0;
  const second = await sw.request('/js/app-shell-228cb1b7.js', { destination: 'script' });
  assert.match(second.response.body, /^network:/, 'served from cache');
  assert.equal(sw.fetched.length, 1, 'and refreshed in the background');
});
