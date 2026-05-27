/**
 * Netlify Function: shiprocket-webhook
 * POST /.netlify/functions/shiprocket-webhook
 *
 * Receives real-time shipment status updates from Shiprocket.
 * Shiprocket pulls status from Delhivery/other couriers and pushes here.
 *
 * Setup (one-time in Shiprocket Dashboard):
 *   Settings → Webhooks → Add Webhook
 *   URL: https://inkandchai.in/.netlify/functions/shiprocket-webhook
 *   Events: Shipment status updates
 *
 * Optional: set SHIPROCKET_WEBHOOK_SECRET env var and Shiprocket will
 * send it as X-Shiprocket-Token header for verification.
 *
 * Status flow triggered:
 *   Shipped          → already handled by admin panel
 *   Out for Delivery → updates DB + sends WhatsApp OFD notification
 *   Delivered        → updates DB + sends WhatsApp delivery confirmation + review link
 *   NDR / Failed     → updates DB + notifies store owner
 */

const { createClient } = require('@supabase/supabase-js');
const { sendWhatsApp }  = require('./utils/whatsapp');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Shiprocket-Token',
  'Content-Type': 'application/json',
};

// ── Shiprocket status code → our internal status ──────────────────────────
// https://apidocs.shiprocket.in/#tag/Tracking/operation/ShipmentTrackingV2
const STATUS_MAP = {
  // Shiprocket status strings (normalized to lowercase)
  'out for delivery':     'out_for_delivery',
  'out_for_delivery':     'out_for_delivery',
  'delivered':            'delivered',
  'shipment delivered':   'delivered',
  'undelivered':          'undelivered',
  'ndr':                  'undelivered',
  'rto initiated':        'rto',
  'rto delivered':        'rto',
  'lost':                 'lost',
  'cancelled':            'cancelled',
};

// Status codes (numeric) from Shiprocket
const STATUS_CODE_MAP = {
  6:  'shipped',
  7:  'delivered',
  18: 'out_for_delivery',
  9:  'cancelled',
  13: 'undelivered',  // NDR
  22: 'rto',
};

function normalizeStatus(statusStr, statusCode) {
  if (statusStr) {
    const mapped = STATUS_MAP[statusStr.toLowerCase().trim()];
    if (mapped) return mapped;
  }
  if (statusCode !== undefined && statusCode !== null) {
    const mapped = STATUS_CODE_MAP[parseInt(statusCode)];
    if (mapped) return mapped;
  }
  return null;
}

// ── WhatsApp message builders ─────────────────────────────────────────────
async function sendOFDNotification(order) {
  if (!order.customer_phone) return;
  const firstName = (order.customer_name || 'there').split(' ')[0];
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const bookTitle = items[0]?.title || 'your book';
  const isCOD = !order.razorpay_payment_id || order.status === 'cod_pending';
  const total = order.amount_paise ? `₹${(order.amount_paise / 100).toLocaleString('en-IN')}` : '';

  // WhatsApp template: order_out_for_delivery
  // Template body: "Hi {{1}}! 🚚 Your order is out for delivery today. {{2}} Keep {{3}} ready. Track: {{4}}"
  const trackUrl = order.tracking_url || `https://inkandchai.in/track/?id=${encodeURIComponent(order.razorpay_order_id || order.id)}`;

  await sendWhatsApp({
    to: order.customer_phone,
    template: 'order_out_for_delivery',
    params: [
      firstName,
      bookTitle,
      isCOD ? `₹${total} cash ready for delivery` : 'all set — enjoy your books!',
      trackUrl,
    ],
  });
}

async function sendDeliveredNotification(order) {
  if (!order.customer_phone) return;
  const firstName = (order.customer_name || 'there').split(' ')[0];
  const reviewUrl = `https://inkandchai.in/review/?order=${encodeURIComponent(order.razorpay_order_id || order.id)}`;

  // WhatsApp template: order_delivered
  // Template body: "Hi {{1}}! 📚 Your Ink & Chai order has been delivered. Hope you love it! Leave a quick review: {{2}}"
  await sendWhatsApp({
    to: order.customer_phone,
    template: 'order_delivered',
    params: [firstName, reviewUrl],
  });
}

