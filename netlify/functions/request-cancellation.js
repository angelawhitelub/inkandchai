/**
 * Netlify Function: request-cancellation
 * POST /.netlify/functions/request-cancellation   { order_id, reason? }
 *
 * Customer-facing "please cancel this" REQUEST — available at any live status
 * (including in-transit / shipped / out-for-delivery) for BOTH COD and prepaid.
 *
 * CRITICAL: this is a REQUEST ONLY. It does NOT:
 *   - change order.status,
 *   - issue any refund,
 *   - cancel the NimbusPost shipment.
 * It records cancellation_requested_at + a note and alerts the store owner, who
 * decides what to do. The existing instant-cancel workarounds (COD before pickup,
 * prepaid within 30 min) live in cancel-order.js and are intentionally untouched.
 *
 * Security: validates the Supabase JWT and confirms the order belongs to the
 * signed-in customer's email — same ownership check as cancel-order.js.
 */

const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('./utils/email');
const { sendText } = require('./utils/whatsapp');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

// Statuses where a cancellation request makes no sense. Delivered is excluded on
// purpose — that's a RETURN, not a cancellation — and the message says so.
const NOT_REQUESTABLE = new Set([
  'cancelled', 'refunded', 'refund_pending', 'refund_failed', 'partially_refunded',
]);

function json(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return json(405, { error: 'Method Not Allowed' });

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return json(500, { error: 'Supabase not configured' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Auth ───────────────────────────────────────────────────────────────────
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return json(401, { error: 'Not authenticated' });

  let userEmail;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user?.email) throw new Error('Invalid token');
    userEmail = user.email.toLowerCase();
  } catch {
    return json(401, { error: 'Invalid or expired session. Please sign in again.' });
  }

  // ── Body ───────────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { order_id } = body;
  const reason = String(body.reason || '').trim().slice(0, 500);
  if (!order_id) return json(400, { error: 'Missing order_id' });

  // ── Fetch & verify ownership ────────────────────────────────────────────────
  const { data: order, error: fetchErr } = await supabase
    .from('orders').select('*').eq('id', order_id).maybeSingle();
  if (fetchErr || !order) return json(404, { error: 'Order not found' });
  if ((order.customer_email || '').toLowerCase() !== userEmail)
    return json(403, { error: 'You do not have permission to change this order' });

  const status = String(order.status || '').toLowerCase();

  if (NOT_REQUESTABLE.has(status)) {
    const msg = status === 'cancelled'  ? 'This order is already cancelled.'
              : status.startsWith('refund') || status === 'partially_refunded'
                ? 'A refund is already in progress for this order.'
              : 'This order cannot be cancelled at this stage.';
    return json(422, { error: msg });
  }
  if (status === 'delivered') {
    return json(422, { error: 'This order has already been delivered. Please use the Return option instead.' });
  }

  // Idempotent: don't spam the owner if they already asked.
  if (order.cancellation_requested_at) {
    return json(200, {
      success: true,
      already: true,
      message: 'We already have your cancellation request for this order and our team is reviewing it. The order is not cancelled yet — we\'ll be in touch.',
    });
  }

  const orderId = order.razorpay_order_id || order.id;
  const requestedAt = new Date().toISOString();

  // ── Record the request (best-effort; feature still works pre-migration) ──────
  // Never changes status / refunds / touches the courier. If the columns aren't
  // present yet (sql/orders_cancellation_request.sql not run), we still alert the
  // owner so nothing is lost — the persisted flag is a nice-to-have on top.
  let persisted = false;
  try {
    const { error: updErr } = await supabase
      .from('orders')
      .update({ cancellation_requested_at: requestedAt, cancellation_request_note: reason || null })
      .eq('id', order.id);
    if (updErr) throw updErr;
    persisted = true;
  } catch (e) {
    console.warn('[request-cancellation] persist skipped (run sql/orders_cancellation_request.sql?):', e.message);
  }

  // ── Alert the store owner (email + WhatsApp; best-effort) ────────────────────
  const amountRs = order.amount_paise ? Math.round(order.amount_paise / 100) : 0;
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const bookList = items.map(i => i.title || i.name).filter(Boolean).join(', ') || '—';
  const payLabel = String(order.status).includes('cod') ? 'COD' : (order.razorpay_payment_id ? 'Prepaid (paid)' : 'Prepaid');

  const ownerEmail = process.env.STORE_OWNER_EMAIL || process.env.ADMIN_EMAIL;
  if (ownerEmail) {
    try {
      await sendEmail({
        to: ownerEmail,
        subject: `⚠️ Cancellation REQUEST — ${orderId} (${status})`,
        html: `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:24px;color:#20252b;">
          <h2 style="color:#b56b12;margin:0 0 4px;">Customer requested a cancellation</h2>
          <p style="font-size:13px;color:#6f6255;margin:0 0 16px;">This is a request only — <strong>no automatic cancellation, refund or courier action has been taken.</strong> Review and act from the Orders tab.</p>
          <table style="font-size:14px;border-collapse:collapse;">
            <tr><td style="padding:4px 12px 4px 0;color:#6f6255;">Order</td><td><strong>${orderId}</strong></td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#6f6255;">Current status</td><td>${status}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#6f6255;">Payment</td><td>${payLabel} · ₹${amountRs.toLocaleString('en-IN')}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#6f6255;">Customer</td><td>${order.customer_name || '—'} · ${order.customer_phone || '—'}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#6f6255;">Books</td><td>${bookList}</td></tr>
            ${order.tracking_id ? `<tr><td style="padding:4px 12px 4px 0;color:#6f6255;">AWB</td><td>${order.tracking_id}${order.courier_name ? ' · ' + order.courier_name : ''}</td></tr>` : ''}
            <tr><td style="padding:4px 12px 4px 0;color:#6f6255;">Reason</td><td>${reason ? reason.replace(/[<>]/g, '') : '(none given)'}</td></tr>
          </table>
        </div>`,
      });
    } catch (e) { console.error('[request-cancellation] owner email:', e.message); }
  }

  const ownerPhone = process.env.STORE_OWNER_PHONE;
  if (ownerPhone) {
    try {
      await sendText(ownerPhone,
        `⚠️ Cancellation REQUEST (review — not auto-cancelled)\n🆔 ${orderId}\n📦 Status: ${status}\n💳 ${payLabel} · ₹${amountRs.toLocaleString('en-IN')}\n👤 ${order.customer_name || '—'} · ${order.customer_phone || '—'}\n📚 ${bookList}\n${order.tracking_id ? `🚚 AWB ${order.tracking_id}\n` : ''}📝 ${reason || '(no reason given)'}`);
    } catch (e) { console.error('[request-cancellation] owner WA:', e.message); }
  }

  return json(200, {
    success: true,
    persisted,
    message: 'Your cancellation request has been sent to our team. The order is not cancelled yet — we\'ll review it and get back to you as soon as possible.',
  });
};
