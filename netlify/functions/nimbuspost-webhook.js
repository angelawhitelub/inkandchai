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
const { notifyOrderCancelled } = require('./utils/order-cancelled-notification');
const {
  npTrackUrl,
  emailBase,
  sendInTransitNotifications,
  sendOFDNotification,
  sendDeliveredNotification,
} = require('./utils/delivery-notifications');
const { handleReturnAwbDelivered } = require('./utils/return-auto-refund');

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
  // "picked" is what NimbusPost actually sends on the first movement scan —
  // confirmed against /shipments/track/bulk, which reports status:"picked" and a
  // history entry status_code:"PICKED". Only the "picked up" spelling was mapped
  // here, so every real pickup event fell through the `if (!ourStatus) continue`
  // below and nothing — not even last_nimbuspost_status — was recorded. That is
  // how a picked-up parcel still looked cancellable.
  'picked':                     'shipped',
  'picked up':                  'shipped',
  'shipment picked up':         'shipped',
  'pickup done':                'shipped',
  'shipment booked':            null,

  // In-transit / hub scan events — notify the customer ONCE (see in_transit
  // handling in the loop; deduped via orders.in_transit_notified_at so the many
  // repeated hub scans don't spam them). These never change order.status.
  'in transit':                 'in_transit',
  'intransit':                  'in_transit',
  'in-transit':                 'in_transit',
  'reached at hub':             'in_transit',
  'reached nearest hub':        'in_transit',
  'reached destination hub':    'in_transit',
  'in sorting centre':          'in_transit',
  'sorting':                    'in_transit',
  'spd':                        'in_transit', // shipment received at origin centre

  // Pre-transit scans — still ignore (no customer-facing meaning yet)
  'manifested':                 null,
  'pickup scheduled':           null,
  'pickup pending':             null,
  'booked':                     null,

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

