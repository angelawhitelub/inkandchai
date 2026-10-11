/**
 * Netlify Function: sold-counts
 * GET /.netlify/functions/sold-counts   (public)
 *
 * { counts: { slug: units } } -- lifetime units sold for books with at least
 * SHOW_ON_PAGE_MIN, for the "🔥 N sold" line on book cards (book-card JS).
 * Same numbers as the product page line and Reader Bestsellers badges
 * (utils/lifetime-sales, refreshed hourly).
 */

const { readLifetimeSales, SHOW_ON_PAGE_MIN } = require('./utils/lifetime-sales');

exports.handler = async () => {
  const doc = await readLifetimeSales();
  const counts = {};
  for (const [slug, n] of Object.entries((doc && doc.counts) || {})) {
    if (Number(n) >= SHOW_ON_PAGE_MIN) counts[slug] = Number(n);
  }
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=900',
      'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=900, stale-while-revalidate=3600',
    },
    body: JSON.stringify({ counts, updated_at: (doc && doc.updated_at) || null }),
  };
};