async function notifyOwnerNDR(order, rawStatus) {
  const ownerPhone = process.env.STORE_OWNER_PHONE;
  if (!ownerPhone) return;
  const orderId = order.razorpay_order_id || order.id;
  const msg = `⚠️ Delivery issue\nOrder: ${orderId}\nCustomer: ${order.customer_name} · ${order.customer_phone}\nAWB: ${order.tracking_id || '—'}\nStatus: ${rawStatus}`;
  // Send plain WhatsApp text to owner (not template)
  const phone = process.env.WHATSAPP_PHONE_ID || '1188708014316574';
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) return;
  await fetch(`https://graph.facebook.com/v20.0/${phone}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: ownerPhone.replace(/\D/g,'').replace(/^0/,'91').replace(/^(\d{10})$/,'91$1'),
      type: 'text',
      text: { body: msg },
    }),
  }).catch(e => console.error('notifyOwnerNDR error:', e.message));
}

// ── Main handler ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  // Optional token verification
  const secret = process.env.SHIPROCKET_WEBHOOK_SECRET;
  if (secret) {
    const receivedToken = event.headers['x-shiprocket-token'] || event.headers['authorization'] || '';
    if (!receivedToken.includes(secret)) {
      console.warn('Shiprocket webhook: invalid token');
      return { statusCode: 403, body: 'Forbidden' };
    }
  }

  let payload;
  try { payload = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: 'Bad JSON' }; }

  // Shiprocket sends either a single object or an array
  const events = Array.isArray(payload) ? payload : [payload];

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  for (const evt of events) {
    try {
      // Shiprocket field names (vary slightly by webhook version)
      const awb            = evt.awb || evt.awb_code || evt.tracking_id || '';
      const channelOrderId = evt.channel_order_id || evt.order_id || '';  // IC-YYYYMMDD-XXXXX
      const rawStatus      = evt.current_status || evt.status || evt.shipment_status || '';
      const statusCode     = evt.current_status_id || evt.status_code;

      const ourStatus = normalizeStatus(rawStatus, statusCode);

      console.log(`[Shiprocket] AWB:${awb} Order:${channelOrderId} Status:"${rawStatus}" → ${ourStatus || 'ignored'}`);

      // Only act on statuses we care about
      if (!ourStatus || ourStatus === 'shipped') continue;

      // Find the order — try channel_order_id first (IC-XXXXX), then AWB
      let order = null;
      if (channelOrderId) {
        const { data } = await supabase
          .from('orders')
          .select('*')
          .or(`razorpay_order_id.eq.${channelOrderId},id.eq.${channelOrderId}`)
          .maybeSingle();
        order = data;
      }
      if (!order && awb) {
        const { data } = await supabase
          .from('orders')
          .select('*')
          .eq('tracking_id', awb)
          .maybeSingle();
        order = data;
      }

      if (!order) {
        console.warn(`[Shiprocket] Order not found for AWB:${awb} / OrderId:${channelOrderId}`);
        continue;
      }

      // Don't go backwards (e.g. don't set shipped if already delivered)
      const STATUS_RANK = { shipped:1, out_for_delivery:2, delivered:3, cancelled:0, undelivered:0, rto:0, lost:0 };
      const currentRank = STATUS_RANK[order.status] || 0;
      const newRank     = STATUS_RANK[ourStatus] || 0;
      if (newRank > 0 && newRank <= currentRank && ourStatus !== 'undelivered') {
        console.log(`[Shiprocket] Skipping ${ourStatus} — already at ${order.status}`);
        continue;
      }

      // Update order status in Supabase
      const updatePayload = { status: ourStatus };
      if (ourStatus === 'delivered') {
        updatePayload.delivered_at = new Date().toISOString();
      }
      await supabase.from('orders').update(updatePayload).eq('id', order.id);
      console.log(`[Shiprocket] Updated order ${order.razorpay_order_id || order.id} → ${ourStatus}`);

      // Send customer notifications
      if (ourStatus === 'out_for_delivery') {
        await sendOFDNotification(order);
      } else if (ourStatus === 'delivered') {
        await sendDeliveredNotification(order);
      } else if (ourStatus === 'undelivered' || ourStatus === 'rto') {
        await notifyOwnerNDR(order, rawStatus);
      }

    } catch (err) {
      console.error('[Shiprocket] Event processing error:', err.message, JSON.stringify(evt).slice(0, 200));
    }
  }

  return { statusCode: 200, body: 'OK' };
};
