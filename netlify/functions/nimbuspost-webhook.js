/**
 * Netlify Function: nimbuspost-webhook
 * POST /.netlify/functions/nimbuspost-webhook
 *
 * Receives real-time shipment status updates from NimbusPost.
 * NimbusPost pulls status from Delhivery and pushes here automatically.
 *
 * Setup (one-time in NimbusPost → Settings → Webhooks → Add):
 *   Delivery URL: https://inkandchai.in/.netlify/functions/nimbuspost-webhook
 *   Secret: set any secret string, add same to Netlify env as NIMBUSPOST_WEBHOOK_SECRET
 *   Status: Active
 *
 * NimbusPost payload format:
 * {
 *   "awb_number": "4152912381315",
 *   "status": "out for delivery",
 *   "event_time": "2021-02-26 16:19:59",
 *   "location": "Delhi",
 *   "message": "Out for delivery",
 *   "rto_awb": ""
 * }
 *
 * Webhook verification: X-Hmac-SHA256 header
 * base64( hmac_sha256(raw_body, secret) )
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { sendWhatsApp }  = require('./utils/whatsapp');

// ── NimbusPost status string → internal status ────────────────────────────
const STATUS_MAP = {
  'out for delivery':          'out_for_delivery',
  'out_for_delivery':          'out_for_delivery',
  'delivered':                 'delivered',
  'shipment delivered':        'delivered',
  'delivery done':             'delivered',
  'in transit':                null,   // ignore — no customer notification needed
  'reached at hub':            null,
  'reached nearest hub':       null,
  'manifested':                null,
  'pickup scheduled':          null,
  'pickup pending':            null,
  'picked up':                 null,
  'shipped':                   null,
  'rto':                       'rto',
  'rto initiated':             'rto',
  'rto in transit':            'rto',
  'rto delivered':             'rto',
  'undelivered':               'undelivered',
  'ndr':                       'undelivered',
  'delivery failed':           'undelivered',
  'cancelled':                 'cancelled',
  'lost':                      'lost',
};

function normalizeStatus(statusStr) {
  if (!statusStr) return null;
  return STATUS_MAP[statusStr.toLowerCase().trim()] ?? null;
}

// ── WhatsApp notifications ────────────────────────────────────────────────
async function sendOFDNotification(order) {
  if (!order.customer_phone) return;
  const firstName = (order.customer_name || 'there').split(' ')[0];
  const items     = Array.isArray(order.cart_items) ? order.cart_items : [];
  const bookTitle = items[0]?.title || 'your book';
  const isCOD     = !order.razorpay_payment_id || ['cod_pending','partial_cod_pending'].includes(order.status);
  const total     = order.amount_paise ? `₹${(order.amount_paise / 100).toLocaleString('en-IN')}` : '';
  const trackUrl  = order.tracking_url
    || `https://inkandchai.in/track/?id=${encodeURIComponent(order.razorpay_order_id || order.id)}`;

  await sendWhatsApp({
    to: order.customer_phone,
    template: 'order_out_for_delivery',
    params: [
      firstName,
      bookTitle,
      isCOD ? `Please keep ${total} cash ready for delivery` : 'All set — no payment needed at door!',
      trackUrl,
    ],
  });
}

async function sendDeliveredNotification(order) {
  if (!order.customer_phone) return;
  const firstName = (order.customer_name || 'there').split(' ')[0];
  const reviewUrl = `https://inkandchai.in/review/?order=${encodeURIComponent(order.razorpay_order_id || order.id)}`;

  await sendWhatsApp({
    to: order.customer_phone,
    template: 'order_delivered',
    params: [firstName, reviewUrl],
  });
}

async function notifyOwnerIssue(order, status, message, location) {
  const ownerPhone = process.env.STORE_OWNER_PHONE;
  if (!ownerPhone) return;
  const orderId = order.razorpay_order_id || order.id;
  const text = `⚠️ Delivery issue — ${status.toUpperCase()}\nOrder: ${orderId}\nCustomer: ${order.customer_name} · ${order.customer_phone}\nAWB: ${order.tracking_id || '—'}\nLocation: ${location || '—'}\nMsg: ${message || '—'}`;

  const phoneId = process.env.WHATSAPP_PHONE_ID || '1188708014316574';
  const token   = process.env.WHATSAPP_TOKEN;
  if (!token) return;

  const normOwner = ownerPhone.replace(/\D/g,'').replace(/^0/,'91').replace(/^(\d{10})$/, '91$1');
  await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: normOwner,
      type: 'text',
      text: { body: text },
    }),
  }).catch(e => console.error('notifyOwnerIssue error:', e.message));
}

// ── Main handler ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  // ── Verify HMAC-SHA256 signature ─────────────────────────────────────────
  const secret = process.env.NIMBUSPOST_WEBHOOK_SECRET;
  if (secret) {
    const received = event.headers['x-hmac-sha256'] || '';
    const expected = crypto
      .createHmac('sha256', secret)
      .update(event.body)
      .digest('base64');
    if (received !== expected) {
      console.warn('NimbusPost webhook: signature mismatch');
      return { statusCode: 403, body: 'Forbidden' };
    }
  }

  // Parse — NimbusPost may send single object or array
  let payloads;
  try {
    const parsed = JSON.parse(event.body);
    payloads = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return { statusCode: 400, body: 'Bad JSON' };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  for (const evt of payloads) {
    try {
      const awb      = (evt.awb_number || evt.awb || '').toString().trim();
      const rawStatus = evt.status || '';
      const location  = evt.location || '';
      const message   = evt.message || '';
      const ourStatus = normalizeStatus(rawStatus);

      console.log(`[NimbusPost] AWB:${awb} Status:"${rawStatus}" → ${ourStatus || 'ignored'}`);

      if (!ourStatus) continue;  // status we don't act on (in transit, etc.)
      if (!awb) { console.warn('[NimbusPost] No AWB in payload'); continue; }

      // Find order by AWB tracking_id
      const { data: order } = await supabase
        .from('orders')
        .select('*')
        .eq('tracking_id', awb)
        .maybeSingle();

      if (!order) {
        console.warn(`[NimbusPost] No order found for AWB: ${awb}`);
        continue;
      }

      // Guard against backwards transitions
      const RANK = { shipped:1, out_for_delivery:2, delivered:3, cancelled:0, undelivered:0, rto:0, lost:0 };
      const currentRank = RANK[order.status] || 0;
      const newRank     = RANK[ourStatus]    || 0;
      if (newRank > 0 && newRank <= currentRank) {
        console.log(`[NimbusPost] Skip — already at ${order.status}`);
        continue;
      }

      // Update Supabase
      const updateData = { status: ourStatus };
      if (ourStatus === 'delivered') updateData.delivered_at = new Date().toISOString();
      await supabase.from('orders').update(updateData).eq('id', order.id);
      console.log(`[NimbusPost] Order ${order.razorpay_order_id || order.id} → ${ourStatus}`);

      // Notify
      if (ourStatus === 'out_for_delivery') {
        await sendOFDNotification(order);
      } else if (ourStatus === 'delivered') {
        await sendDeliveredNotification(order);
      } else if (['undelivered', 'rto', 'lost'].includes(ourStatus)) {
        await notifyOwnerIssue(order, ourStatus, message, location);
      }

    } catch (err) {
      console.error('[NimbusPost] Error:', err.message);
    }
  }

  return { statusCode: 200, body: 'OK' };
};
