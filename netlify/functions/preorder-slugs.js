/**
 * Netlify Function: preorder-slugs
 * GET /.netlify/functions/preorder-slugs  ->  { releases: { slug: 'YYYY-MM-DD' } }
 *
 * Public and read-only: the books whose release day is still ahead
 * (utils/release-date). The cart drawer and checkout read it to mark pre-order
 * lines and say when the order ships; utils/pricing stamps the same date on
 * the saved order (_release) regardless.
 */

const { createClient } = require('@supabase/supabase-js');
const { allReleases } = require('./utils/release-date');

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=300',
};

exports.handler = async (event = {}) => {
  if (event.httpMethod && event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'GET only' }) };
  }
  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ releases: await allReleases(db) }) };
  } catch (e) {
    console.error('[preorder-slugs]', e.message);
    return { statusCode: 500, headers: { ...HEADERS, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: e.message }) };
  }
};
