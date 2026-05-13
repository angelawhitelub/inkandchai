/**
 * Netlify Function: delete-abandoned-checkout
 * POST /.netlify/functions/delete-abandoned-checkout
 *
 * Admin endpoint — permanently deletes one or more abandoned checkout leads.
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const adminKey = process.env.ADMIN_SECRET;
  const sentKey = event.headers['x-admin-key'];
  if (!adminKey || sentKey !== adminKey) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
  const cleanIds = ids.map(id => String(id || '').trim()).filter(Boolean);
  if (!cleanIds.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide id or ids[]' }) };
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY are required.' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { error, count } = await supabase
      .from('abandoned_checkouts')
      .delete({ count: 'exact' })
      .in('id', cleanIds);
    if (error) throw error;
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, deleted: count ?? cleanIds.length }) };
  } catch (err) {
    console.error('delete-abandoned-checkout error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
