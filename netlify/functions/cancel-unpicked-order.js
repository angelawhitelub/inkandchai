/**
 * Netlify Function: cancel-unpicked-order
 * POST /.netlify/functions/cancel-unpicked-order   { order_id: <orders.id> }
 *
 * A customer cancelling a paid order (prepaid, or partial COD's advance) that
 * the courier has not picked up 10+ days after it was placed. Full refund, no
 * shipping kept. Rules: utils/unpicked-cancel.js.
 *
 *   1. Ownership (Supabase JWT, matched by email -- as cancel-order.js).
 *   2. Claim the order: cancellation_requested_at, only if still empty, so a
 *      double tap is one cancel.
 *   3. admin-not-picked-up-cancel.handleOne: courier asked live, AWB voided,
 *      order cancelled through update-order-status, which refunds.
 *   4. Outcome:
 *        cancelled          -> done; refund on its way
 *        courier says moved -> claim released; "already picked up"
 *        no courier answer / courier refused / anything else
 *                           -> left as a request; the owner is alerted and
 *                              finishes it from Not Picked Up. No money moves
 *                              on a parcel we could not stop.
 */

const { createClient } = require('@supabase/supabase-js');
const { signAdminToken } = require('./utils/admin-auth');
const { quoteUnpickedCancel } = require('./utils/unpicked-cancel');
const { handleOne } = require('./admin-not-picked-up-cancel');
const { sendEmail } = require('./utils/email');
const { sendText } = require('./utils/whatsapp');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const rs = (paise) => `₹${Math.round(Number(paise || 0) / 100).toLocaleString('en-IN')}`;

const NOTE = 'Customer cancel: not picked up 10+ days after ordering (full refund).';

async function alertOwner(order, line) {
  const id = order.razorpay_order_id || order.id;
  const text = `⏳ ${id}: customer cancelled (not picked up in 10+ days)\n${line}\n`
    + `${order.customer_name || ''} ${order.customer_phone || ''}\n`
    + `${order.tracking_id ? `AWB ${order.courier_name || ''} ${order.tracking_id}\n` : ''}`
    + 'Admin → Not Picked Up: cancel & refund it there once the courier panel is sorted.';
  const jobs = [];
  if (process.env.STORE_OWNER_PHONE) jobs.push(sendText(process.env.STORE_OWNER_PHONE, text).catch(() => {}));
  if (process.env.STORE_OWNER_EMAIL) {
    jobs.push(sendEmail({
      to: process.env.STORE_OWNER_EMAIL,
      subject: `⏳ ${id} — customer cancel needs you (not picked up 10+ days)`,
      html: `<pre style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap;">${text.replace(/</g, '&lt;')}</pre>`,
    }).catch(() => {}));
  }
  await Promise.all(jobs);
}

/** Runs handleOne with owner rights for this one call (it cancels through update-order-status). */
function internalEvent() {
  const token = signAdminToken({ sub: 'system:customer-unpicked-cancel', role: 'owner', ttlMs: 5 * 60 * 1000 });
  return { headers: { 'x-admin-token': token } };
}

exports.handler = async (event = {}, context, deps = {}) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const supabase = deps.db || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const token = String(event.headers?.authorization || event.headers?.Authorization || '').replace(/^Bearer\s+/i, '').trim();
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
  try { body = JSON.parse(event.body || '{}') || {}; } catch { return json(400, { error: 'Invalid JSON' }); }
  if (!body.order_id) return json(400, { error: 'Missing order_id' });

  const { data: order, error } = await supabase.from('orders').select('*').eq('id', body.order_id).maybeSingle();
  if (error || !order) return json(404, { error: 'Order not found' });
  if (String(order.customer_email || '').toLowerCase() !== userEmail) {
    return json(403, { error: 'You do not have permission to cancel this order' });
  }

  const q = quoteUnpickedCancel(order);
  if (!q.eligible) {
    return json(422, { error: q.reason === 'already_requested'
      ? 'We already have a cancellation for this order and are working on it.'
      : 'This order can no longer be cancelled here. Please refresh your orders.', reason: q.reason });
  }

  // Claim: one cancel per order, whatever happens next.
  const at = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabase.from('orders')
    .update({ cancellation_requested_at: at, cancellation_request_note: NOTE })
    .eq('id', order.id).is('cancellation_requested_at', null).select('id');
  if (claimErr) {
    console.error('[cancel-unpicked-order] claim:', claimErr.message);
    return json(503, { error: 'Could not cancel this order right now. Please try again.' });
  }
  if (!claimed || !claimed.length) {
    return json(409, { error: 'We already have a cancellation for this order and are working on it.' });
  }

  const id = order.razorpay_order_id || order.id;
  let r;
  try {
    r = await (deps.handleOne || handleOne)(internalEvent(), supabase, { ...order, cancellation_requested_at: at }, { dryRun: false, confirmManual: false });
  } catch (e) {
    console.error('[cancel-unpicked-order]', id, e);
    r = { outcome: 'failed', reason: e.message };
  }
  console.log('[cancel-unpicked-order]', id, r.outcome, r.reason || '');

  if (r.outcome === 'cancelled') {
    return json(200, {
      success: true, outcome: 'cancelled',
      message: `Order cancelled. Your full refund of ${rs(q.refundPaise)} has been started to your original payment method — banks usually take 3–7 working days to show it.`,
    });
  }

  // The courier has it after all: not cancellable, and nothing was changed.
  if (r.outcome === 'skipped' && /courier says|moved/i.test(String(r.reason || ''))) {
    await supabase.from('orders').update({ cancellation_requested_at: null, cancellation_request_note: null })
      .eq('id', order.id).eq('cancellation_requested_at', at);
    return json(422, {
      error: 'Good news — the courier has just picked up your parcel, so it is on its way and can no longer be cancelled.',
      reason: 'moved',
    });
  }

  // Could not stop the parcel on our own: the owner finishes it.
  await (deps.alertOwner || alertOwner)(order, `${r.outcome}: ${r.reason || 'no reason given'}`);
  return json(202, {
    success: true, outcome: 'requested',
    message: `We've received your cancellation. We couldn't confirm with the courier just now, so our team will stop the parcel and send your full refund of ${rs(q.refundPaise)} within 24 hours. You don't need to do anything else.`,
  });
};
