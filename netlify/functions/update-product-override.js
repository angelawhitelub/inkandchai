const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

function cleanText(v, max = 500) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

function money(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return n.toFixed(2);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY are required.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const slug = cleanText(body.slug, 160);
  if (!slug) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing product slug' }) };

  const payload = {
    slug,
    title: cleanText(body.title, 220),
    author: cleanText(body.author, 120),
    category: cleanText(body.category, 120),
    price_inr: money(body.price_inr),
    original_price_inr: money(body.original_price_inr),
    // scarcity: shows "Only 4 left" urgency badge — always pinned, never runs out
    scarcity: body.scarcity === true || body.scarcity === 'true',
    is_active: body.is_active !== false,
    image_url: (body.image_url || '').trim().slice(0, 500) || null,
    updated_at: new Date().toISOString(),
  };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data, error } = await supabase
      .from('product_overrides')
      .upsert(payload, { onConflict: 'slug' })
      .select()
      .single();
    if (error) throw error;
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, override: data }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
