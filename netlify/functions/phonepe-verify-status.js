/**
 * Netlify Function: phonepe-verify-status
 * GET /.netlify/functions/phonepe-verify-status?id=<orderId>
 *
 * PhonePe redirects the customer here after payment. We hit the v2
 * status endpoint with an OAuth token, then:
 *
 *   1. If COMPLETED — IDEMPOTENTLY update Supabase row to status='paid'
 *      AND send confirmation emails to customer + owner *if* the row
 *      wasn't already paid. This is a safety net for when PhonePe's
 *      webhook is delayed, blocked, or arrives out of order — the
 *      customer-redirect path always reconciles the order itself.
 *   2. Redirect the customer to /checkout/?paid=1 or ?failed=1.
 *
 * The phonepe-webhook function still runs in parallel; either path
 * may run first, and the de-dupe check (existing status='paid') prevents
 * double-emailing.
 */

const { createClient } = require('@supabase/supabase-js');

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

// ── Email via Resend (with onboarding fallback) ────────────────────────────
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
  const fullTotal = isPartial ? Math.max(total + balance, Number(meta.full_total) || 0) : total;
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
          ? `we received your 10% booking payment of <strong style="color:#c9a84c;">₹${total.toLocaleString('en-IN')}</strong> via PhonePe. Please pay the remaining <strong style="color:#c9a84c;">₹${balance.toLocaleString('en-IN')}</strong> on delivery. Full order value: ₹${fullTotal.toLocaleString('en-IN')}.`
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

// ── Reconcile a confirmed-paid order in Supabase (idempotent) ──────────────
async function reconcilePaidOrder(orderId, phonepeTxnId, amount) {
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Fetch current row to dedupe
    const { data: existing } = await supabase
      .from('orders')
      .select('*')
      .eq('razorpay_order_id', orderId)
      .limit(1)
      .maybeSingle();

    if (!existing) {
      console.warn(`reconcile: order not in DB: ${orderId}`);
      return;
    }
    if (existing.status === 'paid' || existing.status === 'partial_cod_pending') {
      // Webhook already handled it — nothing to do
      return;
    }

    const existingMeta = Array.isArray(existing.cart_items) ? existing.cart_items[0]?._payment : null;
    const isPartial = existingMeta?.mode === 'partial_cod' || existing.status === 'pending_partial_phonepe';
    const update = { status: isPartial ? 'partial_cod_pending' : 'paid' };
    if (phonepeTxnId) update.razorpay_payment_id = phonepeTxnId;
    if (amount) update.amount_paise = amount;

    const { data: rows, error } = await supabase
      .from('orders')
      .update(update)
      .eq('razorpay_order_id', orderId)
      .select('*');

    if (error) { console.error('reconcile update error:', error); return; }
    const order = rows?.[0];
    if (!order) return;

    // Send customer + owner confirmations (only because we just transitioned
    // — webhook will skip when it eventually arrives, dedupe works both ways)
    if (order.customer_email) {
      await sendEmail({
        to: order.customer_email,
        subject: `✅ Payment received — Ink & Chai order ${order.razorpay_order_id || order.id}`,
        html: paidEmailHtml(order),
      });
    }
    const ownerEmail = process.env.STORE_OWNER_EMAIL;
    if (ownerEmail) {
      await sendEmail({
        to: ownerEmail,
        subject: `💳 PhonePe payment received — ${order.razorpay_order_id} · ₹${((order.amount_paise||0)/100).toLocaleString('en-IN')}`,
        html: paidEmailHtml(order),
      });
    }
  } catch (err) {
    console.error('reconcilePaidOrder exception:', err.message);
  }
}

exports.handler = async (event) => {
  const id = event.queryStringParameters?.id;
  const siteUrl = process.env.SITE_URL || 'https://inkandchai.in';
  const host = process.env.PHONEPE_HOST || 'https://api.phonepe.com/apis';

  if (!id) {
    return { statusCode: 302, headers: { Location: siteUrl + '/checkout/?failed=1' }, body: '' };
  }

  try {
    const token = await getAccessToken(host);
    const res = await fetch(`${host}/pg/checkout/v2/order/${encodeURIComponent(id)}/status`, {
      headers: { 'Authorization': 'O-Bearer ' + token },
    });
    const data = await res.json().catch(() => ({}));
    const state = (data.state || '').toUpperCase();
    // Pull PhonePe txn id + amount if available (used to enrich the row)
    const txnId = data.paymentDetails?.[0]?.transactionId
               || data.paymentDetails?.[0]?.paymentId
               || data.orderId
               || null;
    const amount = data.amount || null;

    if (state === 'COMPLETED') {
      // Safety net: update DB + email if the webhook hasn't arrived yet.
      // Awaited so the success screen the customer sees reflects the
      // committed DB state.
      await reconcilePaidOrder(id, txnId, amount);
      return {
        statusCode: 302,
        headers: { Location: `${siteUrl}/checkout/?paid=1&id=${encodeURIComponent(id)}` },
        body: '',
      };
    }
    return {
      statusCode: 302,
      headers: { Location: `${siteUrl}/checkout/?failed=1&id=${encodeURIComponent(id)}&code=${encodeURIComponent(state || 'UNKNOWN')}` },
      body: '',
    };
  } catch (err) {
    console.error('PhonePe v2 status error:', err);
    return {
      statusCode: 302,
      headers: { Location: `${siteUrl}/checkout/?failed=1&id=${encodeURIComponent(id)}` },
      body: '',
    };
  }
};
