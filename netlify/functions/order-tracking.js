/**
 * Netlify Function: shiprocket-webhook
 * POST /.netlify/functions/shiprocket-webhook
 *
 * Receives real-time shipment status updates from Shiprocket and:
 *   1. Updates the order status in Supabase
 *   2. Sends WhatsApp notification to the customer
 *   3. Notifies store owner on NDR / delivery failure
 *
 * One-time Shiprocket setup:
 *   Dashboard → Settings → Webhooks → Add Webhook
 *   URL: https://inkandchai.in/.netlify/functions/shiprocket-webhook
 *   Events: All shipment status events
 *
 * Optional env var:
 *   SHIPROCKET_WEBHOOK_SECRET — if set, Shiprocket must send it as X-Shiprocket-Token
 *
 * Status flow:
 *   AWB Assigned / Pickup Scheduled → save AWB to DB (no notification yet)
 *   Shipped / In Transit            → status=shipped, WhatsApp "shipped" message with tracking
 *   Out for Delivery                → status=out_for_delivery, WhatsApp OFD message
 *   Delivered                       → status=delivered, WhatsApp delivery + review link
 *   NDR / Undelivered / RTO         → status=undelivered/rto, WhatsApp owner alert
 */

const { createClient } = require('@supabase/supabase-js');
const { sendWhatsApp }  = require('./utils/whatsapp');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Shiprocket-Token',
  'Content-Type': 'application/json',
};

// ── Status string → our internal status ──────────────────────────────────────
// Shiprocket sends inconsistent strings; normalise aggressively.
const STATUS_MAP = {
  // Shipped / In transit
  'shipped':                    'shipped',
  'in transit':                 'shipped',
  'intransit':                  'shipped',
  'in_transit':                 'shipped',
  'dispatched':                 'shipped',
  'picked up':                  'shipped',
  'picked_up':                  'shipped',
  'out of delivery area':       'shipped',

  // Out for delivery
  'out for delivery':           'out_for_delivery',
  'out_for_delivery':           'out_for_delivery',
  'ofd':                        'out_for_delivery',

  // Delivered
  'delivered':                  'delivered',
  'shipment delivered':         'delivered',
  'delivery confirmed':         'delivered',
  'pod available':              'delivered',
  'delivery successful':        'delivered',
  'successfully delivered':     'delivered',

  // NDR / failed
  'ndr':                        'undelivered',
  'undelivered':                'undelivered',
  'delivery failed':            'undelivered',
  'delivery attempt failed':    'undelivered',
  'not delivered':              'undelivered',
  'delivery exception':         'undelivered',

  // RTO
  'rto initiated':              'rto',
  'rto delivered':              'rto',
  'return to origin':           'rto',
  'rto':                        'rto',

  // Terminal
  'lost':                       'lost',
  'cancelled':                  'cancelled',
  'shipment cancelled':         'cancelled',
};

// Shiprocket numeric status codes (more reliable than strings)
const STATUS_CODE_MAP = {
  4:  'awb_assigned',    // Pickup scheduled — save AWB, no status change
  5:  'awb_assigned',    // Out for pickup
  6:  'shipped',         // Shipped
  7:  'delivered',       // Delivered
  8:  'shipped',         // In transit
  9:  'cancelled',
  13: 'undelivered',     // NDR
  14: 'lost',
  15: 'out_for_delivery',
  17: 'out_for_delivery',
  18: 'out_for_delivery',
  19: 'undelivered',
  22: 'rto',
};

function normalizeStatus(statusStr, statusCode) {
  // Try string map first (more descriptive)
  if (statusStr) {
    const key = statusStr.toLowerCase().trim();
    const mapped = STATUS_MAP[key];
    if (mapped) return mapped;

    // Fuzzy: "in transit" variants
    if (/\bin.transit\b|\bshipped\b|\bin.shipment\b/.test(key) &&
        !/rto|return|cancel|fail|ndr/.test(key)) return 'shipped';

    // Fuzzy: "out for delivery"
    if (/out.for.delivery|ofd/.test(key)) return 'out_for_delivery';

    // Fuzzy: "delivered"
    if (/\bdelivered\b|\bpod\b/.test(key) &&
        !/not|fail|attempt|ndr|undeliver|rto|out.for/.test(key)) return 'delivered';
  }

  // Fall back to code
  if (statusCode !== undefined && statusCode !== null) {
    const mapped = STATUS_CODE_MAP[parseInt(statusCode)];
    if (mapped) return mapped;
  }

  return null;
}

