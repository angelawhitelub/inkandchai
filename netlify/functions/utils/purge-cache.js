/**
 * Storefront cache purge — Cloudflare.
 *
 * On Netlify this purged by cache tag. Cloudflare's tag purge is an Enterprise
 * feature, so this purges by URL instead and maps each logical tag to the URLs
 * that actually serve it.
 *
 * This used to say function responses were never edge-cached, so an admin write
 * was visible immediately and purging was only a belt-and-braces pass over the
 * static pages. That stopped being true when the Worker started honouring the
 * handlers' declared policies (worker/cache-policy.mjs) -- a cached function
 * response can now hide a save, which is exactly the failure this shop hit on
 * Netlify's durable cache. So the function URLs are purged too.
 *
 * Only clean URLs can be purged; a query string cannot be enumerated. That is
 * why the Worker caps the TTL on anything carrying one -- see
 * UNPURGEABLE_MAX_TTL.
 *
 * Requires CF_PURGE_TOKEN, a zone-scoped token with Cache Purge: Edit (add
 * Zone: Read and CF_ZONE_ID can be left unset -- the zone is then looked up by
 * name, which is one fewer hand-typed 32-hex string to get wrong). Without a
 * usable token this degrades to a no-op that reports itself, which is why
 * callers surface `cache_purged` to the admin UI.
 */
const SITE = (process.env.SITE_URL || 'https://inkandchai.in').replace(/\/+$/, '');

// A purge is never worth making an admin wait; the write it follows is done.
const PURGE_TIMEOUT_MS = Number(process.env.PURGE_TIMEOUT_MS || 5000);

const TAGS = {
  PRODUCTS: 'products',
  APLUS: 'aplus',
  REVIEWS: 'reviews',
  REELS: 'reels',
};
const PRODUCT_TAGS = [TAGS.PRODUCTS, 'product-overrides'];

// A tag maps to the static URLs whose content can change when it is purged.
// Per-product pages are added by the caller-supplied slugs where known.
const TAG_URLS = {
  [TAGS.PRODUCTS]: ['/', '/feed.xml', '/sitemap.xml', '/category/', '/collection/',
                    '/custom-feed.xml'],
  // The listing/search payload itself: without it a deleted book keeps being
  // handed to every browser from the edge for the full hour of s-maxage.
  'product-overrides': ['/', '/feed.xml', '/custom-feed.xml',
                        '/.netlify/functions/get-product-overrides'],
  [TAGS.APLUS]: ['/'],
  [TAGS.REVIEWS]: ['/'],
  [TAGS.REELS]: ['/', '/.netlify/functions/site-reels'],
};

function urlsForTags(tags) {
  const out = new Set();
  for (const t of tags) for (const u of TAG_URLS[t] || []) out.add(SITE + u);
  return [...out];
}

// Cloudflare's purge endpoint is addressed by the zone's 32-hex id, never by
// its name. CF_ZONE_ID had been set to the literal string "inkandchai2026",
// so every purge since the migration answered a bare `http-404` with nothing
// to say why -- months of admin saves that never cleared the edge.
//
// So the id is no longer trusted to be right. If Cloudflare cannot route to
// whatever is configured, the zone is looked up by name and the call retried;
// with a token that carries Zone:Read, CF_ZONE_ID becomes optional entirely.
// Resolved once per isolate, including the negative answer -- a token without
// Zone:Read must not re-ask on every purge.
const _zoneMemo = new Map();

async function lookupZoneId(token) {
  if (_zoneMemo.has(token)) return _zoneMemo.get(token);
  _zoneMemo.set(token, null);
  let host;
  try { host = new URL(SITE).host; } catch { return null; }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PURGE_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(host)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctl.signal,
    });
    if (!res || !res.ok || typeof res.json !== 'function') return null;
    const body = await res.json().catch(() => null);
    const found = body && Array.isArray(body.result) ? body.result[0] : null;
    if (found && found.id) _zoneMemo.set(token, found.id);
  } catch { /* best-effort, like everything else here */ }
  finally { clearTimeout(timer); }
  return _zoneMemo.get(token);
}

