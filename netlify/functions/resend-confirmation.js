/**
 * Netlify Function: resend-confirmation
 * POST /.netlify/functions/resend-confirmation
 * Headers: X-Admin-Key
 * Body: { order_id: "IC-20260621-XDAAB" }
 *
 * Re-sends the order-confirmation WhatsApp (and email if present) for an existing
 * order. Used from the admin panel when a webhook-recovered order never notified
 * the customer (e.g. WhatsApp delivery failed, or email was missing).
 */

const { createClient } = require('@supabase/supabase-js');
const { sendWhatsApp } = require('./utils/whatsapp');
const { sendEmail }    = require('./utils/email');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

function emailBase(content) {
  return `<div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
    <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
    <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">inkandchai.in</p>
    ${content}
    <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
    <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai · inkandchai.in</p>
  </div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  // Admin auth
  const adminKey = process.env.ADMIN_SECRET;
  const sentKey  = event.headers['x-admin-key'];
  if (!adminKey || sentKey !== adminKey) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const orderId = String(body.order_id || '').trim();
  if (!orderId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'order_id required' }) };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: order, error } = await supabase
    .from('orders').select('*').eq('razorpay_order_id', orderId).maybeSingle();
  if (error || !order) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Order not found' }) };
  }

  const firstName  = String(order.customer_name || 'there').split(' ')[0];
  const phone      = String(order.customer_phone || '').trim();
  const email      = String(order.customer_email || '').trim();
  const address    = String(order.customer_address || '').trim();
  const amount     = Math.round((order.amount_paise || 0) / 100);
  const amtDisplay = `₹${amount.toLocaleString('en-IN')}`;
  const cart       = Array.isArray(order.cart_items) ? order.cart_items : [];
  const bookList   = cart.map(i => i.title || i.name || '').filter(Boolean).join(', ').slice(0, 200) || 'your books';
  const addrShort  = address.slice(0, 80);

  const result = { wa: null, email: null };

  if (phone) {
    try {
      const r = await sendWhatsApp({
        to: phone,
        template: 'order_confirmed',
        params: [firstName, orderId, amtDisplay, addrShort, bookList],
      });
      result.wa = { ok: true, message_id: r?.messages?.[0]?.id || '' };
      console.log(`[resend-confirmation] WA ok [${orderId}] → ${phone}: ${result.wa.message_id}`);
    } catch (e) {
      result.wa = { ok: false, error: e.message };
      console.error(`[resend-confirmation] WA FAILED [${orderId}] → ${phone}:`, e.message);
    }
  } else {
    result.wa = { ok: false, error: 'no phone on order' };
  }

  if (email) {
    try {
      await sendEmail({
        to: email,
        subject: `Your Ink & Chai order confirmation (${orderId})`,
        html: emailBase(`
          <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">Order Confirmed 📚</h2>
          <p style="color:#a09080;line-height:1.8;margin-bottom:16px;">
            Hi ${firstName}, here's a fresh copy of your order confirmation.<br/>
            Amount: <strong style="color:#c9a84c;">${amtDisplay}</strong><br/>
            ${bookList ? `Books: <strong style="color:#f0e8d8;">${bookList}</strong>` : ''}
          </p>
          <p style="color:#a09080;font-size:13px;"><strong style="color:#f0e8d8;">Delivery address:</strong><br/>${address || '—'}</p>
          <p style="margin-top:16px;color:#7a6330;font-size:12px;">Order ID: <strong style="color:#c9a84c;">${orderId}</strong></p>
          <div style="margin-top:20px;padding:14px 16px;background:#1c1916;border-left:3px solid #c9a84c;">
            <p style="color:#f0e8d8;font-size:13px;margin:0 0 10px;">📦 Track your order any time</p>
            <a href="https://inkandchai.in/track/?id=${encodeURIComponent(orderId)}&q=${encodeURIComponent(email || phone || '')}" style="display:inline-block;background:#c9a84c;color:#0d0b08;padding:10px 22px;text-decoration:none;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:600;">Track Order →</a>
          </div>
        `),
      });
      result.email = { ok: true };
    } catch (e) {
      result.email = { ok: false, error: e.message };
      console.error(`[resend-confirmation] email FAILED [${orderId}] → ${email}:`, e.message);
    }
  } else {
    result.email = { ok: false, error: 'no email on order' };
  }

  const anyOk = result.wa?.ok || result.email?.ok;
  return {
    statusCode: anyOk ? 200 : 500,
    headers: CORS,
    body: JSON.stringify({ success: anyOk, order_id: orderId, result }),
  };
};
