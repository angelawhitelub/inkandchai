const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

function makeSlug(title, shopifyId) {
  const sid = String(shopifyId || '');
  if (sid === 'CUSTOM-KINGS-OF-SIN-COMPLETE-SET-6-AH') return 'kings-of-sin-series-complete-set-6-books-ana-huang';
  if (sid === 'CUSTOM-HINDI-BESTSELLERS-COMBO-5') return '5-hindi-bestsellers-combo-set-of-5-books-MBO-5';
  if (sid === 'CUSTOM-GOGGINS-COMBO-HI') return 'david-goggins-combo-hindi-cant-hurt-me-never-finished';
  if (sid === 'CUSTOM-MOTHER-MARY-COMES-TO-ME-HI-ARUNDHATI-ROY') return 'mother-mary-comes-to-me-hindi-edition-arundhati-roy';
  const base = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 55);
  const suffix = sid.slice(-5);
  return suffix ? `${base}-${suffix}` : base;
}

function cataloguePath() {
  const candidates = [
    path.join(process.cwd(), 'data', 'ALL_BOOKS.json'),
    path.join(__dirname, '..', '..', 'data', 'ALL_BOOKS.json'),
    path.join('/var/task', 'data', 'ALL_BOOKS.json'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate));
}

function chunks(items, size = 40) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };
  const adminBlock = requireAdmin(event, CORS);
  if (adminBlock) return adminBlock;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const raw = Array.isArray(body.updates) ? body.updates : [];
  if (!raw.length || raw.length > 250) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide 1–250 price updates' }) };
  }

  const seen = new Set();
  const updates = [];
  for (const row of raw) {
    const slug = String(row?.slug || '').trim();
    const price = Number(row?.price_inr);
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(slug) || !Number.isFinite(price) || price <= 0) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Invalid update for ${slug || 'unknown product'}` }) };
    }
    if (seen.has(slug)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Duplicate product: ${slug}` }) };
    }
    seen.add(slug);
    updates.push({ slug, price: Number(price.toFixed(2)) });
  }

  try {
    const dataPath = cataloguePath();
    if (!dataPath) throw new Error('Catalogue file not found');
    const catalogue = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const basePrice = new Map();
    const seenShopify = new Set();
    for (const book of catalogue) {
      const sid = String(book.shopify_id || '');
      if (!sid || !book.title || seenShopify.has(sid)) continue;
      seenShopify.add(sid);
      const price = Number(book.price_inr);
      if (Number.isFinite(price)) basePrice.set(makeSlug(book.title, sid), price);
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const slugs = updates.map(row => row.slug);
    const customRows = [];
    const overrideRows = [];
    for (const group of chunks(slugs)) {
      const [{ data: custom, error: customError }, { data: overrides, error: overrideError }] = await Promise.all([
        supabase.from('custom_products').select('slug,price_inr').in('slug', group),
        supabase.from('product_overrides').select('slug,price_inr,is_active').in('slug', group),
      ]);
      if (customError) throw customError;
      if (overrideError) throw overrideError;
      customRows.push(...(custom || []));
      overrideRows.push(...(overrides || []));
    }
    for (const row of customRows) {
      const price = Number(row.price_inr);
      if (Number.isFinite(price)) basePrice.set(row.slug, price);
    }
    const overrideBySlug = new Map(overrideRows.map(row => [row.slug, row]));

    const missing = slugs.filter(slug => !basePrice.has(slug));
    if (missing.length) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({
        error: `${missing.length} product${missing.length === 1 ? '' : 's'} not found`,
        missing,
      }) };
    }

    const skipped = [];
    const rowsToWrite = [];
    for (const update of updates) {
      const override = overrideBySlug.get(update.slug);
      const current = override && override.is_active !== false && override.price_inr != null
        ? Number(override.price_inr)
        : Number(basePrice.get(update.slug));
      if (update.price >= current) {
        skipped.push({ slug: update.slug, current_price: current, suggested_price: update.price });
        continue;
      }
      rowsToWrite.push({
        slug: update.slug,
        price_inr: update.price.toFixed(2),
        is_active: true,
        updated_at: new Date().toISOString(),
      });
    }

    for (const group of chunks(rowsToWrite)) {
      const { error } = await supabase.from('product_overrides').upsert(group, { onConflict: 'slug' });
      if (error) throw error;
    }

    const verifiedRows = [];
    for (const group of chunks(rowsToWrite.map(row => row.slug))) {
      if (!group.length) continue;
      const { data, error } = await supabase
        .from('product_overrides')
        .select('slug,price_inr,is_active')
        .in('slug', group);
      if (error) throw error;
      verifiedRows.push(...(data || []));
    }
    const verified = new Map(verifiedRows.map(row => [row.slug, row]));
    const failures = rowsToWrite.filter(row => {
      const actual = verified.get(row.slug);
      return !actual || actual.is_active === false || Math.abs(Number(actual.price_inr) - Number(row.price_inr)) > 0.009;
    });
    if (failures.length) throw new Error(`Price verification failed for ${failures.length} product(s)`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        requested: updates.length,
        applied: rowsToWrite.length,
        skipped_already_lower: skipped.length,
        skipped,
        verified: rowsToWrite.length - failures.length,
      }),
    };
  } catch (error) {
    console.error('[bulk-product-prices]', error);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
  }
};
