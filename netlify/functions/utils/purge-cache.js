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
 * Requires CF_ZONE_ID and CF_PURGE_TOKEN (a zone-scoped token with
 * Cache Purge: Edit). Without them this degrades to a no-op that reports
 * itself, which is why callers surface `cache_purged` to the admin UI.
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
  'product-overrides': ['/', '/feed.xml', '/custom-feed.xml'],
  [TAGS.APLUS]: ['/'],
  [TAGS.REVIEWS]: ['/'],
  [TAGS.REELS]: ['/', '/.netlify/functions/site-reels'],
};

function urlsForTags(tags) {
  const out = new Set();
  for (const t of tags) for (const u of TAG_URLS[t] || []) out.add(SITE + u);
  return [...out];
}

async function purgeUrls(urls) {
  const zone = process.env.CF_ZONE_ID;
  const token = process.env.CF_PURGE_TOKEN;
  if (!zone || !token) return { purged: false, reason: 'not-configured' };
  if (!urls.length) return { purged: false, reason: 'no-urls' };

  try {
    // Cloudflare caps a single purge-by-URL call at 30 entries.
    for (let i = 0; i < urls.length; i += 30) {
      // Every caller awaits this before answering the admin, so a purge that
      // hangs hangs the write it belongs to -- which is how "Delete Product
      // Page" could sit on "Deleting..." forever with no error, after the row
      // was already gone. Purging is best-effort by design (it reports itself
      // through `purged`/`reason`), so it gets a deadline and gives up.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), PURGE_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ files: urls.slice(i, i + 30) }),
          signal: ctl.signal,
        });
      } catch (err) {
        return { purged: false, reason: ctl.signal.aborted ? 'timeout' : (err.message || 'fetch-failed') };
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return { purged: false, reason: `http-${res.status}` };
    }
    return { purged: true, urls: urls.length };
  } catch (err) {
    return { purged: false, reason: err.message };
  }
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
