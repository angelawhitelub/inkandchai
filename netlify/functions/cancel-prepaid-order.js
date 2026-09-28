/**
 * Netlify Function: cancel-prepaid-order
 * POST /.netlify/functions/cancel-prepaid-order
 *
 * Body: { order_id: "<orders.id uuid>" }            cancel it
 *       { order_id: "<orders.id uuid>", quote: true } only say what it would cost
 *
 * A prepaid customer cancelling after the 30-minute window, up to out for
 * delivery. Before an AWB: full refund. After: refund minus shipping (Rs 74
 * per 0.5 kg slab), and the courier is asked to stop the parcel. The rules and
 * the courier/refund ordering live in utils/prepaid-late-cancel.js.
 *
 * cancel-order.js (30-minute prepaid, COD before pickup) is untouched and
 * still handles everything it did.
 *
 * Security: validates the Supabase JWT and matches the order by email, the
 * same ownership rule as cancel-order.js.
 */

const { createClient } = require('@supabase/supabase-js');
const { quoteLateCancel, executeLateCancel } = require('./utils/prepaid-late-cancel');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const token = String(event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json(401, { error: 'Not authenticated' });
  let userEmail;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user?.email) throw new Error('Invalid token');
    userEmail = user.email.toLowerCase();
  } catch {
    return json(401, { error: 'Invalid or expired session. Please sign in again.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  if (!body.order_id) return json(400, { error: 'Missing order_id' });

  const { data: order, error } = await supabase.from('orders').select('*').eq('id', body.order_id).maybeSingle();
  if (error || !order) return json(404, { error: 'Order not found' });
  if (String(order.customer_email || '').toLowerCase() !== userEmail) {
    return json(403, { error: 'You do not have permission to cancel this order' });
  }

  if (body.quote) {
    const q = quoteLateCancel(order);
    return json(200, q.eligible
      ? { eligible: true, refund_paise: q.refundPaise, deduction_paise: q.deductionPaise, books: q.books, slab_kg: q.slabKg, has_awb: q.hasAwb }
      : { eligible: false, reason: q.reason, message: q.message });
  }

  try {
    const r = await executeLateCancel(supabase, order);
    if (!r.ok) return json(r.status || 422, { error: r.message, reason: r.reason });
    return json(200, {
      success: true, outcome: r.outcome, message: r.message,
      refund_paise: r.refund_paise, deduction_paise: r.deduction_paise,
    });
  } catch (e) {
    console.error('[cancel-prepaid-order]', e.message);
    return json(500, { error: 'Could not cancel this order. Please try again or contact us.' });
  }
};
