/**
 * Netlify Function: phonepe-reconcile
 * POST /.netlify/functions/phonepe-reconcile
 *
 * Admin endpoint — manually re-check the PhonePe status of one or more
 * orders stuck on 'pending_phonepe'. Useful when the webhook was missed
 * or arrived after the customer left.
 *
 * Auth: X-Admin-Key header (same as other admin functions).
 *
 * Body (one of):
 *   { id: "IC-..." }              → re-check one order
 *   { ids: ["IC-...", ...] }      → re-check a specific list
 *   { all_pending: true }         → re-check every order with
 *                                   status='pending_phonepe' from the
 *                                   last 30 days
 *
 * For each order: calls PhonePe's GET /pg/checkout/v2/order/{id}/status
 * and, on state=COMPLETED, updates the DB row to status='paid' +
 * fires confirmation emails (deduped against the webhook).
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

let _tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken(host) {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }
  const body = new URLSearchParams({
    client_id:      process.env.PHONEPE_CLIENT_ID,
    client_secret:  process.env.PHONEPE_CLIENT_SECRET,
    client_version: process.env.PHONEPE_CLIENT_VERSION || '1',
    grant_type:     'client_credentials',
  });
  const res = await fetch(`${host}/identity-manager/v1/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error('PhonePe OAuth failed: ' + (data.message || data.error || ('HTTP ' + res.status)));
  }
  _tokenCache = {
    token: data.access_token,
    expiresAt: data.expires_at ? data.expires_at * 1000 : Date.now() + (data.expires_in || 3300) * 1000,
  };
  return _tokenCache.token;
}

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
          : `we received your payment of <strong style="color:#c9a84c;">₹${total.toLocaleString('en-IN')}</strong> via PhonePe.`}
      </p>
      <table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:14px;">
        <thead><tr style="background:#1c1916;">
          <th style="padding:8px 12px;text-align:left;color:#c9a84c;font-weight:500;">Book</th>
          <th style="padding:8px 12px;text-align:center;color:#c9a84c;font-weight:500;">Qty</th>
          <th style="padding:8px 12px;text-align:right;color:#c9a84c;font-weight:500;">Amount</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#a09080;font-size:13px;"><strong style="color:#f0e8d8;">Delivery to:</strong><br/>${order.customer_address || '—'}</p>
      <p style="margin-top:18px;color:#7a6330;font-size:12px;">Order ID: <strong style="color:#c9a84c;">${order.razorpay_order_id || order.id}</strong></p>
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai</p>
    </div>`;
}

async function reconcileOne(supabase, host, token, orderId) {
  // Check current state in DB
  const { data: existing } = await supabase
    .from('orders')
    .select('*')
    .eq('razorpay_order_id', orderId)
    .limit(1)
    .maybeSingle();

  if (!existing) return { orderId, result: 'not_in_db' };

  // Never touch orders that have already been fulfilled or are partial COD
  // (partial COD deposit is a one-time PhonePe charge; the remaining balance is
  //  collected on delivery — PhonePe will report the original deposit order as
  //  FAILED/CANCELLED once the checkout session expires, which must NOT cancel our order)
  const cartMeta = Array.isArray(existing.cart_items) ? existing.cart_items[0]?._payment : null;
  const isPartialCod = cartMeta?.mode === 'partial_cod' ||
                       existing.status === 'partial_cod_pending' ||
                       (existing.status || '').includes('partial');
  if (isPartialCod) return { orderId, result: 'already_paid' };

  const SAFE_STATUSES = new Set(['paid', 'confirmed', 'shipped', 'out_for_delivery', 'delivered', 'refunded']);
  if (SAFE_STATUSES.has(existing.status)) return { orderId, result: 'already_processed' };
  if (existing.status === 'cancelled') return { orderId, result: 'already_cancelled' };

  // Hit PhonePe v2 status endpoint
  const res = await fetch(`${host}/pg/checkout/v2/order/${encodeURIComponent(orderId)}/status`, {
    headers: { 'Authorization': 'O-Bearer ' + token },
  });
  const data = await res.json().catch(() => ({}));
  const state = (data.state || '').toUpperCase();

  if (state === 'COMPLETED') {
    const txnId = data.paymentDetails?.[0]?.transactionId
               || data.paymentDetails?.[0]?.paymentId
               || data.orderId
               || null;
    const meta = Array.isArray(existing.cart_items) ? existing.cart_items[0]?._payment : null;
    const update = { status: (existing.status === 'pending_partial_phonepe' || meta?.mode === 'partial_cod') ? 'partial_cod_pending' : 'paid' };
    if (txnId) update.razorpay_payment_id = txnId;
    if (data.amount) update.amount_paise = data.amount;

    const { data: rows, error } = await supabase
      .from('orders').update(update).eq('razorpay_order_id', orderId).select('*');
    if (error) return { orderId, result: 'db_update_failed', error: error.message };
    const order = rows?.[0];

    // Fire emails — webhook will skip when it sees status=paid
    if (order?.customer_email) {
      await sendEmail({
        to: order.customer_email,
        subject: `✅ Payment received — Ink & Chai order ${order.razorpay_order_id}`,
        html: paidEmailHtml(order),
      });
    }
    const ownerEmail = process.env.STORE_OWNER_EMAIL;
    if (ownerEmail && order) {
      await sendEmail({
        to: ownerEmail,
        subject: `💳 PhonePe payment received — ${order.razorpay_order_id} · ₹${((order.amount_paise||0)/100).toLocaleString('en-IN')}`,
        html: paidEmailHtml(order),
      });
    }
    return { orderId, result: 'paid', txnId };
  }
  if (state === 'FAILED' || state === 'DECLINED' || state === 'CANCELLED') {
    await supabase.from('orders').update({ status: 'cancelled' }).eq('razorpay_order_id', orderId);
    return { orderId, result: 'cancelled', state };
  }
  return { orderId, result: 'still_pending', state };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const adminKey = process.env.ADMIN_SECRET;
  const sent     = event.headers['x-admin-key'] || event.headers['X-Admin-Key'];
  if (!adminKey || sent !== adminKey) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const host = process.env.PHONEPE_HOST || 'https://api.phonepe.com/apis';

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Resolve list of order IDs to reconcile
    let ids = [];
    if (body.id)             ids = [body.id];
    else if (Array.isArray(body.ids)) ids = body.ids;
    else if (body.all_pending) {
      // Last 30 days of PhonePe pending orders
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const { data } = await supabase
        .from('orders')
        .select('razorpay_order_id')
        .in('status', ['pending_phonepe', 'pending_partial_phonepe'])
        .gte('created_at', since)
        .limit(200);
      ids = (data || []).map(o => o.razorpay_order_id).filter(Boolean);
    }

    if (!ids.length) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No order ids supplied (use {id} | {ids} | {all_pending:true})' }) };
    }

    const token = await getAccessToken(host);

    // Sequentially to avoid hitting PhonePe rate limits and to keep
    // memory predictable on Netlify.
    const results = [];
    for (const id of ids) {
      try {
        results.push(await reconcileOne(supabase, host, token, id));
      } catch (err) {
        results.push({ orderId: id, result: 'error', error: err.message });
      }
    }

    const summary = results.reduce((s, r) => ((s[r.result] = (s[r.result] || 0) + 1), s), {});
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, summary, results }) };

  } catch (err) {
    console.error('phonepe-reconcile error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
