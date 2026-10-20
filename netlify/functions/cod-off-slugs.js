/**
 * Netlify Function: cod-off-slugs
 * GET /.netlify/functions/cod-off-slugs  ->  { rules: { slug: note } }
 *
 * Public and read-only: the books whose Cash on Delivery the admin switched
 * off, with the reason shown to customers (utils/cod-rules). Checkout reads it
 * to switch the COD button off before the customer tries; the Worker reads it
 * (at most once a minute per isolate) to put the notice on product pages.
 * cod-order enforces the same rule regardless.
 */

const { createClient } = require('@supabase/supabase-js');
const { allCodRules } = require('./utils/cod-rules');

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
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ rules: await allCodRules(db) }) };
  } catch (e) {
    console.error('[cod-off-slugs]', e.message);
    return { statusCode: 500, headers: { ...HEADERS, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: e.message }) };
  }
};
