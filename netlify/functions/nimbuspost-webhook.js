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
const { sendEmail }     = require('./utils/email');

// ── NimbusPost status string → internal status ────────────────────────────
// Comprehensive map — NimbusPost / Delhivery use many different strings.
// ALL strings are lowercased before lookup.
const STATUS_MAP = {
  // Out for delivery
  'out for delivery':           'out_for_delivery',
  'out_for_delivery':           'out_for_delivery',
  'ofd':                        'out_for_delivery',
  'with delivery agent':        'out_for_delivery',
  'with delivery boy':          'out_for_delivery',

  // Delivered — every variant NimbusPost / Delhivery / Xpressbees / Amazon use
  'delivered':                  'delivered',
  'shipment delivered':         'delivered',
  'delivery done':              'delivered',
  'delivery successful':        'delivered',
  'successfully delivered':     'delivered',
  'delivered to customer':      'delivered',
  'delivered to consignee':     'delivered',
  'package delivered':          'delivered',
  'parcel delivered':           'delivered',
  'order delivered':            'delivered',
  'delivery completed':         'delivered',
  'delivered at door':          'delivered',
  'delivered at doorstep':      'delivered',
  'delivered - signed':         'delivered',
  'pod available':              'delivered',   // proof of delivery

  // Shipped / dispatched — notify customer with tracking link
  'shipped':                    'shipped',
  'dispatched':                 'shipped',
  'picked up':                  'shipped',
  'pickup done':                'shipped',
  'shipment booked':            'shipped',

  // In-transit / hub scan events — ignore (no customer action needed)
  'in transit':                 null,
  'intransit':                  null,
  'in-transit':                 null,
  'reached at hub':             null,
  'reached nearest hub':        null,
  'reached destination hub':    null,
  'manifested':                 null,
  'pickup scheduled':           null,
  'pickup pending':             null,
  'booked':                     null,
  'in sorting centre':          null,
  'sorting':                    null,

  // Problem states
  'rto':                        'rto',
  'rto initiated':              'rto',
  'rto in transit':             'rto',
  'rto delivered':              'rto',
  'return to origin':           'rto',
  'undelivered':                'undelivered',
  'ndr':                        'undelivered',
  'delivery failed':            'undelivered',
  'delivery attempt failed':    'undelivered',
  'delivery exception':         'undelivered',
  'not delivered':              'undelivered',
  'cancelled':                  'cancelled',
  'lost':                       'lost',
  'shipment lost':              'lost',
};

function normalizeStatus(statusStr) {
  if (!statusStr) return null;
  const lower = statusStr.toLowerCase().trim();
  if (STATUS_MAP[lower] !== undefined) return STATUS_MAP[lower];
  // Fuzzy match: if it contains "deliver" and not "failed/attempt/ndr" → delivered
  if (lower.includes('deliver') && !lower.includes('fail') && !lower.includes('attempt') && !lower.includes('ndr') && !lower.includes('undeliver') && !lower.includes('rto')) {
    if (!lower.includes('out for') && !lower.includes('ofd') && !lower.includes('agent') && !lower.includes('boy')) {
      console.log(`[NimbusPost] Fuzzy-matched "${statusStr}" → delivered`);
      return 'delivered';
    }
  }
  return null;
}

// ── NimbusPost tracking URL ───────────────────────────────────────────────
function npTrackUrl(awb) {
  return `https://ship.nimbuspost.com/shipping/tracking/${awb}`;
}

