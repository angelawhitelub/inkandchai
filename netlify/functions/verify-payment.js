/**
 * Netlify Function: verify-payment
 * POST /.netlify/functions/verify-payment
 * Verifies Razorpay signature, saves order to Supabase, sends email notifications.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Send email via Resend ─────────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;   // silently skip if not configured
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Ink & Chai <orders@inkandchai.in>',
      to,
      subject,
      html,
    }),
  });
}

function cartTable(cart) {
  const rows = cart.map(i => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;">${i.title}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;text-align:center;">${i.qty}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;text-align:right;color:#c9a84c;">₹${(i.price*i.qty).toLocaleString('en-IN')}</td>
    </tr>`).join('');
  const total = cart.reduce((s,i)=>s+i.price*i.qty,0);
  return `
    <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
      <thead>
        <tr style="background:#1c1916;">
          <th style="padding:8px 12px;text-align:left;color:#c9a84c;font-weight:500;">Book</th>
          <th style="padding:8px 12px;text-align:center;color:#c9a84c;font-weight:500;">Qty</th>
          <th style="padding:8px 12px;text-align:right;color:#c9a84c;font-weight:500;">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="2" style="padding:10px 12px;font-weight:500;color:#f0e8d8;">Total (Online Payment)</td>
          <td style="padding:10px 12px;text-align:right;font-size:18px;color:#c9a84c;font-weight:600;">₹${total.toLocaleString('en-IN')}</td>
        </tr>
      </tfoot>
    </table>`;
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    cart,
    customer,
    amount,
  } = body;

  // ── 1. Verify signature ───────────────────────────────────────────────────
  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSig !== razorpay_signature) {
    console.error('Signature mismatch');
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid signature' }) };
  }

  // ── 2. Save to Supabase ───────────────────────────────────────────────────
  const total = cart ? cart.reduce((s, i) => s + i.price * i.qty, 0) : Math.round(amount / 100);

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { error } = await supabase.from('orders').insert({
      razorpay_order_id,
      razorpay_payment_id,
      amount_paise:     amount,
      status:           'paid',
      customer_name:    customer?.name    || '',
      customer_email:   customer?.email   || '',
      customer_phone:   customer?.phone   || '',
      customer_address: customer?.address || '',
      cart_items:       cart,
    });

    if (error) throw error;

  } catch (err) {
    console.error('Supabase save error:', err);
    // Payment was valid even if DB save fails — still send emails and return success
  }

  // ── 3. Email YOU (store owner) ────────────────────────────────────────────
  const ownerEmail = process.env.STORE_OWNER_EMAIL;
  if (ownerEmail && cart?.length) {
    await sendEmail({
      to: ownerEmail,
      subject: `💳 New Online Order — ₹${total.toLocaleString('en-IN')} (${razorpay_payment_id})`,
      html: emailBase(`
        <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">New Online Payment Received</h2>
        <p style="color:#a09080;margin-bottom:16px;">
          Razorpay Order: <strong style="color:#c9a84c;">${razorpay_order_id}</strong><br/>
          Payment ID: <strong style="color:#c9a84c;">${razorpay_payment_id}</strong>
        </p>
        <table style="font-size:14px;line-height:1.8;color:#f0e8d8;">
          <tr><td style="color:#a09080;padding-right:16px;">Name</td><td>${customer?.name||'—'}</td></tr>
          <tr><td style="color:#a09080;padding-right:16px;">Phone</td><td>${customer?.phone||'—'}</td></tr>
          <tr><td style="color:#a09080;padding-right:16px;">Email</td><td>${customer?.email||'—'}</td></tr>
          <tr><td style="color:#a09080;padding-right:16px;">Address</td><td>${customer?.address||'—'}</td></tr>
        </table>
        ${cartTable(cart)}
        <p style="color:#6dbf6d;font-size:13px;">✅ Payment confirmed. Ready to ship!</p>
      `),
    });
  }

  // ── 4. Confirmation email to CUSTOMER ─────────────────────────────────────
  if (customer?.email && cart?.length) {
    await sendEmail({
      to: customer.email,
      subject: `Your Ink & Chai order is confirmed! (${razorpay_payment_id})`,
      html: emailBase(`
        <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">Order Confirmed 📚</h2>
        <p style="color:#a09080;line-height:1.8;margin-bottom:16px;">
          Hi ${customer.name?.split(' ')[0]||'there'}, your books are on their way!<br/>
          Your payment of <strong style="color:#c9a84c;">₹${total.toLocaleString('en-IN')}</strong> was received successfully.
        </p>
        ${cartTable(cart)}
        <p style="color:#a09080;font-size:13px;line-height:1.8;">
          <strong style="color:#f0e8d8;">Delivery address:</strong><br/>${customer.address||'—'}
        </p>
        <p style="margin-top:16px;color:#7a6330;font-size:12px;">Payment ID: ${razorpay_payment_id}</p>
        <div style="margin-top:20px;padding:14px 16px;background:#1c1916;border-left:3px solid #c9a84c;">
          <p style="color:#f0e8d8;font-size:13px;margin:0 0 8px;">Track your orders anytime</p>
          <p style="color:#a09080;font-size:12px;margin:0;">
            Visit <a href="https://inkandchai.in" style="color:#c9a84c;">inkandchai.in</a> and click
            <strong style="color:#f0e8d8;">"My Orders"</strong> in the top menu. Enter this email address
            and we'll send you a one-click login link.
          </p>
        </div>
      `),
    });
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ success: true, payment_id: razorpay_payment_id }),
  };
};
