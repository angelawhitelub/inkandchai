/**
 * Netlify Function: admin-sales-lineage   (admin)
 *
 * Which listing an admin-created book was duplicated from, so its "🔥 N sold"
 * line includes the original's sales (custom_products.sales_from_slug, read by
 * lifetime-sales-scheduled). Set on Create when the form was copied; this is
 * the product editor's way to set or clear it later.
 *
 *   GET  ?slug=…                 → { custom, from_slug, own, carried, shown, from_units }
 *   POST { slug, from_slug }     → same, after saving; '' clears
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { cleanSalesSlug, readLifetimeSales, unitsSold } = require('./utils/lifetime-sales');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const MIGRATION = 'The sales_from_slug column is missing — run sql/custom_products_sales_from_slug.sql in Supabase first.';
const missingColumn = (error) => /sales_from_slug/i.test((error && error.message) || '');

async function describe(row, slug) {
  const doc = await readLifetimeSales();
  const key = String(slug).toLowerCase();
  const own = Number(doc && doc.counts && doc.counts[key]) || 0;
  const from = row ? cleanSalesSlug(row.sales_from_slug) : '';
  return {
    custom: !!row,
    from_slug: from || null,
    own,
    // What the last hourly count published for this page.
    carried: Number(doc && doc.carried && doc.carried[key]) || 0,
    shown: unitsSold(doc, key),
    from_units: from ? unitsSold(doc, from) : 0,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return json(500, { error: 'Supabase is not configured.' });
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (event.httpMethod === 'GET') {
    const slug = String((event.queryStringParameters || {}).slug || '').trim();
    if (!cleanSalesSlug(slug)) return json(400, { error: 'Missing product slug' });
    const { data, error } = await db.from('custom_products').select('slug,sales_from_slug').eq('slug', slug).maybeSingle();
    if (error) {
      if (!missingColumn(error)) return json(500, { error: error.message });
      return json(200, { ...(await describe(null, slug)), migration: MIGRATION });
    }
    return json(200, await describe(data, slug));
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const slug = String(body.slug || '').trim();
  if (!cleanSalesSlug(slug)) return json(400, { error: 'Missing product slug' });
  const raw = String(body.from_slug || '').trim();
  // Accept a pasted product URL as well as a bare slug.
  const m = raw.match(/\/product\/([^/?#]+)/i);
  let from = '';
  if (raw) {
    try { from = cleanSalesSlug(m ? decodeURIComponent(m[1]) : raw); } catch { from = ''; }
    if (!from) return json(400, { error: 'That is not a product slug or /product/… link.' });
    if (from === slug.toLowerCase()) return json(400, { error: 'A listing cannot carry its own sales.' });
  }

  const { data, error } = await db.from('custom_products')
    .update({ sales_from_slug: from || null })
    .eq('slug', slug)
    .select('slug,sales_from_slug')
    .maybeSingle();
  if (error) return json(missingColumn(error) ? 409 : 500, { error: missingColumn(error) ? MIGRATION : error.message });
  if (!data) return json(400, { error: 'Only listings created in admin can carry another listing\'s sales.' });
  console.log(`[admin-sales-lineage] ${slug} ← ${from || '(cleared)'}`);
  return json(200, await describe(data, slug));
};
