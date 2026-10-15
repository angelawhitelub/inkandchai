/**
 * Edge-caching policy for function responses.
 *
 * WHY THIS EXISTS
 * ---------------
 * 17 handlers still declare their shared-cache policy with the header Netlify
 * used, `Netlify-CDN-Cache-Control`. Cloudflare has never heard of it, and the
 * Worker was not translating it, so since the migration every one of those
 * responses has been uncached: catalog-search, product-page, the feeds, the
 * image proxy and the rest were hitting a function -- and through it Supabase
 * -- once per visitor, per request. Checked live, those responses came back
 * with no cf-cache-status header at all.
 *
 * A Worker's own response is not cached by the CDN automatically, whatever
 * header it sets. It has to be put into the cache explicitly, which is what
 * worker/index.js does with these helpers.
 *
 * The parsing lives here, apart from the Worker, so it can be tested: the
 * expensive mistake in this file would be caching something user-specific, and
 * that is a decision made entirely in `edgePolicy` and `edgeCacheKey`.
 */

export const EDGE_HEADER = 'Netlify-CDN-Cache-Control';
// Set on the stored copy so the browser-facing policy survives a cache hit --
// the edge TTL and the browser TTL are deliberately different numbers.
export const CLIENT_CC_HEADER = 'X-Client-Cache-Control';

/**
 * The longest a response with a query string is held at the edge.
 *
 * Cloudflare's tag purge is Enterprise-only, so utils/purge-cache purges by
 * URL. That works for a clean path -- /custom-feed.xml, /product/<slug>/,
 * /spimg/<key> -- and cannot work for /...?q=whatever, because there is no way
 * to enumerate every query a visitor has ever sent.
 *
 * An unpurgeable entry held for the declared hour is how an admin price edit
 * ends up invisible for an hour, which is a failure this shop has already been
 * bitten by on Netlify's durable cache. Five minutes still collapses virtually
 * all repeat traffic -- the egress win is in the volume of requests, not the
 * length of the TTL -- while bounding how long a save can hide.
 */
export const UNPURGEABLE_MAX_TTL = 300;

/**
 * The cap applied even to URLs we CAN purge.
 *
 * Purging is only a safety net if it actually fires, and on the first live test
 * admin-banners reported cache_purged:false. Until a purge is proven to work
 * end to end, holding anything for the declared hour -- or the image proxy's
 * declared month -- means a stale response with no way to clear it. Five
 * minutes still collapses effectively all repeat traffic.
 *
 * Raise it with the EDGE_MAX_TTL binding once purging is confirmed.
 */
export const DEFAULT_MAX_TTL = 300;

/**
 * What the shared cache should do with a response, read off its declared policy.
 * @returns {{cacheable: boolean, ttl: number, reason: string}}
 */
export function edgePolicy(headerValue) {
  const raw = String(headerValue || '').trim();
  if (!raw) return { cacheable: false, ttl: 0, reason: 'no policy declared' };

  const v = raw.toLowerCase();
  // `private` means one user's copy. Storing it in a shared cache would serve
  // one customer's response to the next visitor, so it is never cacheable here
  // regardless of any max-age alongside it.
  if (/\bprivate\b/.test(v))  return { cacheable: false, ttl: 0, reason: 'private' };
  if (/\bno-store\b/.test(v)) return { cacheable: false, ttl: 0, reason: 'no-store' };
  if (/\bno-cache\b/.test(v)) return { cacheable: false, ttl: 0, reason: 'no-cache' };

  // s-maxage is the shared-cache instruction and wins over max-age, which is
  // the browser's. Netlify's `durable` keyword has no meaning here.
  const s = v.match(/\bs-maxage\s*=\s*(\d+)/);
  const m = v.match(/\bmax-age\s*=\s*(\d+)/);
  const ttl = parseInt((s || m)?.[1] || '0', 10);
  if (!Number.isFinite(ttl) || ttl <= 0) return { cacheable: false, ttl: 0, reason: 'no positive ttl' };

  return { cacheable: true, ttl, reason: s ? 's-maxage' : 'max-age' };
}

