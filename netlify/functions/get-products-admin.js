const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

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

  const adminKey = process.env.ADMIN_SECRET;
  const sentKey = event.headers['x-admin-key'] || event.queryStringParameters?.key;
  if (!adminKey || sentKey !== adminKey) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
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
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data, error } = await supabase.from('product_overrides').select('*');
      if (error) console.warn('product_overrides unavailable:', error.message);
      else overrides = data || [];
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ products, overrides }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
