/**
 * Netlify Function: free-delivery-slugs
 * GET /.netlify/functions/free-delivery-slugs  ->  { slugs: [slug, …] }
 *
 * Public and read-only: the books the admin set to ship free
 * (utils/free-delivery). The checkout and the cart drawer read it to show ₹0
 * delivery; the Worker reads it (at most once a minute per isolate) for the
 * product-page badge. The order functions decide the charge regardless.
 */

const { createClient } = require('@supabase/supabase-js');
const { allFreeDelivery } = require('./utils/free-delivery');

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
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ slugs: await allFreeDelivery(db) }) };
  } catch (e) {
    console.error('[free-delivery-slugs]', e.message);
    return { statusCode: 500, headers: { ...HEADERS, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: e.message }) };
  }
};