async function purgeUrls(urls) {
  // Trimmed, and a pasted "Bearer " prefix dropped: both produce an
  // Authorization header Cloudflare rejects outright (error 6111), which is
  // indistinguishable from a permissions problem unless you go looking.
  const token = String(process.env.CF_PURGE_TOKEN || '').trim().replace(/^Bearer\s+/i, '');
  let zone = String(process.env.CF_ZONE_ID || '').trim();
  if (!token) return { purged: false, reason: 'not-configured' };
  if (!urls.length) return { purged: false, reason: 'no-urls' };
  if (!zone) {
    zone = await lookupZoneId(token);
    if (!zone) return { purged: false, reason: 'zone-unresolved' };
  }

  // Every caller awaits this before answering the admin, so a purge that hangs
  // hangs the write it belongs to -- which is how "Delete Product Page" could
  // sit on "Deleting..." forever with no error, after the row was already gone.
  // Purging is best-effort by design (it reports itself through
  // `purged`/`reason`), so it gets a deadline and gives up.
  const post = async (zoneId, files) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PURGE_TIMEOUT_MS);
    try {
      return await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ files }),
        signal: ctl.signal,
      });
    } catch (err) {
      throw ctl.signal.aborted ? new Error('timeout') : err;
    } finally {
      clearTimeout(timer);
    }
  };

  let relookedUp = false;
  try {
    // Cloudflare caps a single purge-by-URL call at 30 entries.
    for (let i = 0; i < urls.length; i += 30) {
      const batch = urls.slice(i, i + 30);
      let res;
      try { res = await post(zone, batch); }
      catch (err) { return { purged: false, reason: err.message || 'fetch-failed' }; }

      // 404 here means "cannot route to that zone" -- a wrong id, not a missing
      // URL. Worth one lookup before giving up.
      if (!res.ok && res.status === 404 && !relookedUp) {
        relookedUp = true;
        const real = await lookupZoneId(token);
        if (real && real !== zone) {
          zone = real;
          try { res = await post(zone, batch); }
          catch (err) { return { purged: false, reason: err.message || 'fetch-failed' }; }
        }
      }
      if (!res.ok) return { purged: false, reason: `http-${res.status}`, ...(await cfDetail(res)) };
    }
    return { purged: true, urls: urls.length, zone_resolved: relookedUp || undefined };
  } catch (err) {
    return { purged: false, reason: err.message };
  }
}

// Cloudflare's own error code says far more than the status does (7003 = bad
// zone id, 6111 = malformed token, 1001 = not a zone id at all). Surface it so
// the next person does not have to write a diagnostic endpoint to find out.
async function cfDetail(res) {
  if (!res || typeof res.json !== 'function') return {};
  const body = await res.json().catch(() => null);
  const errs = (body && body.errors) || [];
  return errs.length ? { cf_code: errs[0].code, cf_message: errs[0].message } : {};
}

async function purgeCacheTags(tags) {
  const list = (Array.isArray(tags) ? tags : [tags]).filter(Boolean);
  if (!list.length) return { purged: false, reason: 'no-tags' };
  return purgeUrls(urlsForTags(list));
}

// Purge specific product pages as well as the tag's shared URLs.
async function purgeProductSlugs(slugs) {
  const list = (Array.isArray(slugs) ? slugs : [slugs]).filter(Boolean);
  const urls = urlsForTags(PRODUCT_TAGS)
    .concat(list.map((s) => `${SITE}/product/${encodeURIComponent(s)}/`));
  return purgeUrls(urls);
}

const purgeProducts = () => purgeCacheTags(PRODUCT_TAGS);
const purgeAplus = () => purgeCacheTags([TAGS.APLUS, ...PRODUCT_TAGS]);

module.exports = { purgeCacheTags, purgeProducts, purgeAplus, purgeProductSlugs, purgeUrls, TAGS, PRODUCT_TAGS };
