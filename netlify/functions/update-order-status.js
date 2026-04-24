/**
 * Netlify Function: update-order-status
 * POST /.netlify/functions/update-order-status
 * Admin endpoint — update order status. Requires X-Admin-Key header.
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

const VALID_STATUSES = ['cod_pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'paid', 'refunded'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const adminKey = process.env.ADMIN_SECRET;
  const sentKey  = event.headers['x-admin-key'];
  if (!adminKey || sentKey !== adminKey) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { id, status } = body;
  if (!id || !status) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing id or status' }) };
  if (!VALID_STATUSES.includes(status)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid status' }) };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { error } = await supabase.from('orders').update({ status }).eq('id', id);
    if (error) throw error;
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
