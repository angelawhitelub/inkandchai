/**
 * Netlify Function: get-book-requests
 * GET  /.netlify/functions/get-book-requests            → list requests
 * POST /.netlify/functions/get-book-requests {id,status} → update a request's status
 * POST /.netlify/functions/get-book-requests {id,edit:{customer_name,address,books,notes,amount_rupees,payment_mode}}
 *                                                       → correct a request before it is pushed to Orders
 *
 * Admin endpoint — the book-order requests customers place through the WhatsApp
 * bot (submit_order_request tool) land in bot_order_requests. This surfaces them
 * in the admin panel so the team can convert them into real orders.
 *
 * Requires X-Admin-Token / X-Admin-Key.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { HIDDEN_STATUSES, buildRequestEdit } = require('./utils/bot-order-request');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-Admin-Key',
  'Content-Type': 'application/json',
};

const VALID_STATUS = ['new', 'contacted', 'ordered', 'closed'];

const reply = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

async function saveEdit(supabase, id, edit) {
  const { data: req, error } = await supabase.from('bot_order_requests').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!req) return reply(404, { error: 'Request not found' });
  const built = buildRequestEdit(req, edit);
  if (built.error) return reply(built.code, { error: built.error });

  // order_pushed_id guards against a push landing between the read and this write.
  const { data: saved, error: saveError } = await supabase.from('bot_order_requests')
    .update(built.values).eq('id', id).is('order_pushed_id', null).select('id');
  if (saveError) throw saveError;
  if (!saved || !saved.length) return reply(409, { error: 'This request was just pushed to Orders. Refresh and edit it there.' });

  // The bot reuses the saved name and address on this customer's next order,
  // so a correction to their latest request has to reach that copy too.
  try {
    await supabase.from('bot_customers')
      .update({ customer_name: built.values.customer_name, address: built.values.address, updated_at: new Date().toISOString() })
      .eq('customer_phone', req.customer_phone).eq('last_order_id', req.order_id);
  } catch (e) { console.warn('get-book-requests bot_customers:', e.message); }
  return reply(200, { success: true });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase env vars missing' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const id = String(body.id || '').trim();
      if (id && body.edit) return await saveEdit(supabase, id, body.edit);
      const status = String(body.status || '').trim();
      if (!id || !VALID_STATUS.includes(status)) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide id and a valid status.' }) };
      }
      const { error } = await supabase.from('bot_order_requests').update({ status }).eq('id', id);
      if (error) throw error;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
    }

    const { data, error } = await supabase
      .from('bot_order_requests')
      .select('*')
      // Drafts the customer has not said YES to are not orders yet.
      .not('status', 'in', `(${HIDDEN_STATUSES.join(',')})`)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) {
      // Table may not exist yet — return empty rather than 500 so the admin UI
      // degrades gracefully until the migration is run.
      console.warn('get-book-requests:', error.message);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ requests: [], warning: error.message }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ requests: data || [] }) };
  } catch (err) {
    console.error('get-book-requests error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
