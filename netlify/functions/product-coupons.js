const { createClient } = require('@supabase/supabase-js');
const { publicCoupon } = require('./utils/product-coupons');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  const slugs = String(event.queryStringParameters?.slugs || '')
    .split(',').map(v => v.trim()).filter(Boolean).slice(0, 50);
  if (!slugs.length) return { statusCode: 200, headers: CORS, body: JSON.stringify({ coupons: [] }) };
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const now = new Date();
    const { data, error } = await supabase
      .from('product_coupons')
      .select('code,label,discount_type,discount_value,min_subtotal_inr,product_slugs,online_only,starts_at,expires_at,is_active')
      .eq('is_active', true);
    if (error) {
      if (error.code === '42P01' || error.code === 'PGRST205') {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ coupons: [] }) };
      }
      throw error;
    }
    const wanted = new Set(slugs);
    const coupons = (data || [])
      .filter(c => (!c.starts_at || new Date(c.starts_at) <= now)
        && (!c.expires_at || new Date(c.expires_at) >= now)
        && (c.product_slugs || []).some(s => wanted.has(s)))
      .map(publicCoupon);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ coupons }) };
  } catch (err) {
    console.error('product-coupons:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not load product coupons' }) };
  }
};
