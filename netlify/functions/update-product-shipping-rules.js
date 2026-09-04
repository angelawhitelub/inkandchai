const { createClient } = require('@supabase/supabase-js');
const { purgeProducts } = require('./utils/purge-cache');
const { requireAdmin } = require('./utils/admin-auth');
const { normalizeShippingRule } = require('./utils/shipping-restrictions');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

function json(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const adminBlock = requireAdmin(event, CORS); if (adminBlock) return adminBlock;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const slug = String(body.slug || '').trim().slice(0, 160);
  if (!slug) return json(400, { error: 'Missing product slug' });
  const rule = normalizeShippingRule({
    excluded_states: body.excluded_states,
    excluded_pincodes: body.excluded_pincodes,
  });

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    if (!rule.states.length && !rule.pins.length) {
      const { error } = await supabase.from('product_shipping_rules').delete().eq('slug', slug);
      if (error) throw error;
      await purgeProducts();
      return json(200, { success: true, rule: null });
    }
    const payload = {
      slug,
      excluded_states: rule.states,
      excluded_pincodes: rule.pins,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase
      .from('product_shipping_rules')
      .upsert(payload, { onConflict: 'slug' })
      .select()
      .single();
    if (error) throw error;
    await purgeProducts();
    return json(200, { success: true, rule: data });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
