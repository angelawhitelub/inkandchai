/**
 * Netlify Function: report-missing-books
 * POST /.netlify/functions/report-missing-books
 *
 * PUBLIC (customer-facing) endpoint — used from the /track order page. A
 * customer whose delivered parcel was missing one or more books selects the
 * missing title(s) and submits. Ownership is verified the SAME way as
 * track-order (order id + the email/phone used at checkout must match) so no
 * one can report on someone else's order.
 *
 * On success it:
 *   • emails the CUSTOMER a confirmation listing the missing book(s),
 *   • WhatsApps the customer (template order_incomplete, text fallback),
 *   • flags the items on the order (cart_items[i]._missing),
 *   • emails the store OWNER so a replacement/refund can be arranged.
 *
 * Body: { id: <order_id>, q: <email-or-phone>, missing: string[] }  // titles
 */

const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('./utils/email');
const { sendWhatsApp, sendText } = require('./utils/whatsapp');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// Only orders that could plausibly have been received can be reported as
// incomplete. Blocks pending/cancelled/refunded orders.
const REPORTABLE = new Set(['shipped', 'out_for_delivery', 'delivered', 'rto', 'undelivered']);

const orderId = (o) => o.razorpay_order_id || o.id;
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

function missingEmailHtml(order, missing) {
  const first = String(order.customer_name || 'there').split(' ')[0];
  const rows = missing.map(t => `
    <tr><td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#f0e8d8;">📕 ${t}</td></tr>`).join('');
  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">inkandchai.in</p>
      <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">We've noted your incomplete order</h2>
      <p style="color:#a09080;line-height:1.8;margin:14px 0;">
        Hi ${first}, thanks for letting us know. You reported that your Ink &amp; Chai order
        <strong style="color:#c9a84c;">${orderId(order)}</strong> arrived <strong style="color:#f0e8d8;">incomplete</strong>.
        The following ${missing.length > 1 ? 'books were' : 'book was'} missing from your parcel:
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:15px;background:#1c1916;">
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#a09080;line-height:1.8;margin:14px 0;">
        Our team has been alerted and will reach out shortly. You won't be charged for anything you
        didn't receive — we'll send the missing ${missing.length > 1 ? 'books' : 'book'} or issue a
        refund, whichever you prefer. Just reply to this email or message us on WhatsApp.
      </p>
      <p style="color:#a09080;font-size:13px;line-height:1.8;">Thank you for your patience — we'll make this right. 💛</p>
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai &middot; support@inkandchai.in</p>
    </div>`;
}

function ownerMissingEmailHtml(order, missing) {
  const rows = missing.map(t => `<li style="margin:4px 0;color:#f0e8d8;">${t}</li>`).join('');
  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:22px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:24px;">Admin notification</p>
      <h2 style="color:#e0a94a;font-size:20px;font-weight:400;">Customer reported an incomplete order</h2>
      <p style="color:#a09080;font-size:13px;">Order ID: <strong style="color:#c9a84c;">${orderId(order)}</strong> &middot; status: ${order.status || '—'}</p>
      <table style="font-size:14px;line-height:1.8;color:#f0e8d8;margin:10px 0;">
        <tr><td style="color:#a09080;padding-right:16px;">Name</td><td>${order.customer_name || '—'}</td></tr>
        <tr><td style="color:#a09080;padding-right:16px;">Phone</td><td>${order.customer_phone || '—'}</td></tr>
        <tr><td style="color:#a09080;padding-right:16px;">Email</td><td>${order.customer_email || '—'}</td></tr>
      </table>
      <p style="color:#a09080;margin:14px 0 6px;">Missing book(s) the customer flagged:</p>
      <ul style="margin:0 0 16px;padding-left:20px;">${rows}</ul>
      <p style="color:#a09080;font-size:13px;">Next: send a replacement (Replacement flow) or issue a refund from the admin panel. The customer has been emailed a confirmation.</p>
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#7a6330;font-size:11px;">Sent to the store owner &middot; inkandchai.in</p>
    </div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase env vars missing' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const id = String(body.id || '').trim().replace(/\s+/g, '');
  const q  = String(body.q  || '').trim();
  const missing = Array.from(new Set(
    (Array.isArray(body.missing) ? body.missing : [])
      .map(t => String(t || '').trim()).filter(Boolean)
  ));
  if (!id || !q)       return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide order id and email/phone' }) };
  if (!missing.length) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Select at least one missing book' }) };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Look up by razorpay_order_id — exact first (case-sensitive Razorpay ids),
    // then case-insensitive fallback for IC- ids typed in the wrong case.
    let { data: order } = await supabase.from('orders').select('*').eq('razorpay_order_id', id).limit(1).maybeSingle();
    if (!order) {
      const r2 = await supabase.from('orders').select('*').ilike('razorpay_order_id', id).limit(1).maybeSingle();
      order = r2.data || null;
    }
    if (!order) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Order not found. Check the order ID and try again.' }) };
    }

    // Verify ownership — same rule as track-order (email OR last-10 of phone).
    const qn = norm(q);
    const qDigits = qn.replace(/\D/g, '');
    const emailOk = order.customer_email && norm(order.customer_email) === qn;
    const phoneOk = order.customer_phone && qDigits.length >= 10 && norm(order.customer_phone).replace(/\D/g, '').slice(-10) === qDigits.slice(-10);
    if (!emailOk && !phoneOk) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Email or phone does not match this order.' }) };
    }

    if (!REPORTABLE.has(String(order.status || '').toLowerCase())) {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'This order can only be reported as incomplete once it has been shipped or delivered.' }) };
    }

    // Only accept titles that are actually in this order.
    const items = Array.isArray(order.cart_items) ? order.cart_items : [];
    const titleSet = new Set(items.map(i => String(i?.title || i?.name || '').trim().toLowerCase()).filter(Boolean));
    const valid = missing.filter(t => titleSet.has(t.toLowerCase()));
    if (!valid.length) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Selected book(s) are not part of this order.' }) };
    }

    // Flag the missing items on the order row (idempotent).
    const validLower = new Set(valid.map(t => t.toLowerCase()));
    const stampedItems = items.map(it => {
      const title = String(it?.title || it?.name || '').trim();
      return title && validLower.has(title.toLowerCase())
        ? { ...it, _missing: true, _missing_at: new Date().toISOString() }
        : it;
    });
    try {
      await supabase.from('orders').update({ cart_items: stampedItems }).eq('id', order.id);
    } catch (e) {
      console.error('[report-missing-books] flag update failed:', e.message);
    }

    const result = { email: false, whatsapp: false, ownerEmail: false };
    const first = String(order.customer_name || 'there').split(' ')[0];
    const missingList = valid.join(', ');

    // ── Customer email confirmation ──────────────────────────────────────────
    if (order.customer_email) {
      const em = await sendEmail({
        to: order.customer_email,
        subject: `We've noted your incomplete order ${orderId(order)}`,
        html: missingEmailHtml(order, valid),
      });
      result.email = !!em?.ok;
    }

    // ── Customer WhatsApp — template first, free-form text fallback ───────────
    if (order.customer_phone) {
      const wa = await sendWhatsApp({
        to: order.customer_phone,
        template: process.env.WHATSAPP_MISSING_BOOKS_TEMPLATE || 'order_incomplete',
        params: [first, orderId(order), missingList],
      });
      if (wa?.ok) {
        result.whatsapp = true;
      } else {
        const txt = await sendText(
          order.customer_phone,
          `Hi ${first}, thanks for reporting that your Ink & Chai order ${orderId(order)} arrived incomplete. ` +
          `Missing: ${missingList}. Our team will reach out — we'll send the missing book(s) or refund you. 💛`
        );
        result.whatsapp = !!txt?.ok;
        result.whatsapp_fallback = !!txt?.ok;
      }
    }

    // ── Owner notification ────────────────────────────────────────────────────
    const ownerEmail = process.env.STORE_OWNER_EMAIL;
    if (ownerEmail) {
      try {
        const sent = await sendEmail({
          to: ownerEmail,
          subject: `📦 Customer reported incomplete order ${orderId(order)} — ${missingList}`,
          html: ownerMissingEmailHtml(order, valid),
        });
        result.ownerEmail = !!sent?.ok;
      } catch (e) {
        console.error('[report-missing-books] owner email:', e.message);
      }
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, missing: valid, result }),
    };
  } catch (err) {
    console.error('report-missing-books error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