// ── Build Shiprocket tracking URL ─────────────────────────────────────────────
function buildTrackingUrl(awb, courierName) {
  if (!awb) return '';
  const courier = (courierName || '').toLowerCase();
  const np = `https://ship.nimbuspost.com/shipping/tracking/${awb}`;
  // Couriers that track via NimbusPost portal
  if (courier.includes('bluedart'))      return np;
  if (courier.includes('amazon'))        return np;
  // Other couriers — direct tracking pages
  if (courier.includes('delhivery'))     return `https://www.delhivery.com/track/package/${awb}`;
  if (courier.includes('xpressbees'))    return `https://www.xpressbees.com/shipment/tracking?awb=${awb}`;
  if (courier.includes('ecom'))          return `https://ecomexpress.in/tracking/?awb_field=${awb}`;
  if (courier.includes('shadowfax'))     return `https://tracker.shadowfax.in/?awb=${awb}`;
  if (courier.includes('dtdc'))          return np;
  if (courier.includes('ekart'))         return np;  // ekartlogistics page only works for Flipkart-booked AWBs; B2B routes via NimbusPost
  // Fallback: NimbusPost (works for most couriers booked via NimbusPost)
  return np;
}

// ── WhatsApp notifications ────────────────────────────────────────────────────
async function sendShippedNotification(order) {
  if (!order.customer_phone) return;
  const firstName = (order.customer_name || 'there').split(' ')[0];
  const trackUrl  = order.tracking_url ||
    `https://inkandchai.in/track/?id=${encodeURIComponent(order.razorpay_order_id || order.id)}`;
  const awb       = order.tracking_id || '';
  const courier   = order.courier_name || '';
  const items     = Array.isArray(order.cart_items) ? order.cart_items : [];
  const bookTitle = items[0]?.title || 'your books';

  // Template: order_shipped
  // Body: "Hi {{1}}! 📦 Your Ink & Chai order has been shipped!\nBook: {{2}}\nCourier: {{3}} | AWB: {{4}}\nTrack here: {{5}}"
  await sendWhatsApp({
    to: order.customer_phone,
    template: 'order_shipped',
    params: [firstName, bookTitle, courier || 'courier', awb || '—', trackUrl],
  }).catch(e => console.error('[ShiprocketWebhook] WhatsApp shipped error:', e.message));
}

async function sendOFDNotification(order) {
  if (!order.customer_phone) return;
  const firstName = (order.customer_name || 'there').split(' ')[0];
  const items     = Array.isArray(order.cart_items) ? order.cart_items : [];
  const bookTitle = items[0]?.title || 'your book';
  const isCOD     = ['cod_pending', 'partial_cod_pending'].includes(order.status) ||
                    !order.razorpay_payment_id;
  const total     = order.amount_paise
    ? `₹${(order.amount_paise / 100).toLocaleString('en-IN')}`
    : '';
  const trackUrl  = order.tracking_url ||
    `https://inkandchai.in/track/?id=${encodeURIComponent(order.razorpay_order_id || order.id)}`;

  // Template: order_out_for_delivery
  await sendWhatsApp({
    to: order.customer_phone,
    template: 'order_out_for_delivery',
    params: [
      firstName,
      bookTitle,
      isCOD ? `${total} cash ready` : 'all set — enjoy your books!',
      trackUrl,
    ],
  }).catch(e => console.error('[ShiprocketWebhook] WhatsApp OFD error:', e.message));
}

async function sendDeliveredNotification(order) {
  if (!order.customer_phone) return;
  const firstName = (order.customer_name || 'there').split(' ')[0];
  const reviewUrl = `https://inkandchai.in/review/?order=${encodeURIComponent(order.razorpay_order_id || order.id)}`;

  // Template: order_delivered
  await sendWhatsApp({
    to: order.customer_phone,
    template: 'order_delivered',
    params: [firstName, reviewUrl],
  }).catch(e => console.error('[ShiprocketWebhook] WhatsApp delivered error:', e.message));
}

