/**
 * Netlify Function: sold-out-slugs
 * GET /.netlify/functions/sold-out-slugs  ->  { slugs: [...] }
 *
 * Public and read-only: the slugs the storefront already shows as "Coming
 * Soon". The Worker reads it (at most once a minute per isolate) to mark
 * those books out of stock in feed.xml and in each product page's structured
 * data before Google sees them -- see utils/sold-out.js.
 */

const { createClient } = require('@supabase/supabase-js');
const { soldOutSlugs } = require('./utils/sold-out');

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=60',
};

exports.handler = async (event = {}) => {
  if (event.httpMethod && event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'GET only' }) };
  }
  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const slugs = [...await soldOutSlugs(db)].sort();
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ slugs }) };
  } catch (e) {
    console.error('[sold-out-slugs]', e.message);
    return { statusCode: 500, headers: { ...HEADERS, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: e.message }) };
  }
};
