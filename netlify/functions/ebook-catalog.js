/**
 * Netlify Function: ebook-catalog   (public)
 * GET                → every eBook on sale
 * GET ?slug=…        → just that one, for the button on a product page
 *
 * Returns only what publicEbook() allows through. The r2_key is the field that
 * turns a listing into a download, and it must never appear in a public
 * response — see utils/ebook.js.
 */

const { createClient } = require('@supabase/supabase-js');
const { publicEbook, normaliseSlug } = require('./utils/ebook');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  // Short, so a price change shows up quickly, but long enough that a product
  // page hitting this on every view is not a database read every time.
  'Cache-Control': 'public, max-age=120',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const slug = normaliseSlug((event.queryStringParameters || {}).slug);

  try {
    let q = db.from('ebooks').select('*').eq('active', true);
    if (slug) q = q.eq('slug', slug);
    const { data, error } = await q.order('updated_at', { ascending: false });
    if (error) {
      // Before the migration is run this must look like "no ebooks yet", not
      // like a broken site: the button simply does not render.
      console.warn('[ebook-catalog]', error.message);
      return json(200, { ebooks: [] });
    }
    return json(200, { ebooks: (data || []).map(publicEbook) });
  } catch (e) {
    console.error('[ebook-catalog]', e.message);
    return json(200, { ebooks: [] });
  }
};
