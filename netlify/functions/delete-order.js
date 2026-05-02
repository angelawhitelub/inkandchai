/**
 * Netlify Function: delete-order
 * POST /.netlify/functions/delete-order
 *
 * Admin endpoint — permanently deletes an order from Supabase.
 * Requires X-Admin-Key header. Body: { id } or { ids: [...] }.
 *
 * IMPORTANT: deletion is permanent — there's no soft-delete column.
 * The admin UI prompts for confirmation before calling this.
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const adminKey = process.env.ADMIN_SECRET;
  const sentKey  = event.headers['x-admin-key'];
  if (!adminKey || sentKey !== adminKey) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // Accept either { id: 'uuid' } or { ids: ['uuid1', 'uuid2', ...] }
  const ids = body.ids || (body.id ? [body.id] : []);
  if (!ids.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide id or ids[]' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { error, count } = await supabase
      .from('orders')
      .delete({ count: 'exact' })
      .in('id', ids);
    if (error) throw error;
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, deleted: count ?? ids.length }) };
  } catch (err) {
    console.error('delete-order error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
