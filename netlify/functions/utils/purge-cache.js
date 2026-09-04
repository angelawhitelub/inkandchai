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

module.exports = { purgeCacheTags };
