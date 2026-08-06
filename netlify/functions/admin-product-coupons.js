const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { normalizeCouponCode } = require('./utils/product-coupons');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS); if (block) return block;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  try {
    if (event.httpMethod === 'GET') {
      const slug = String(event.queryStringParameters?.slug || '').trim();
      let query = supabase.from('product_coupons').select('*').order('created_at', { ascending: false });
      if (slug) query = query.contains('product_slugs', [slug]);
      const { data, error } = await query;
      if (error) throw error;
      return json(200, { coupons: data || [] });
    }
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const code = normalizeCouponCode(body.code);
      const type = body.discount_type === 'fixed' ? 'fixed' : 'percent';
      const value = Number(body.discount_value);
      const slugs = [...new Set((Array.isArray(body.product_slugs) ? body.product_slugs : [])
        .map(v => String(v).trim()).filter(Boolean))].slice(0, 200);
      if (code.length < 3) return json(400, { error: 'Coupon code must contain at least 3 letters or numbers.' });
      if (!String(body.label || '').trim()) return json(400, { error: 'Promotional tag is required.' });
      if (!slugs.length) return json(400, { error: 'Select at least one product.' });
      if (!(value > 0) || (type === 'percent' && value > 100)) return json(400, { error: 'Enter a valid discount value.' });
      const { data: existing } = await supabase.from('product_coupons').select('product_slugs').eq('code', code).maybeSingle();
      const productSlugs = [...new Set([...(existing?.product_slugs || []), ...slugs])].slice(0, 200);
      const payload = {
        code,
        label: String(body.label).trim().slice(0, 180),
        discount_type: type,
        discount_value: value,
        min_subtotal_inr: Math.max(0, Number(body.min_subtotal_inr) || 0),
        product_slugs: productSlugs,
        online_only: true,
        is_active: body.is_active !== false,
        starts_at: body.starts_at || null,
        expires_at: body.expires_at || null,
        updated_at: new Date().toISOString(),
      };
      const { data, error } = await supabase.from('product_coupons')
        .upsert(payload, { onConflict: 'code' }).select().single();
      if (error) throw error;
      return json(200, { coupon: data });
    }
    if (event.httpMethod === 'DELETE') {
      const code = normalizeCouponCode(event.queryStringParameters?.code);
      if (!code) return json(400, { error: 'Coupon code is required.' });
      const { error } = await supabase.from('product_coupons').delete().eq('code', code);
      if (error) throw error;
      return json(200, { success: true });
    }
    return json(405, { error: 'Method Not Allowed' });
  } catch (err) {
    console.error('admin-product-coupons:', err);
    return json(500, { error: err.message });
  }
};
