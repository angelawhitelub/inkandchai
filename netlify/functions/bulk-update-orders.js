/**
 * Netlify Function: bulk-update-orders
 * POST /.netlify/functions/bulk-update-orders
 *
 * Admin endpoint — bulk update order status/tracking from CSV/XLSX rows.
 * Each update accepts:
 *   order_id       Supabase id OR razorpay_order_id
 *   status         cod_pending | partial_cod_pending | confirmed | shipped | out_for_delivery | delivered | paid | cancelled | refunded
 *   tracking_id    AWB / tracking number (optional, required for shipped emails with tracking)
 *   courier_name   courier name used to build tracking URL
 *
 * Shipment emails are sent for rows whose final status is "shipped".
 *
 * SECOND AWB (re-booking): when a row sets status=shipped with a tracking_id
 * that DIFFERS from the one already on the order, the customer gets a "new
 * tracking number" mail instead of the first-shipment one — they already have a
 * mail carrying the old AWB, and that link is dead once the shipment is
 * cancelled. The fire-once webhook markers (in_transit_notified_at,
 * shipment_moved_at, last_nimbuspost_status) are cleared at the same time, or
 * the customer would never receive in-transit or delivered notices for the
 * parcel that is actually moving.
 *
 * Re-uploading the SAME AWB on an already-shipped order sends nothing — that is
 * a no-op, and re-running a CSV must not mail everyone twice.
 */

const { createClient } = require('@supabase/supabase-js');

const { sendEmail }    = require('./utils/email');
const { sendWhatsApp } = require('./utils/whatsapp');
const { requireAdmin } = require('./utils/admin-auth');
const { notifyOrderCancelled } = require('./utils/order-cancelled-notification');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

const VALID_STATUSES = ['cod_pending', 'partial_cod_pending', 'confirmed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'paid', 'refunded'];

const COURIER_URLS = {
  'bluedart':     'https://www.bluedart.com/tracking?trackingNumber={id}',
  'dtdc':         'https://www.dtdc.in/tracking/tracking_results.asp?action=track&Type=awb&strCnno={id}',
  'delhivery':    'https://www.delhivery.com/track-v2/package/{id}',
  'indiapost':    'https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx?id={id}',
  'ecomexpress':  'https://ecomexpress.in/tracking/?awb_field={id}',
  'shadowfax':    'https://shadowfax.in/tracking/?awb={id}',
  'xpressbees':   'https://www.xpressbees.com/track?awbNo={id}',
  'shiprocket':   'https://shiprocket.co/tracking/{id}',
  'professional': 'https://www.tpcindia.com/Tracking2/Tracking2.aspx?cnno={id}',
};

function buildTrackingUrl(courier, trackingId) {
  if (!trackingId) return '';
  // All orders ship via NimbusPost — its universal tracking page works for any
  // underlying courier (BlueDart, Delhivery, etc.) using just the AWB. Use this
  // single format for the link sent to customers instead of per-courier URLs.
  return `https://ship.nimbuspost.com/shipping/tracking/${encodeURIComponent(trackingId)}`;
}

function text(v) {
  return String(v || '').trim();
}

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text(v));
}


/**
 * @param reship  true when this order already had a DIFFERENT AWB. The customer
 *                has already had a "shipped" mail carrying a tracking number
 *                that is now dead, so repeating the first-shipment wording
 *                would leave them chasing a link that returns nothing.
 */
