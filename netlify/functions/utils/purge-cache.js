/**
 * Storefront cache purge — Cloudflare.
 *
 * On Netlify this purged by cache tag. Cloudflare's tag purge is an Enterprise
 * feature, so this purges by URL instead and maps each logical tag to the URLs
 * that actually serve it.
 *
 * Note the shape of the problem changed with the platform. Cloudflare does not
 * edge-cache /.netlify/functions/* responses unless a Cache Rule says to, and
 * the old Netlify-CDN-Cache-Control headers the handlers still send are simply
 * ignored. So admin writes are already immediately visible and this is a
 * belt-and-braces pass over the *static* pages that embed the same data.
 *
 * Requires CF_ZONE_ID and CF_PURGE_TOKEN (a zone-scoped token with
 * Cache Purge: Edit). Without them this degrades to a no-op that reports
 * itself, which is why callers surface `cache_purged` to the admin UI.
 */
const SITE = (process.env.SITE_URL || 'https://inkandchai.in').replace(/\/+$/, '');

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
  [TAGS.PRODUCTS]: ['/', '/feed.xml', '/sitemap.xml', '/category/', '/collection/'],
  'product-overrides': ['/', '/feed.xml'],
  [TAGS.APLUS]: ['/'],
  [TAGS.REVIEWS]: ['/'],
  [TAGS.REELS]: ['/'],
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
      const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ files: urls.slice(i, i + 30) }),
      });
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