function eventTimestamp(evt) {
  const raw = evt?.event_time || evt?.timestamp || evt?.updated_at;
  if (raw) {
    const parsed = new Date(raw);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

// npTrackUrl + emailBase are imported from ./utils/delivery-notifications

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
        // Not a forward order — this AWB may be a REVERSE (return) shipment.
        // When a return is scanned delivered back to us, auto-refund the prepaid
        // customer (deterministic trigger; guarded + idempotent inside).
        if (ourStatus === 'delivered') {
          try {
            const r = await handleReturnAwbDelivered(supabase, awb);
            if (r.matched) { console.log(`[NimbusPost] Return AWB ${awb} delivered → ${JSON.stringify(r)}`); continue; }
          } catch (e) { console.error('[NimbusPost] return auto-refund error:', e.message); }
        }
        console.warn(`[NimbusPost] No order found for AWB: ${awb}`);
        continue;
      }

      // ── In transit ─────────────────────────────────────────────────────────
      // Hub scans repeat many times; notify the customer exactly once and never
      // touch order.status (so admin filters/revenue are unaffected). Dedup is
      // durable via orders.in_transit_notified_at. If that column doesn't exist
      // yet (migration not run), we SKIP rather than risk spamming on every scan.
      if (ourStatus === 'in_transit') {
        if (['out_for_delivery', 'delivered', 'cancelled', 'rto', 'lost', 'undelivered'].includes(order.status)) continue;
        const movedAt = order.shipment_moved_at || eventTimestamp(evt);
        if (order.in_transit_notified_at) {
          await supabase.from('orders').update({
            shipment_moved_at: movedAt,
            last_nimbuspost_status: String(rawStatus).slice(0, 200),
            last_nimbuspost_event_at: eventTimestamp(evt),
          }).eq('id', order.id);
          console.log(`[NimbusPost] In-transit already notified for ${awb}`);
          continue;
        }
        const stamp = await supabase
          .from('orders')
          .update({
            in_transit_notified_at: new Date().toISOString(),
            shipment_moved_at: movedAt,
            last_nimbuspost_status: String(rawStatus).slice(0, 200),
            last_nimbuspost_event_at: eventTimestamp(evt),
          })
          .eq('id', order.id)
          .is('in_transit_notified_at', null)   // only claim if not already claimed
          .select('id');
        if (stamp.error) {
          console.error(`[NimbusPost] Could not stamp in_transit_notified_at (run sql/orders_in_transit_notified.sql?) — skipping to avoid spam: ${stamp.error.message}`);
          continue;
        }
        if (!stamp.data || stamp.data.length === 0) {
          console.log(`[NimbusPost] In-transit already claimed by a concurrent scan for ${awb}`);
          continue;
        }
        console.log(`[NimbusPost] 🚚 In-transit notify → ${order.razorpay_order_id || order.id}`);
        const notification = await sendInTransitNotifications(order, awb);
        // sendWhatsApp is intentionally non-throwing. Check its result before
        // keeping the durable claim; otherwise a transient Meta/template error
        // would permanently suppress every later retry for this shipment.
        if (order.customer_phone && !notification?.whatsapp?.ok) {
          await supabase.from('orders').update({ in_transit_notified_at: null }).eq('id', order.id);
          console.error(`[NimbusPost] In-transit notification failed for ${order.razorpay_order_id || order.id}; claim released for retry`);
        }
        continue;
      }

      // Movement markers are recorded BEFORE the skip guards below, never after.
      // nimbuspost-ship.js sets status='shipped' the moment an AWB is minted, so
      // the real pickup scan arrives as shipped→shipped and gets skipped as a
      // no-op transition — which used to throw away the only evidence that the
      // parcel had left the building. cancel-order.js reads exactly these two
      // columns, so dropping them let a picked-up order stay cancellable.
      if (['shipped', 'out_for_delivery', 'delivered'].includes(ourStatus)) {
        await supabase.from('orders').update({
          shipment_moved_at: order.shipment_moved_at || eventTimestamp(evt),
          last_nimbuspost_status: String(rawStatus).slice(0, 200),
          last_nimbuspost_event_at: eventTimestamp(evt),
        }).eq('id', order.id);
      }

      // Guard against backwards transitions
      const RANK = { shipped:1, out_for_delivery:2, delivered:3, cancelled:0, undelivered:0, rto:0, lost:0 };
      const currentRank = RANK[order.status] || 0;
      const newRank     = RANK[ourStatus]    || 0;
      if (['cancelled', 'refunded', 'delivered'].includes(order.status) &&
          ['shipped', 'out_for_delivery'].includes(ourStatus)) {
        console.log(`[NimbusPost] Skip ${ourStatus} — order is terminal (${order.status})`);
        continue;
      }
      if (newRank > 0 && newRank <= currentRank) {
        console.log(`[NimbusPost] Skip — already at ${order.status}`);
        continue;
      }

      const previousStatus = order.status;

      // Update Supabase — save tracking URL when shipped
      const trackingUrl = npTrackUrl(awb);
      const updateData = { status: ourStatus };
      if (ourStatus === 'shipped') {
        updateData.tracking_url = trackingUrl;
        updateData.shipped_at   = new Date().toISOString();
        updateData.shipment_moved_at = order.shipment_moved_at || eventTimestamp(evt);
        if (!order.courier_name) updateData.courier_name = 'DTDC Surface';
      }
      if (['shipped', 'out_for_delivery', 'delivered'].includes(ourStatus)) {
        updateData.shipment_moved_at = order.shipment_moved_at || eventTimestamp(evt);
      }
      updateData.last_nimbuspost_status = String(rawStatus).slice(0, 200);
      updateData.last_nimbuspost_event_at = eventTimestamp(evt);
      if (ourStatus === 'delivered') updateData.delivered_at = new Date().toISOString();

      await supabase.from('orders').update(updateData).eq('id', order.id);
      // Merge for notification use
      Object.assign(order, updateData);
      console.log(`[NimbusPost] ✅ Order ${order.razorpay_order_id || order.id} → ${ourStatus}`);

      // Notify — unless this order is being repaired by hand.
      //
      // Cancelling a shipment in the NimbusPost panel produces a 'cancelled'
      // webhook, which would email and WhatsApp the customer "Order Cancelled"
      // for an order that is actually being re-shipped a minute later; the
      // re-ship then sends a second "shipped" mail with new tracking. Both are
      // confusing and neither is true. Listing an order id in
      // NOTIFY_SUPPRESS_ORDER_IDS (comma-separated) keeps the status tracking
      // fully intact while sending the customer nothing.
      //
      // Deliberately env-driven and per-order: no migration needed, it cannot
      // silence anything not explicitly named, and clearing the variable when
      // the repair is done restores normal behaviour with no code change.
      const suppressList = String(process.env.NOTIFY_SUPPRESS_ORDER_IDS || '')
        .split(',').map(s => s.trim()).filter(Boolean);
      const displayId = String(order.razorpay_order_id || order.id || '');
      if (suppressList.length && suppressList.includes(displayId)) {
        console.log(`[NimbusPost] 🔇 ${displayId} → ${ourStatus} (customer notification suppressed for manual repair)`);
        continue;
      }

      // Notify
      if (ourStatus === 'shipped') {
        await sendShippedNotifications(order, awb);
      } else if (ourStatus === 'out_for_delivery') {
        await sendOFDNotification(order);
      } else if (ourStatus === 'delivered') {
        await sendDeliveredNotification(order);
      } else if (ourStatus === 'cancelled' && previousStatus !== 'cancelled') {
        await notifyOrderCancelled(order, {
          reason: message || 'The courier update marked this shipment as cancelled.',
        });
      } else if (['undelivered', 'rto', 'lost'].includes(ourStatus)) {
        await notifyOwnerIssue(order, ourStatus, message, location);
      }

    } catch (err) {
      console.error('[NimbusPost] Error:', err.message);
    }
  }

  return { statusCode: 200, body: 'OK' };
};

exports._test = { normalizeStatus };
