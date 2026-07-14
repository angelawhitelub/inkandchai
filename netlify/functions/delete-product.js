/**
 * Netlify Function: delete-product
 * POST /.netlify/functions/delete-product   { slug }
 *
 * Admin — permanently delete a CUSTOM product page. Removes the custom_products
 * row (which the product-page function serves from) and any product_overrides
 * row for the same slug. The product page then 404s and the listing drops from
 * the custom feed and on-site search.
 *
 * Catalogue books (the ~2,700 baked static pages under public/product/<slug>/)
 * are NOT in custom_products — they're static files served before the function
 * runs, so they can't be deleted from here. For those we return a clear 409 so
 * the admin knows it needs a netlify.toml 404 redirect + deploy instead.
 *
 * Headers: X-Admin-Token / X-Admin-Key.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Admin-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase env vars missing' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const slug = String(body.slug || '').trim();
  if (!slug) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide product slug' }) };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Is this actually a custom product? Match case-insensitively (stored slugs
    // may carry an upper-case suffix while the URL slug is lower-case).
    const { data: found, error: findErr } = await supabase
      .from('custom_products')
      .select('slug, title')
      .ilike('slug', slug)
      .limit(1)
      .maybeSingle();
    if (findErr) throw findErr;

    if (!found) {
      return {
        statusCode: 409,
        headers: CORS,
        body: JSON.stringify({
          error: 'This is a catalogue book (a baked static page), not a custom listing — it can\'t be deleted from here. To hide it, add a 404 redirect for its /product/ URL in netlify.toml and redeploy.',
          kind: 'catalogue',
        }),
      };
    }

    const realSlug = found.slug;
    // Delete the custom product row (authoritative source for its page + feed).
    const del = await supabase.from('custom_products').delete().eq('slug', realSlug);
    if (del.error) throw del.error;
    // Best-effort: drop any override row so a stale price/title can't linger.
    try { await supabase.from('product_overrides').delete().eq('slug', realSlug); } catch (e) { /* non-fatal */ }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, slug: realSlug, title: found.title || '' }),
    };
  } catch (err) {
    console.error('delete-product error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
