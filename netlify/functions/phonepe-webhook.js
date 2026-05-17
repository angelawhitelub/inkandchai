/**
 * Netlify Function: phonepe-webhook
 * POST /.netlify/functions/phonepe-webhook
 *
 * Receives payment-status callbacks from PhonePe Business and updates
 * the matching order in Supabase. Sends customer + owner confirmation
 * emails on successful payment.
 *
 * AUTH: PhonePe sends an "Authorization: Basic base64(user:pass)" header
 * matching whatever you typed in the dashboard. We require both
 * PHONEPE_WEBHOOK_USER and PHONEPE_WEBHOOK_PASS to be set in Netlify
 * env vars and reject mismatches with 401 — that prevents random
 * actors from posting fake payment events to this endpoint.
 *
 * EVENTS HANDLED:
 *   - checkout.order.completed  → mark order paid + email customer
 *   - checkout.order.failed     → mark order cancelled (no email)
 *   - pg.refund.completed       → mark order refunded
 *
 * PhonePe expects a 200 within 5 seconds; we do the DB write + email
 * synchronously but never throw — bad payloads return 200 with an
 * "ignored" reason so PhonePe doesn't keep retrying.
 */

const { createClient } = require('@supabase/supabase-js');
const { sendWhatsApp }  = require('./utils/whatsapp');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

// ── Email via Resend (same fallback pattern as other functions) ────────────
async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return;
  async function attempt(from) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  }
  try {
    let r = await attempt('Ink & Chai <support@inkandchai.in>');
    if (!r.ok && (r.status === 403 || /domain|verified|not.*allowed|testing/i.test(r.body?.message || ''))) {
      r = await attempt('Ink & Chai <onboarding@resend.dev>');
    }
    if (!r.ok) console.error('Resend error:', r.status, JSON.stringify(r.body));
  } catch (err) { console.error('sendEmail exception:', err.message); }
}