function shipmentEmailHtml(order, reship = false) {
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const meta = items[0]?._payment || {};
  const isPartial = meta.mode === 'partial_cod' || order.status === 'partial_cod_pending';
  const total = order.amount_paise ? (order.amount_paise / 100) : items.reduce((s, i) => s + i.price * i.qty, 0);
  const balance = isPartial ? Math.max(0, Number(meta.balance) || 0) : 0;
  const isCOD = isPartial || order.status === 'cod_pending' || !order.razorpay_payment_id;
  const rows = items.map(i => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;">${i.title}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;text-align:center;">${i.qty}</td>
    </tr>`).join('');
  const trackBlock = order.tracking_id ? `
    <div style="margin:24px 0;padding:18px;background:#1c1916;border-left:3px solid #c9a84c;">
      <p style="color:#a09080;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 6px;">Courier &amp; Tracking</p>
      <p style="color:#f0e8d8;font-size:16px;margin:0 0 4px;"><strong>${order.courier_name || 'Courier'}</strong></p>
      <p style="color:#c9a84c;font-size:14px;font-family:Menlo,Consolas,monospace;margin:0 0 12px;">AWB: ${order.tracking_id}</p>
      ${order.tracking_url ? `<a href="${order.tracking_url}" style="display:inline-block;background:#c9a84c;color:#0d0b08;padding:10px 24px;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:600;">Track on courier site →</a>` : ''}
    </div>` : '';

  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">inkandchai.in</p>
      <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">${reship ? '📦 New tracking number for your order' : '📦 Your order has shipped!'}</h2>
      <p style="color:#a09080;line-height:1.8;margin:14px 0;">
        ${reship
          ? `Hi ${order.customer_name?.split(' ')[0] || 'there'}, your order has been re-booked with a different courier, so it now has a <strong style="color:#f0e8d8;">new tracking number</strong>. Your books are on the way — nothing is needed from you.`
          : `Hi ${order.customer_name?.split(' ')[0] || 'there'}, great news — your books are on the way to you.`}
      </p>
      ${reship ? `<p style="color:#a09080;font-size:13px;line-height:1.8;background:rgba(201,168,76,0.08);border-left:3px solid #c9a84c;padding:10px 14px;margin:14px 0;">
        Please use the tracking number below. Any earlier tracking link we sent you is no longer active.
      </p>` : ''}
      ${trackBlock}
      <p style="color:#a09080;font-size:13px;line-height:1.8;">Order ID: <strong style="color:#c9a84c;">${order.razorpay_order_id || order.id}</strong></p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
        <thead><tr style="background:#1c1916;">
          <th style="padding:8px 12px;text-align:left;color:#c9a84c;font-weight:500;">Book</th>
          <th style="padding:8px 12px;text-align:center;color:#c9a84c;font-weight:500;">Qty</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${isPartial ? `<p style="color:#6dbf6d;font-size:13px;background:rgba(109,191,109,0.1);padding:10px 14px;">💰 Partial COD — ₹${total.toLocaleString('en-IN')} paid. Please keep ₹${balance.toLocaleString('en-IN')} ready for delivery.</p>` : (isCOD ? `<p style="color:#6dbf6d;font-size:13px;background:rgba(109,191,109,0.1);padding:10px 14px;">💰 Cash on Delivery — please keep ₹${total.toLocaleString('en-IN')} ready when the delivery arrives.</p>` : '')}
      <p style="margin-top:18px;color:#a09080;font-size:13px;">
        You can also track this order anytime at
        <a href="https://inkandchai.in/track/?id=${encodeURIComponent(order.razorpay_order_id || order.id)}" style="color:#c9a84c;">inkandchai.in/track</a>
      </p>
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai · For support, reply to this email or message us on WhatsApp.</p>
    </div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const updates = Array.isArray(body.updates) ? body.updates.slice(0, 500) : [];
  if (!updates.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide updates[]' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // ── 1. Normalise + validate each row up-front ─────────────────────────────
    const rows = updates.map(raw => ({
      orderId:     text(raw.order_id || raw.id || raw.razorpay_order_id),
      status:      text(raw.status).toLowerCase(),
      trackingId:  text(raw.tracking_id || raw.awb || raw.tracking_number),
      courierName: text(raw.courier_name || raw.courier || raw.carrier),
    }));

    // ── 2. Batch-fetch all orders in TWO queries (UUIDs + IC-* IDs) ──────────
    //    This avoids N sequential SELECTs — was the cause of 504 timeouts.
    const uuidIds    = rows.map(r => r.orderId).filter(isUuid);
    const razorpayIds = rows.map(r => r.orderId).filter(id => id && !isUuid(id));

    const [uuidRes, rpRes] = await Promise.all([
      uuidIds.length
        ? supabase.from('orders').select('*').in('id', uuidIds)
        : Promise.resolve({ data: [], error: null }),
      razorpayIds.length
        ? supabase.from('orders').select('*').in('razorpay_order_id', razorpayIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (uuidRes.error)  console.error('UUID batch fetch error:', uuidRes.error.message);
    if (rpRes.error)    console.error('RazorPay batch fetch error:', rpRes.error.message);

    // Build lookup maps: id → order  and  razorpay_order_id → order
    const byUuid = new Map((uuidRes.data || []).map(o => [String(o.id), o]));
    const byRpId = new Map((rpRes.data  || []).map(o => [String(o.razorpay_order_id), o]));

    // ── 3. Process each row (only DB calls left are UPDATEs + emails) ─────────
    const results    = [];
    let updated      = 0;
    let emailsSent   = 0;
    let cancellationsNotified = 0;
    let reshipsNotified = 0;
    let skippedNoOp = 0;
    const shippedAt  = new Date().toISOString();

    for (const { orderId, status, trackingId, courierName } of rows) {
      if (!orderId) {
        results.push({ success: false, order_id: orderId, error: 'Missing order_id' });
        continue;
      }
      if (!VALID_STATUSES.includes(status)) {
        results.push({ success: false, order_id: orderId, error: `Invalid status: ${status || '(blank)'}` });
        continue;
      }

      const order = byUuid.get(orderId) || byRpId.get(orderId);
      if (!order) {
        results.push({ success: false, order_id: orderId, error: 'Order not found' });
        continue;
      }

      const trackingUrl = status === 'shipped' && trackingId ? buildTrackingUrl(courierName, trackingId) : '';
      const payload = { status };

      // A SECOND AWB — the order already carried a different one, so this row is
      // a re-booking (cancelled shipment, re-created with another courier).
      const prevAwb = text(order.tracking_id);
      const isReship = status === 'shipped' && Boolean(trackingId) && Boolean(prevAwb) && prevAwb !== trackingId;
      // Nothing actually changed: same AWB on an already-shipped order. Re-running
      // the same CSV must not mail the customer the identical notice again.
      const isNoOpReship = status === 'shipped' && Boolean(trackingId) && prevAwb === trackingId
        && order.status === 'shipped';

      if (status === 'shipped') {
        if (trackingId)   payload.tracking_id   = trackingId;
        if (courierName)  payload.courier_name  = courierName;
        if (trackingUrl)  payload.tracking_url  = trackingUrl;
        payload.shipped_at = shippedAt;
      }
      if (isReship) {
        // The new consignment has its own journey. These flags are all "fire
        // once" markers set from the OLD shipment's webhook events — left in
        // place, the customer would never get an in-transit or delivered notice
        // for the parcel that is actually moving.
        payload.in_transit_notified_at  = null;
        payload.shipment_moved_at       = null;
        payload.last_nimbuspost_status  = null;
        payload.last_nimbuspost_event_at = null;
      }

      const { data: saved, error: updateErr } = await supabase
        .from('orders')
        .update(payload)
        .eq('id', order.id)
        .select('*')
        .maybeSingle();

      if (updateErr) {
        results.push({ success: false, order_id: orderId, error: updateErr.message });
        continue;
      }

      let emailSent = false;
      if (status === 'shipped' && saved && !isNoOpReship) {
        if (saved.customer_email) {
          await sendEmail({
            to: saved.customer_email,
            subject: isReship
              ? `📦 New tracking number for your Ink & Chai order (${saved.razorpay_order_id || saved.id})`
              : `📦 Your Ink & Chai order has shipped (${saved.razorpay_order_id || saved.id})`,
            html: shipmentEmailHtml(saved, isReship),
          });
          emailSent = true;
          emailsSent++;
        }
        if (saved.customer_phone) {
          const firstName = (saved.customer_name || 'there').split(' ')[0];
          const trkUrl = saved.tracking_url || `https://inkandchai.in/track/?id=${encodeURIComponent(saved.razorpay_order_id || saved.id)}`;
          // Same approved template either way — Meta template text can't be
          // varied at send time, and it already reads as "here is your tracking",
          // which is true for a re-booking too. The email carries the explanation.
          await sendWhatsApp({
            to: saved.customer_phone,
            template: 'order_shipped',
            params: [firstName, saved.courier_name || 'Courier', saved.tracking_id || '—', trkUrl],
          });
        }
        if (isReship) reshipsNotified++;
      } else if (isNoOpReship) {
        skippedNoOp++;
      }

      if (status === 'cancelled' && order.status !== 'cancelled' && saved) {
        await notifyOrderCancelled(saved, {
          reason: 'Your order status was updated to cancelled.',
        });
        cancellationsNotified++;
      }

      updated++;
      results.push({
        success: true,
        order_id: orderId,
        email_sent: emailSent,
        reship: isReship,
        skipped_duplicate: isNoOpReship,
        previous_awb: isReship ? prevAwb : null,
        tracking_url: saved?.tracking_url || null,
        order: saved,
      });
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        updated,
        failed: results.filter(r => !r.success).length,
        emails_sent: emailsSent,
        cancellations_notified: cancellationsNotified,
        reships_notified: reshipsNotified,
        skipped_duplicate_awb: skippedNoOp,
        results,
        truncated: updates.length < (Array.isArray(body.updates) ? body.updates.length : 0),
      }),
    };
  } catch (err) {
    console.error('bulk-update-orders error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