function emailBase(content) {
  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">inkandchai.in</p>
      ${content}
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai · inkandchai.in · For support, reply to this email.</p>
    </div>`;
}

// ── Shipped: email + WhatsApp ─────────────────────────────────────────────
async function sendShippedNotifications(order, awb) {
  const firstName  = (order.customer_name || 'there').split(' ')[0];
  const orderId    = order.razorpay_order_id || order.id;
  const trackUrl   = npTrackUrl(awb);
  const items      = Array.isArray(order.cart_items) ? order.cart_items : [];
  const bookList   = items.map(i => i.title || i.name || '').filter(Boolean).join(', ') || 'your books';
  const courier    = order.courier_name || 'DTDC Surface';
  const total      = order.amount_paise ? `₹${(order.amount_paise / 100).toLocaleString('en-IN')}` : '';
  const isCOD      = ['cod_pending','partial_cod_pending'].includes(order.status) || !order.razorpay_payment_id;

  // ── Email ────────────────────────────────────────────────────────────────
  if (order.customer_email) {
    await sendEmail({
      to: order.customer_email,
      subject: `📦 Your Ink & Chai order has been shipped! (${orderId})`,
      html: emailBase(`
        <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">Your order is on its way! 📦</h2>
        <p style="color:#a09080;line-height:1.8;margin-bottom:16px;">
          Hi ${firstName}, your books have been dispatched and are heading your way.
        </p>
        <table style="font-size:14px;line-height:1.9;color:#f0e8d8;margin-bottom:20px;">
          <tr><td style="color:#a09080;padding-right:16px;">Order ID</td>  <td style="color:#c9a84c;font-weight:500;">${orderId}</td></tr>
          <tr><td style="color:#a09080;padding-right:16px;">AWB / Tracking</td><td style="color:#c9a84c;font-weight:500;">${awb}</td></tr>
          <tr><td style="color:#a09080;padding-right:16px;">Courier</td>   <td>${courier}</td></tr>
          <tr><td style="color:#a09080;padding-right:16px;">Books</td>     <td>${bookList}</td></tr>
          ${isCOD && total ? `<tr><td style="color:#a09080;padding-right:16px;">Amount due</td><td style="color:#c9a84c;">Please keep ${total} cash ready</td></tr>` : ''}
        </table>
        <div style="margin:20px 0;padding:16px;background:#1c1916;border-left:3px solid #c9a84c;">
          <p style="color:#f0e8d8;font-size:13px;margin:0 0 12px;">📍 Track your shipment in real time</p>
          <a href="${trackUrl}"
             style="display:inline-block;background:#c9a84c;color:#0d0b08;padding:10px 24px;
                    text-decoration:none;font-size:11px;letter-spacing:2px;text-transform:uppercase;
                    font-weight:600;">
            Track Order →
          </a>
          <p style="color:#a09080;font-size:11px;margin:12px 0 0;">
            Or copy this link: <span style="color:#c9a84c;">${trackUrl}</span>
          </p>
        </div>
        <p style="color:#a09080;font-size:13px;line-height:1.8;margin-top:16px;">
          Delivery usually takes <strong style="color:#f0e8d8;">3–7 business days</strong> depending on your location.
          We'll notify you again when the courier is out for delivery.
        </p>
      `),
    }).catch(e => console.error('[NimbusPost] Shipped email error:', e.message));
  }

  // ── WhatsApp ─────────────────────────────────────────────────────────────
  if (order.customer_phone) {
    await sendWhatsApp({
      to: order.customer_phone,
      template: 'order_shipped',
      params: [firstName, bookList, courier, awb, trackUrl],
    }).catch(e => console.error('[NimbusPost] Shipped WhatsApp error:', e.message));
  }
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
  // FAIL CLOSED. Anyone can hit this URL; without the signature check an
  // attacker could mark any AWB as delivered/RTO, fire customer notifications
  // and start the return window. NimbusPost docs require the x-hmac-sha256
  // header for all webhooks — if a real event is ever missing it, surface that
  // in logs and add the source IP to an allowlist instead of failing open.
  const secret = process.env.NIMBUSPOST_WEBHOOK_SECRET;
  if (secret) {
    const received = event.headers['x-hmac-sha256'] || event.headers['X-Hmac-Sha256'] || '';
    const expected = crypto
      .createHmac('sha256', secret)
      .update(event.body || '')
      .digest('base64');
    let ok = false;
    if (received && received.length === expected.length) {
      try {
        ok = crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
      } catch { ok = false; }
    }
    if (!ok) {
      console.warn(`NimbusPost webhook: signature invalid (received=${received.slice(0,12)}…) — rejecting`);
      return { statusCode: 403, body: 'Invalid signature' };
    }
  } else {
    console.error('NIMBUSPOST_WEBHOOK_SECRET not set — rejecting webhook to stay safe');
    return { statusCode: 503, body: 'Webhook secret not configured' };
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

      console.log(`[NimbusPost] AWB:${awb} RawStatus:"${rawStatus}" → mapped:"${ourStatus || 'IGNORED'}" | msg:${message} | loc:${location}`);

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

      // Update Supabase — save tracking URL when shipped
      const trackingUrl = npTrackUrl(awb);
      const updateData = { status: ourStatus };
      if (ourStatus === 'shipped') {
        updateData.tracking_url = trackingUrl;
        updateData.shipped_at   = new Date().toISOString();
        if (!order.courier_name) updateData.courier_name = 'DTDC Surface';
      }
      if (ourStatus === 'delivered') updateData.delivered_at = new Date().toISOString();

      await supabase.from('orders').update(updateData).eq('id', order.id);
      // Merge for notification use
      Object.assign(order, updateData);
      console.log(`[NimbusPost] ✅ Order ${order.razorpay_order_id || order.id} → ${ourStatus}`);

      // Notify
      if (ourStatus === 'shipped') {
        await sendShippedNotifications(order, awb);
      } else if (ourStatus === 'out_for_delivery') {
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
