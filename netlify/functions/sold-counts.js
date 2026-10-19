/**
 * Netlify Function: sold-counts
 * GET /.netlify/functions/sold-counts   (public)
 *
 * { counts: { slug: units } } -- lifetime units sold for books with at least
 * SHOW_ON_PAGE_MIN, for the "🔥 N sold" line on book cards (book-card JS).
 * Same numbers as the product page line (utils/lifetime-sales, refreshed
 * hourly); a duplicated listing includes its original's units.
 */

const { readLifetimeSales, unitsSold, SHOW_ON_PAGE_MIN } = require('./utils/lifetime-sales');

exports.handler = async () => {
  const doc = await readLifetimeSales();
  const counts = {};
  // A duplicated listing shows its original's units too (doc.carried).
  const slugs = new Set([...Object.keys((doc && doc.counts) || {}), ...Object.keys((doc && doc.carried) || {})]);
  for (const slug of slugs) {
    const n = unitsSold(doc, slug);
    if (n >= SHOW_ON_PAGE_MIN) counts[slug] = n;
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