// ── Verify Basic auth header matches our secrets (constant-time) ───────────
function verifyAuth(event) {
  const u = process.env.PHONEPE_WEBHOOK_USER;
  const p = process.env.PHONEPE_WEBHOOK_PASS;
  if (!u || !p) {
    console.error('PHONEPE_WEBHOOK_USER / PHONEPE_WEBHOOK_PASS not set in Netlify env');
    return false;
  }
  const expected = 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
  const got = event.headers['authorization'] || event.headers['Authorization'] || '';
  if (got.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < got.length; i++) mismatch |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

// ── Admin/owner notification (shows order + customer info, not addressed to customer) ──
function ownerNotifHtml(order) {
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const meta = items[0]?._payment || {};
  const isPartial = meta.mode === 'partial_cod' || order.status === 'partial_cod_pending';
  const paid = order.amount_paise ? (order.amount_paise / 100) : 0;
  const balance = isPartial ? Math.max(0, Number(meta.balance) || 0) : 0;
  const rows = items.map(i => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #2a2a2a;">${i.title}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #2a2a2a;text-align:center;">${i.qty}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #2a2a2a;text-align:right;color:#c9a84c;">₹${(i.price*i.qty).toLocaleString('en-IN')}</td>
    </tr>`).join('');
  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:22px;font-weight:400;">Ink &amp; Chai — ${isPartial ? '💰 New Partial COD (PhonePe)' : '💳 New PhonePe Payment'}</h1>
      <p style="color:#a09080;font-size:12px;margin-bottom:20px;">Order ID: <strong style="color:#c9a84c;">${order.razorpay_order_id || order.id}</strong></p>
      <table style="font-size:14px;line-height:2;color:#f0e8d8;margin-bottom:18px;">
        <tr><td style="color:#a09080;padding-right:18px;">Name</td><td>${order.customer_name || '—'}</td></tr>
        <tr><td style="color:#a09080;padding-right:18px;">Phone</td><td>${order.customer_phone || '—'}</td></tr>
        <tr><td style="color:#a09080;padding-right:18px;">Email</td><td>${order.customer_email || '—'}</td></tr>
        <tr><td style="color:#a09080;padding-right:18px;">Address</td><td>${order.customer_address || '—'}</td></tr>
      </table>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <thead><tr style="background:#1c1916;">
          <th style="padding:8px 10px;text-align:left;color:#c9a84c;font-weight:500;">Book</th>
          <th style="padding:8px 10px;text-align:center;color:#c9a84c;font-weight:500;">Qty</th>
          <th style="padding:8px 10px;text-align:right;color:#c9a84c;font-weight:500;">Amount</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${isPartial
        ? `<p style="margin-top:16px;background:#1c1916;padding:12px 14px;color:#c9a84c;font-size:13px;">Paid now: ₹${paid.toLocaleString('en-IN')} · Collect on delivery: ₹${balance.toLocaleString('en-IN')}</p>`
        : `<p style="margin-top:16px;color:#6dbf6d;font-size:13px;">✅ Full payment received — ₹${paid.toLocaleString('en-IN')}. Ready to ship!</p>`}
    </div>`;
}

function paidEmailHtml(order) {
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const meta = items[0]?._payment || {};
  const isPartial = meta.mode === 'partial_cod' || order.status === 'partial_cod_pending';
  const total = order.amount_paise ? (order.amount_paise / 100) : 0;
  const balance = isPartial ? Math.max(0, Number(meta.balance) || 0) : 0;
  const rows = items.map(i => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;">${i.title}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;text-align:center;">${i.qty}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;text-align:right;color:#c9a84c;">₹${(i.price*i.qty).toLocaleString('en-IN')}</td>
    </tr>`).join('');

  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">inkandchai.in</p>
      <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">${isPartial ? '✅ Booking payment received' : '✅ Payment received'}</h2>
      <p style="color:#a09080;line-height:1.8;margin:14px 0;">
        Hi ${order.customer_name?.split(' ')[0] || 'there'}, ${isPartial
          ? `we received your 10% booking payment of <strong style="color:#c9a84c;">₹${total.toLocaleString('en-IN')}</strong> via PhonePe. Please pay the remaining <strong style="color:#c9a84c;">₹${balance.toLocaleString('en-IN')}</strong> on delivery.`
          : `we received your payment of <strong style="color:#c9a84c;">₹${total.toLocaleString('en-IN')}</strong> via PhonePe. Your books are being packed and we'll email a tracking link as soon as the courier picks them up.`}
      </p>
      <table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:14px;">
        <thead><tr style="background:#1c1916;">
          <th style="padding:8px 12px;text-align:left;color:#c9a84c;font-weight:500;">Book</th>
          <th style="padding:8px 12px;text-align:center;color:#c9a84c;font-weight:500;">Qty</th>
          <th style="padding:8px 12px;text-align:right;color:#c9a84c;font-weight:500;">Amount</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#a09080;font-size:13px;line-height:1.8;">
        <strong style="color:#f0e8d8;">Delivery to:</strong><br/>${order.customer_address || '—'}
      </p>
      <p style="margin-top:18px;color:#7a6330;font-size:12px;">Order ID: <strong style="color:#c9a84c;">${order.razorpay_order_id || order.id}</strong></p>
      <div style="margin-top:20px;padding:14px 16px;background:#1c1916;border-left:3px solid #c9a84c;">
        <a href="https://inkandchai.in/track/?id=${encodeURIComponent(order.razorpay_order_id || order.id)}&q=${encodeURIComponent(order.customer_email || order.customer_phone || '')}"
           style="display:inline-block;background:#c9a84c;color:#0d0b08;padding:10px 22px;text-decoration:none;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:600;">Track Order →</a>
      </div>
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai · Reply to this email or message us on WhatsApp for support.</p>
    </div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // Health-check / dashboard "test webhook" support
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'ok', endpoint: 'phonepe-webhook' }) };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  if (!verifyAuth(event)) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 200, headers: CORS, body: JSON.stringify({ ignored: 'bad-json' }) }; }

  const eventType = body.event || body.type || '';
  const payload   = body.payload || body.data || body;

  const orderId = payload.merchantOrderId || payload.merchant_order_id || payload.orderId || payload.order_id;
  const txnId   = payload.transactionId   || payload.transaction_id   || payload.paymentId  || null;
  const state   = (payload.state || payload.status || '').toUpperCase();
  const amount  = payload.amount || payload.amount_paise || null;

  if (!orderId) {
    console.warn('PhonePe webhook had no orderId:', JSON.stringify(body).slice(0, 400));
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ignored: 'no-order-id' }) };
  }

  let dbStatus = null;
  if (eventType.includes('completed') || state === 'COMPLETED' || state === 'PAID' || state === 'SUCCESS') {
    dbStatus = 'paid';
  } else if (eventType.includes('failed') || state === 'FAILED' || state === 'DECLINED') {
    dbStatus = 'cancelled';
  } else if (eventType.includes('refund')) {
    dbStatus = 'refunded';
  } else {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ignored: 'event-not-handled', eventType, state }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: existing } = await supabase
      .from('orders')
      .select('status,cart_items')
      .eq('razorpay_order_id', orderId)
      .maybeSingle();
    const meta = Array.isArray(existing?.cart_items) ? existing.cart_items[0]?._payment : null;
    if (dbStatus === 'paid' && (existing?.status === 'pending_partial_phonepe' || meta?.mode === 'partial_cod')) {
      dbStatus = 'partial_cod_pending';
    }

    const update = { status: dbStatus };
    if (txnId)  update.razorpay_payment_id = txnId;
    if (amount) update.amount_paise = amount;

    const { data: rows, error } = await supabase
      .from('orders')
      .update(update)
      .eq('razorpay_order_id', orderId)
      .select('*');

    if (error) throw error;
    if (!rows?.length) {
      console.warn(`PhonePe: order not found in DB: ${orderId}`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ignored: 'order-not-found', orderId }) };
    }

    const order = rows[0];

    // Send notifications for both full payment and partial COD booking payment
    const isNotified = dbStatus === 'paid' || dbStatus === 'partial_cod_pending';
    const isPartialNotif = dbStatus === 'partial_cod_pending';
    const paidAmt = order.amount_paise ? (order.amount_paise / 100) : 0;
    const items   = Array.isArray(order.cart_items) ? order.cart_items : [];
    const metaNotif = items[0]?._payment || {};
    const balanceNotif = isPartialNotif ? Math.max(0, Number(metaNotif.balance) || 0) : 0;

    if (isNotified) {
      // Customer email
      if (order.customer_email) {
        await sendEmail({
          to: order.customer_email,
          subject: isPartialNotif
            ? `✅ Booking confirmed — Ink & Chai order ${order.razorpay_order_id || order.id}`
            : `✅ Payment received — Ink & Chai order ${order.razorpay_order_id || order.id}`,
          html: paidEmailHtml(order),
        });
      }

      // Owner email (admin-style — shows customer info, not "Hi customer")
      const ownerEmail = process.env.STORE_OWNER_EMAIL;
      if (ownerEmail) {
        await sendEmail({
          to: ownerEmail,
          subject: isPartialNotif
            ? `💰 Partial COD PhonePe — ₹${paidAmt.toLocaleString('en-IN')} paid · collect ₹${balanceNotif.toLocaleString('en-IN')} — ${order.razorpay_order_id}`
            : `💳 PhonePe payment received — ${order.razorpay_order_id} · ₹${paidAmt.toLocaleString('en-IN')}`,
          html: ownerNotifHtml(order),
        });
      }

      // WhatsApp confirmation to customer
      if (order.customer_phone) {
        const firstName  = String(order.customer_name || 'there').split(' ')[0];
        const amtDisplay = isPartialNotif
          ? `₹${paidAmt.toLocaleString('en-IN')} (10% advance) + ₹${balanceNotif.toLocaleString('en-IN')} COD`
          : `₹${paidAmt.toLocaleString('en-IN')}`;
        const addrShort = (order.customer_address || '').slice(0, 80);
        try {
          await sendWhatsApp({
            to:       order.customer_phone,
            template: 'order_confirmed',
            params:   [firstName, order.razorpay_order_id || order.id, amtDisplay, addrShort],
          });
        } catch (waErr) {
          console.error('WhatsApp failed for PhonePe order:', waErr.message);
        }
      }
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, orderId, status: dbStatus, txnId }) };

  } catch (err) {
    console.error('phonepe-webhook error:', err);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ignored: 'internal-error', message: err.message }) };
  }
};
