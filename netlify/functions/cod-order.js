/**
 * Netlify Function: cod-order
 * POST /.netlify/functions/cod-order
 * Saves COD order to Supabase + sends email notification via Resend.
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Send email via Resend (with auto-fallback to onboarding@resend.dev) ───
async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('RESEND_API_KEY not set — email skipped'); return; }
  if (!to)  { console.warn('sendEmail: empty "to" — skipped'); return; }

  async function attempt(from) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }

  try {
    // Try the custom domain first
    let r = await attempt('Ink & Chai <support@inkandchai.in>');
    if (r.ok) { console.log('Email sent (custom):', r.body.id, '→', to); return; }
    console.error(`Resend custom-domain error ${r.status}:`, JSON.stringify(r.body));

    // If domain not verified — fall back to Resend's onboarding sender so
    // customer still gets the email instead of nothing.
    const isDomainErr = r.status === 403 || /domain|verified|not.*allowed|testing/i.test(r.body?.message || '');
    if (isDomainErr) {
      r = await attempt('Ink & Chai <onboarding@resend.dev>');
      if (r.ok) { console.log('Email sent (fallback):', r.body.id, '→', to); return; }
      console.error(`Resend fallback error ${r.status}:`, JSON.stringify(r.body));
    }
  } catch (err) {
    console.error('sendEmail exception:', err.message);
  }
}

function cartTable(cart, shippingFee) {
  const rows = cart.map(i => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;">${i.title}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;text-align:center;">${i.qty}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;text-align:right;color:#c9a84c;">₹${(i.price*i.qty).toLocaleString('en-IN')}</td>
    </tr>`).join('');
  const subtotal = cart.reduce((s,i)=>s+i.price*i.qty,0);
  const ship = (typeof shippingFee === 'number') ? shippingFee : (subtotal >= 499 ? 0 : 40);
  const total = subtotal + ship;
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
          <td colspan="2" style="padding:8px 12px;color:#a09080;">Subtotal</td>
          <td style="padding:8px 12px;text-align:right;color:#f0e8d8;">₹${subtotal.toLocaleString('en-IN')}</td>
        </tr>
        <tr>
          <td colspan="2" style="padding:8px 12px;color:#a09080;">Shipping (Delhivery)</td>
          <td style="padding:8px 12px;text-align:right;color:${ship === 0 ? '#6dbf6d' : '#f0e8d8'};">${ship === 0 ? 'FREE' : '₹' + ship}</td>
        </tr>
        <tr style="border-top:2px solid #2a2a2a;">
          <td colspan="2" style="padding:10px 12px;font-weight:500;color:#f0e8d8;">Total</td>
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
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { cart, customer, amount, user_id } = body;
  if (!cart?.length || !customer?.phone) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing cart or phone' }) };
  }

  const now = new Date();
  const datePart = now.toISOString().slice(0,10).replace(/-/g,'');   // 20260429
  const randPart = Math.random().toString(36).slice(2,7).toUpperCase(); // AB3CD
  const orderId = `IC-${datePart}-${randPart}`;  // e.g. IC-20260429-AB3CD

  // Shipping rules — must match cart.js + checkout. Calculate server-side
  // defensively rather than trusting client input.
  const FREE_SHIPPING_THRESHOLD = 499;
  const SHIPPING_FEE = 40;
  const subtotal = cart.reduce((s,i)=>s+i.price*i.qty, 0);
  const shipping = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE;
  const total    = subtotal + shipping;

  // ── 1. Save to Supabase (non-fatal — emails still send even if DB is down) ──
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { error } = await supabase.from('orders').insert({
      razorpay_order_id:   orderId,
      razorpay_payment_id: null,
      amount_paise:        Math.round(total * 100),
      status:              'cod_pending',
      customer_name:       customer.name    || '',
      customer_email:      customer.email   || '',
      customer_phone:      customer.phone,
      customer_address:    customer.address || '',
      cart_items:          cart,
      user_id:             user_id || null,
    });
    if (error) console.error('Supabase error (non-fatal):', error.message);
  } catch (err) {
    console.error('Supabase error (non-fatal):', err.message);
  }

  // ── 2. Email YOU (store owner) ────────────────────────────────────────────
  const ownerEmail = process.env.STORE_OWNER_EMAIL;
  if (ownerEmail) {
    await sendEmail({
      to: ownerEmail,
      subject: `🚚 New COD Order ${orderId} — ₹${total.toLocaleString('en-IN')}`,
      html: emailBase(`
        <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">New Cash on Delivery Order</h2>
        <p style="color:#a09080;margin-bottom:16px;">Order ID: <strong style="color:#c9a84c;">${orderId}</strong></p>
        <table style="font-size:14px;line-height:1.8;color:#f0e8d8;">
          <tr><td style="color:#a09080;padding-right:16px;">Name</td><td>${customer.name||'—'}</td></tr>
          <tr><td style="color:#a09080;padding-right:16px;">Phone</td><td>${customer.phone}</td></tr>
          <tr><td style="color:#a09080;padding-right:16px;">Email</td><td>${customer.email||'—'}</td></tr>
          <tr><td style="color:#a09080;padding-right:16px;">Address</td><td>${customer.address||'—'}</td></tr>
        </table>
        ${cartTable(cart, shipping)}
        <p style="color:#6dbf6d;font-size:13px;">💰 Collect ₹${total.toLocaleString('en-IN')} cash at delivery.</p>
      `),
    });
  }

  // ── 3. Confirmation email to CUSTOMER ─────────────────────────────────────
  if (customer.email) {
    await sendEmail({
      to: customer.email,
      subject: `Your Ink & Chai order is confirmed! (${orderId})`,
      html: emailBase(`
        <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">Order Confirmed 📚</h2>
        <p style="color:#a09080;line-height:1.8;margin-bottom:16px;">
          Hi ${customer.name?.split(' ')[0]||'there'}, your books are on their way!<br/>
          You'll pay <strong style="color:#c9a84c;">₹${total.toLocaleString('en-IN')}</strong> in cash when they arrive.
        </p>
        ${cartTable(cart, shipping)}
        <p style="color:#a09080;font-size:13px;line-height:1.8;">
          <strong style="color:#f0e8d8;">Delivery address:</strong><br/>${customer.address||'—'}
        </p>
        <p style="margin-top:16px;color:#7a6330;font-size:12px;">Order ID: <strong style="color:#c9a84c;">${orderId}</strong></p>
        <div style="margin-top:20px;padding:14px 16px;background:#1c1916;border-left:3px solid #c9a84c;">
          <p style="color:#f0e8d8;font-size:13px;margin:0 0 10px;">📦 Track your order any time</p>
          <a href="https://inkandchai.in/track/?id=${encodeURIComponent(orderId)}&q=${encodeURIComponent(customer.email||customer.phone)}" style="display:inline-block;background:#c9a84c;color:#0d0b08;padding:10px 22px;text-decoration:none;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:600;">Track Order →</a>
          <p style="color:#a09080;font-size:11px;line-height:1.7;margin:10px 0 0;">
            We'll email you again as soon as the courier picks up your books, with a tracking number you can use on the courier's site.
          </p>
        </div>
      `),
    });
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ success: true, order_id: orderId }),
  };
};
