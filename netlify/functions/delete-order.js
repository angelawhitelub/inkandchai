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
const { requireAdmin } = require('./utils/admin-auth');
const { tombstoneMirroredOrder } = require('./utils/order-fallback');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
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

    // Read the order ids before the rows are gone. Every order is mirrored to
    // Netlify Blobs, and the mirror reconcile puts back anything missing from
    // the database — so without a tombstone a deliberate deletion would simply
    // reappear within minutes.
    const { data: doomed } = await supabase
      .from('orders').select('razorpay_order_id').in('id', ids);

    const { error, count } = await supabase
      .from('orders')
      .delete({ count: 'exact' })
      .in('id', ids);
    if (error) throw error;

    for (const row of (doomed || [])) {
      if (row?.razorpay_order_id) {
        await tombstoneMirroredOrder(event, row.razorpay_order_id, 'deleted from admin');
      }
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, deleted: count ?? ids.length }) };
  } catch (err) {
    console.error('delete-order error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
