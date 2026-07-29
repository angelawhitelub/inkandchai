const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
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

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : '';
}

function findCataloguePath() {
  const candidates = [
    path.join(process.cwd(), 'data', 'ALL_BOOKS.json'),
    path.join(__dirname, '..', '..', 'data', 'ALL_BOOKS.json'),
    path.join('/var/task', 'data', 'ALL_BOOKS.json'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`Catalogue file not found. Checked: ${candidates.join(', ')}`);
  return found;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;

  // ?q= — server-side search over custom_products. The full-list response
  // below can only carry the newest 1000 custom products (Supabase row cap;
  // returning all ~20k full rows would also exceed Netlify's 6 MB limit), so
  // the Product editor calls this for anything not in that window.
  const q = String((event.queryStringParameters || {}).q || '').trim().slice(0, 120);
  if (q) {
    try {
      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ products: [], overrides: [], aplus_content: [] }) };
      }
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const safe = q.replace(/[%,()]/g, ' ').replace(/\s+/g, ' ').trim();
      let rows = [];
      if (safe) {
        const { data, error } = await supabase
          .from('custom_products')
          .select('*')
          .or(`title.ilike.%${safe}%,author.ilike.%${safe}%,slug.ilike.%${safe}%,isbn.ilike.%${safe}%`)
          .order('updated_at', { ascending: false })
          .limit(60);
        if (error) throw error;
        rows = data || [];
      }
      const slugs = rows.map(r => r.slug).filter(Boolean);
      let overrides = [];
      let aplusContent = [];
      let shippingRules = [];
      if (slugs.length) {
        const [ovr, apl, ship] = await Promise.all([
          supabase.from('product_overrides').select('*').in('slug', slugs),
          supabase.from('product_aplus_content').select('*').in('slug', slugs),
          supabase.from('product_shipping_rules').select('*').in('slug', slugs),
        ]);
        overrides = ovr.data || [];
        aplusContent = apl.data || [];
        shippingRules = ship.data || [];
      }
      const products = rows.map(p => ({
        slug: p.slug,
        shopify_id: `CUSTOM:${p.slug}`,
        title: p.title || '',
        author: p.author || '',
        category: p.category || 'Books',
        price_inr: money(p.price_inr),
        original_price_inr: money(p.original_price_inr),
        image_url: p.image_url || '',
        gallery_images: Array.isArray(p.gallery_images) ? p.gallery_images : [],
        is_custom: true,
        description: p.description || '',
        publisher: p.publisher || '',
        isbn: p.isbn || '',
        tags: p.tags || '',
        seo_title: p.seo_title || '',
        meta_description: p.meta_description || '',
        is_active: p.is_active !== false,
      }));
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ products, overrides, aplus_content: aplusContent, shipping_rules: shippingRules }) };
    } catch (err) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
  }

  try {
    const dataPath = findCataloguePath();
    const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const seen = new Set();
    const products = [];
    for (const b of raw) {
      const sid = String(b.shopify_id || '');
      if (!sid || seen.has(sid) || !b.title) continue;
      seen.add(sid);
      products.push({
        slug: makeSlug(b.title, sid),
        shopify_id: sid,
        title: b.title || '',
        author: b.author || '',
        category: b.category || '',
        price_inr: money(b.price_inr),
        original_price_inr: money(b.original_price_inr),
        image_url: b.image_url || '',
      });
    }

    let overrides = [];
    let customProducts = [];
    let aplusContent = [];
    let shippingRules = [];
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data, error } = await supabase.from('product_overrides').select('*');
      if (error) console.warn('product_overrides unavailable:', error.message);
      else overrides = data || [];

      const { data: customData, error: customError } = await supabase
        .from('custom_products')
        .select('*')
        .order('updated_at', { ascending: false });
      if (customError) console.warn('custom_products unavailable:', customError.message);
      else customProducts = customData || [];

      const { data: aplusData, error: aplusError } = await supabase
        .from('product_aplus_content')
        .select('*');
      if (aplusError) console.warn('product_aplus_content unavailable:', aplusError.message);
      else aplusContent = aplusData || [];

      const { data: shippingData, error: shippingError } = await supabase
        .from('product_shipping_rules')
        .select('*');
      if (shippingError) console.warn('product_shipping_rules unavailable:', shippingError.message);
      else shippingRules = shippingData || [];
    }

    for (const p of customProducts) {
      if (!p?.slug || seen.has(`CUSTOM:${p.slug}`)) continue;
      products.unshift({
        slug: p.slug,
        shopify_id: `CUSTOM:${p.slug}`,
        title: p.title || '',
        author: p.author || '',
        category: p.category || 'Books',
        price_inr: money(p.price_inr),
        original_price_inr: money(p.original_price_inr),
        image_url: p.image_url || '',
        gallery_images: Array.isArray(p.gallery_images) ? p.gallery_images : [],
        is_custom: true,
        description: p.description || '',
        publisher: p.publisher || '',
        isbn: p.isbn || '',
        tags: p.tags || '',
        seo_title: p.seo_title || '',
        meta_description: p.meta_description || '',
        is_active: p.is_active !== false,
      });
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ products, overrides, custom_products: customProducts, aplus_content: aplusContent, shipping_rules: shippingRules }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
