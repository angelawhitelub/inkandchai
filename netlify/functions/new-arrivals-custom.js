/**
 * Netlify Function: new-arrivals-custom
 * GET /.netlify/functions/new-arrivals-custom   (public)
 *
 * { books: [{ slug, title, author, price, image }] } -- the newest admin-created
 * books, which the Worker puts first on /new-arrivals/ and /new-arrivals-2026/
 * (utils/new-arrivals). Everything here is already on the public product pages.
 */

const { createClient } = require('@supabase/supabase-js');
const { latestCustomBooks } = require('./utils/new-arrivals');
const { soldOutSlugs } = require('./utils/sold-out');

exports.handler = async (event = {}) => {
  if (event.httpMethod && event.httpMethod !== 'GET') return { statusCode: 405, body: 'GET only' };
  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const soldOut = await soldOutSlugs(db).catch(() => new Set());
    const books = await latestCustomBooks(db, { soldOut });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
      body: JSON.stringify({ books }),
    };
  } catch (e) {
    console.error('[new-arrivals-custom]', e.message);
    return { statusCode: 503, headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: e.message }) };
  }
};
