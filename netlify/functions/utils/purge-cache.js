/**
 * Purge Netlify's durable edge cache by cache tag.
 *
 * The storefront's override feed is cached at the edge for up to an hour, which
 * is right for shoppers and wrong for the admin: a price saved in the panel sat
 * behind a cached copy of the old price until the TTL ran out. Responses carry
 * a Netlify-Cache-Tag, and every write that changes them purges that tag here.
 *
 * SITE_ID and NETLIFY_PURGE_API_TOKEN are injected into the Functions runtime by
 * Netlify — there is nothing to configure. Outside that runtime (local dev, a
 * one-off script) they are absent and this is a no-op, which is why it returns a
 * reason rather than throwing: a purge failure must never fail the save that
 * already succeeded.
 */
const PURGE_URL = 'https://api.netlify.com/api/v1/purge';

/**
 * The cache tags the storefront's cached reads are labelled with. An admin write
 * purges the tags it can invalidate; a read carries every tag that could make it
 * wrong. Keep both sides in this file so they cannot drift apart.
 *
 *   PRODUCTS — product data: prices, overrides, custom listings, shipping rules,
 *              gallery/video, deletions. Read by the override feed, the Lambda
 *              product page, search, and the Merchant feeds.
 *   APLUS    — A+ modules. Read by get-aplus-content and embedded in the Lambda
 *              product page, so an A+ save purges PRODUCTS too.
 *   REVIEWS  — customer reviews.
 *   REELS    — the Bookstagram strip.
 *
 * `product-overrides` is the tag the first version shipped with. Responses that
 * were cached under it are still out there, so PRODUCTS purges include it.
 */
const TAGS = {
  PRODUCTS: 'products',
  APLUS: 'aplus',
  REVIEWS: 'reviews',
  REELS: 'reels',
};

const PRODUCT_TAGS = [TAGS.PRODUCTS, 'product-overrides'];

/** Product data changed: prices, listings, media, availability. */
const purgeProducts = () => purgeCacheTags(PRODUCT_TAGS);
/** A+ modules changed. The Lambda product page embeds them, so purge both. */
const purgeAplus = () => purgeCacheTags([TAGS.APLUS, ...PRODUCT_TAGS]);

async function purgeCacheTags(tags) {
  const cacheTags = (Array.isArray(tags) ? tags : [tags]).filter(Boolean);
  if (!cacheTags.length) return { purged: false, reason: 'no-tags' };

  const siteId = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_PURGE_API_TOKEN;
  if (!siteId || !token) return { purged: false, reason: 'not-in-netlify-runtime' };

  try {
    const res = await fetch(PURGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ site_id: siteId, cache_tags: cacheTags }),
    });
    if (!res.ok) return { purged: false, reason: `http-${res.status}` };
    return { purged: true };
  } catch (err) {
    return { purged: false, reason: err.message };
  }
}

module.exports = { purgeCacheTags, purgeProducts, purgeAplus, TAGS, PRODUCT_TAGS };