/** The TTL to actually use for a given URL, after the purgeability cap. */
export function effectiveTtl(policy, url, purgeableMaxTtl = DEFAULT_MAX_TTL) {
  if (!policy.cacheable) return 0;
  const hasQuery = new URL(url).search.length > 0;
  const cap = hasQuery ? UNPURGEABLE_MAX_TTL : (Number(purgeableMaxTtl) || DEFAULT_MAX_TTL);
  return Math.min(policy.ttl, cap);
}

/**
 * The cache key for a request, or null if this request must never be served
 * from — or written to — a cache shared between visitors.
 */
export function edgeCacheKey(request) {
  if (request.method !== 'GET') return null;

  // Anything carrying identity is answered for that caller alone. This is what
  // keeps an admin request from filling the public cache with an admin
  // response, without every handler having to remember to say so.
  const h = request.headers;
  if (h.get('Authorization') || h.get('Cookie') ||
      h.get('X-Admin-Key') || h.get('X-Admin-Token')) return null;

  const url = new URL(request.url);
  // Cache-busting params from our own admin previews would otherwise each mint
  // a separate entry and never be hit again.
  url.searchParams.delete('_');
  url.searchParams.delete('cb');
  url.searchParams.sort();
  return new Request(url.toString(), { method: 'GET' });
}

/** True when a response is safe to hand to a cache shared by every visitor. */
export function isStorable(response) {
  if (response.status !== 200) return false;
  // A Set-Cookie on a shared cache entry hands the next visitor someone else's
  // session.
  if (response.headers.has('Set-Cookie')) return false;
  const vary = String(response.headers.get('Vary') || '').toLowerCase();
  if (vary.includes('*') || vary.includes('cookie') || vary.includes('authorization')) return false;
  return true;
}

/**
 * Last-good copies of admin-created product pages, served when rendering fails.
 *
 * Those ~1,100 pages are rendered per request from Supabase (product-page.js).
 * The five-minute edge copy above almost never helps a crawler: Google visits
 * each page every few days, so nearly every crawl is a cache miss. From 13 Oct
 * 2026 the database stalled every morning (09:30-12:30 IST) under Google's
 * heaviest crawl, product-page answered 503 or hung for minutes, and Merchant
 * Center disapproved 44 products as "Product page unavailable".
 *
 * So every good render also refreshes a long-lived copy under a separate key,
 * and a 5xx or a render slower than STALE_AFTER_MS is answered from that copy
 * instead. A 404 (product deactivated or deleted) is passed through untouched:
 * a removed book must never come back from a backup.
 */
export const STALE_TTL = 30 * 24 * 60 * 60;
export const STALE_AFTER_MS = 8000;

export function staleProductKey(origin, slug) {
  const s = encodeURIComponent(String(slug || '').toLowerCase());
  return new Request(`${origin}/__last-good/product/${s}/`, { method: 'GET' });
}

/**
 * render(): Promise<Response>. cache: { match(key), put(key, res) }.
 * waitUntil keeps the backup write (and a slow render) alive past the reply.
 * @returns {Promise<Response>} with X-Product-Source: fresh | last-good
 */
export async function renderWithLastGood(render, { cache, key, waitUntil, timeoutMs = STALE_AFTER_MS }) {
  const pending = Promise.resolve().then(render);
  let timer;
  const slow = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  let res = await Promise.race([pending.catch(() => null), slow]);
  clearTimeout(timer);

  if (res && res.status === 200) {
    const copy = res.clone();
    const stored = new Response(copy.body, copy);
    stored.headers.set('Cache-Control', `public, max-age=${STALE_TTL}`);
    stored.headers.delete('Set-Cookie');
    waitUntil(Promise.resolve(cache.put(key, stored)).catch(() => {}));
    return res;
  }
  if (res && res.status < 500) return res;          // 404 and friends: the truth

  const backup = await Promise.resolve(cache.match(key)).catch(() => null);
  if (backup) {
    // A slow render still finishes in the background and refreshes the copy.
    if (!res) waitUntil(pending.then((late) => {
      if (late && late.status === 200) {
        const stored = new Response(late.body, late);
        stored.headers.set('Cache-Control', `public, max-age=${STALE_TTL}`);
        return cache.put(key, stored);
      }
    }).catch(() => {}));
    const out = new Response(backup.body, backup);
    out.headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
    out.headers.set('X-Product-Source', 'last-good');
    return out;
  }
  // No copy yet in this location: the real answer, however long it takes.
  return res || pending;
}
