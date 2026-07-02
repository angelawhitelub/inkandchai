/**
 * Netlify Function: get-book-requests
 * GET  /.netlify/functions/get-book-requests            → list requests
 * POST /.netlify/functions/get-book-requests {id,status} → update a request's status
 *
 * Admin endpoint — the book-order requests customers place through the WhatsApp
 * bot (submit_order_request tool) land in bot_order_requests. This surfaces them
 * in the admin panel so the team can convert them into real orders.
 *
 * Requires X-Admin-Token / X-Admin-Key.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-Admin-Key',
  'Content-Type': 'application/json',
};

const VALID_STATUS = ['new', 'contacted', 'ordered', 'closed'];

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