async function notifyOwnerNDR(order, rawStatus) {
  const ownerPhone = process.env.STORE_OWNER_PHONE;
  if (!ownerPhone) return;
  const orderId = order.razorpay_order_id || order.id;
  const msg = `⚠️ Delivery issue on inkandchai.in\n\nOrder: ${orderId}\nCustomer: ${order.customer_name || '—'} · ${order.customer_phone || '—'}\nAWB: ${order.tracking_id || '—'}\nCourier: ${order.courier_name || '—'}\nStatus: ${rawStatus}\n\nCheck admin panel to reattempt delivery.`;

  const phone = process.env.WHATSAPP_PHONE_ID || '';
  const token = process.env.WHATSAPP_TOKEN || '';
  if (!token || !phone) return;

  await fetch(`https://graph.facebook.com/v20.0/${phone}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: ownerPhone.replace(/\D/g,'').replace(/^(\d{10})$/, '91$1'),
      type: 'text',
      text: { body: msg },
    }),
  }).catch(e => console.error('[ShiprocketWebhook] notifyOwnerNDR error:', e.message));
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  // Optional token verification
  const secret = process.env.SHIPROCKET_WEBHOOK_SECRET;
  if (secret) {
    const received = event.headers['x-shiprocket-token'] || event.headers['authorization'] || '';
    if (!received.includes(secret)) {
      console.warn('[ShiprocketWebhook] Invalid token — blocked');
      return { statusCode: 403, body: 'Forbidden' };
    }
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Bad JSON' }; }

  // Shiprocket sends either a single object or an array of events
  const events = Array.isArray(payload) ? payload : [payload];

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  for (const evt of events) {
    try {
      // Extract fields (Shiprocket field names vary by webhook version)
      const awb             = (evt.awb || evt.awb_code || evt.tracking_id || '').trim();
      const channelOrderId  = (evt.channel_order_id || evt.order_id || '').trim();
      const srOrderId       = evt.shipment_id || evt.sr_order_id || '';
      const rawStatus       = (evt.current_status || evt.status || evt.shipment_status || '').trim();
      const statusCode      = evt.current_status_id || evt.status_code;
      const courierName     = evt.courier_name || evt.courier || '';
      const etd             = evt.etd || '';  // Estimated delivery date

      const ourStatus = normalizeStatus(rawStatus, statusCode);

      console.log(`[Shiprocket] AWB:${awb} Order:${channelOrderId} Status:"${rawStatus}"(${statusCode}) → ${ourStatus || 'ignored'}`);

      // Find the order — try IC- order ID first, then AWB, then Shiprocket order ID
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
          .from('orders').select('*').eq('tracking_id', awb).maybeSingle();
        order = data;
      }
      if (!order && srOrderId) {
        const { data } = await supabase
          .from('orders').select('*').eq('shiprocket_order_id', String(srOrderId)).maybeSingle();
        order = data;
      }

      if (!order) {
        console.warn(`[Shiprocket] Order not found — AWB:${awb} / IC:${channelOrderId} / SR:${srOrderId}`);
        continue;
      }

      // ── Always save AWB + courier when we get it ──────────────────────────
      const trackingUrl = awb ? buildTrackingUrl(awb, courierName) : (order.tracking_url || '');
      const awbUpdate = {};
      if (awb && awb !== order.tracking_id)          awbUpdate.tracking_id  = awb;
      if (courierName && !order.courier_name)         awbUpdate.courier_name = courierName;
      if (trackingUrl && !order.tracking_url)         awbUpdate.tracking_url = trackingUrl;
      if (srOrderId && !order.shiprocket_order_id)    awbUpdate.shiprocket_order_id = String(srOrderId);

      if (Object.keys(awbUpdate).length > 0) {
        await supabase.from('orders').update(awbUpdate).eq('id', order.id);
        // Merge for use in notifications below
        Object.assign(order, awbUpdate);
        console.log(`[Shiprocket] Saved tracking info for ${order.razorpay_order_id}:`, awbUpdate);
      }

      // ── Skip if no actionable status ─────────────────────────────────────
      if (!ourStatus || ourStatus === 'awb_assigned') {
        console.log(`[Shiprocket] AWB saved, status "${rawStatus}" is pre-ship — no status update needed`);
        continue;
      }

      // ── Don't regress status (e.g. don't set shipped if already delivered) ─
      const STATUS_RANK = {
        shipped:1, out_for_delivery:2, delivered:3,
        cancelled:0, undelivered:0, rto:0, lost:0,
      };
      const currentRank = STATUS_RANK[order.status] || 0;
      const newRank     = STATUS_RANK[ourStatus]    || 0;
      if (newRank > 0 && newRank <= currentRank && ourStatus !== 'undelivered') {
        console.log(`[Shiprocket] Skip — already at ${order.status}, new=${ourStatus}`);
        continue;
      }

      // ── Update order status in Supabase ──────────────────────────────────
      const statusUpdate = { status: ourStatus };
      if (ourStatus === 'delivered') statusUpdate.delivered_at = new Date().toISOString();
      if (ourStatus === 'shipped')   statusUpdate.shipped_at   = new Date().toISOString();

      const { error: updateErr } = await supabase
        .from('orders').update(statusUpdate).eq('id', order.id);

      if (updateErr) {
        console.error(`[Shiprocket] DB update failed for ${order.razorpay_order_id}:`, updateErr.message);
      } else {
        console.log(`[Shiprocket] ✅ Updated ${order.razorpay_order_id} → ${ourStatus}`);
      }

      // Merge status update for notifications
      order.status = ourStatus;

      // ── Send customer notification ────────────────────────────────────────
      if (ourStatus === 'shipped') {
        await sendShippedNotification(order);
      } else if (ourStatus === 'out_for_delivery') {
        await sendOFDNotification(order);
      } else if (ourStatus === 'delivered') {
        await sendDeliveredNotification(order);
      } else if (ourStatus === 'undelivered' || ourStatus === 'rto') {
        await notifyOwnerNDR(order, rawStatus);
      }

    } catch (err) {
      console.error('[Shiprocket] Event error:', err.message, JSON.stringify(evt).slice(0, 300));
    }
  }

  return { statusCode: 200, body: 'OK' };
};
