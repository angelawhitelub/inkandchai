/**
 * Netlify Function: restore-listing
 * POST /.netlify/functions/restore-listing   { slug, action?: 'restore' | 'remove' }
 *
 * Admin — put a delisted product back on sale, or take one off sale again.
 *
 * A listing is "removed" through two independent levers, and this touches both:
 *
 *   1. product_overrides.stock_qty <= 0
 *        The product page reads this at runtime and replaces Add to Cart with
 *        a "Coming Soon" box (window.__soldOut). This is the lever that works
 *        for BOTH catalogue books (baked static pages) and custom listings.
 *   2. custom_products.is_active = false
 *        Drops the row from get-product-overrides, so the listing disappears
 *        from category pages and on-site search. Custom listings only —
 *        catalogue titles have no custom_products row.
 *
 * Restoring sets stock_qty back to NULL rather than to a number: NULL means
 * "no manual stock override" (unlimited / in stock), which is what these rows
 * looked like before they were delisted. Writing 999 instead would leave a
 * stock ceiling behind that nobody asked for.
 *
 * Why this is not update-product-override: that endpoint upserts a FULL row
 * (title, author, price, image, ...), so calling it to flip one field nulls
 * every field the caller didn't send. A restore must touch stock_qty and
 * is_active and nothing else, so it does targeted UPDATEs on existing rows.
 *
 * Headers: X-Admin-Token / X-Admin-Key. Owner-only — not in the staff
 * permission table in utils/admin-auth.js.
 */

const { createClient } = require('@supabase/supabase-js');
const { purgeProducts } = require('./utils/purge-cache');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Admin-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const json = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY are required.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  // Lowercased for the same reason update-product-override does it: the
  // storefront lowercases the slug it looks up and then does a case-sensitive
  // match, so a row keyed "...-NG-HI" can never be read back.
  const slug = String(body.slug || '').trim().toLowerCase().slice(0, 160);
  if (!slug) return json(400, { error: 'Missing product slug' });

  const action = String(body.action || 'restore').toLowerCase();
  if (action !== 'restore' && action !== 'remove') {
    return json(400, { error: "action must be 'restore' or 'remove'" });
  }
  const restoring = action === 'restore';

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const changed = [];

    // --- Lever 1: the stock override -------------------------------------
    const { data: existing, error: readErr } = await supabase
      .from('product_overrides').select('slug,stock_qty').eq('slug', slug).maybeSingle();
    if (readErr) throw readErr;

    if (restoring) {
      // Only clear a stock override that is actually blocking the page. If the
      // row is absent there is nothing to clear — the page was never blocked
      // by stock, and creating a row here would be noise.
      if (existing && existing.stock_qty !== null && Number(existing.stock_qty) <= 0) {
        const { error } = await supabase
          .from('product_overrides').update({ stock_qty: null, updated_at: new Date().toISOString() })
          .eq('slug', slug);
        if (error) throw error;
        changed.push('cleared the sold-out stock override');
      }
    } else {
      // Partial upsert: PostgREST builds the ON CONFLICT SET clause from the
      // keys present, so title/author/price on an existing row are untouched.
      const { error } = await supabase
        .from('product_overrides')
        .upsert({ slug, stock_qty: 0, updated_at: new Date().toISOString() }, { onConflict: 'slug' });
      if (error) throw error;
      changed.push('set the stock override to sold out');
    }

    // --- Lever 2: custom listing visibility -------------------------------
    // Catalogue titles have no custom_products row; that is normal, not an error.
    const { data: custom, error: customReadErr } = await supabase
      .from('custom_products').select('slug,is_active').eq('slug', slug).maybeSingle();
    if (customReadErr) throw customReadErr;

    if (custom && (custom.is_active !== false) !== restoring) {
      const { error } = await supabase
        .from('custom_products').update({ is_active: restoring }).eq('slug', slug);
      if (error) throw error;
      changed.push(restoring ? 'made the listing visible in search and listings' : 'hid the listing from search and listings');
    }

    if (!changed.length) {
      return json(200, {
        success: true, slug, action, changed: [],
        message: restoring ? 'Already live — nothing to restore.' : 'Already removed — nothing to change.',
      });
    }

    // Purge first, then report: the edge cache used to hold the old state for
    // up to an hour, which is why this message had to warn about it.
    const purge = await purgeProducts();
    return json(200, {
      success: true, slug, action, changed,
      message: `${restoring ? 'Restored' : 'Removed'} — ${changed.join(' and ')}.`
        + (purge.purged ? ' Live now.' : ' Live within the hour (storefront cache could not be purged).'),
    });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
