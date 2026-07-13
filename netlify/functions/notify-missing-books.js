/**
 * Netlify Function: notify-missing-books
 * POST /.netlify/functions/notify-missing-books
 *
 * Admin endpoint — a delivered/completed order arrived INCOMPLETE (one or more
 * books were missing from the parcel). The admin picks the missing title(s) in
 * the order row and this notifies the customer:
 *   • email  — "incomplete order" template listing the missing book(s)
 *   • WhatsApp — template `order_incomplete` (env override), with a free-form
 *                text fallback for customers inside the 24h service window in
 *                case the template isn't approved yet.
 * It also flags the missing items on the order row (cart_items[i]._missing) and
 * pings the store owner so there's a record + a nudge to send a replacement or
 * refund.
 *
 * Body: { id?, order_ref?, missing: string[] }   // missing = book titles
 * Headers: X-Admin-Token / X-Admin-Key.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { sendEmail } = require('./utils/email');
const { sendWhatsApp, sendText } = require('./utils/whatsapp');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Admin-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const orderId = (o) => o.razorpay_order_id || o.id;

function missingEmailHtml(order, missing) {
  const first = String(order.customer_name || 'there').split(' ')[0];
  const rows = missing.map(t => `
    <tr><td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#f0e8d8;">📕 ${t}</td></tr>`).join('');
  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">inkandchai.in</p>
      <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">About your recent order</h2>
      <p style="color:#a09080;line-height:1.8;margin:14px 0;">
        Hi ${first}, we're really sorry — it looks like your Ink &amp; Chai order
        <strong style="color:#c9a84c;">${orderId(order)}</strong> reached you <strong style="color:#f0e8d8;">incomplete</strong>.
        The following ${missing.length > 1 ? 'books were' : 'book was'} missing from your parcel:
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:15px;background:#1c1916;">
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#a09080;line-height:1.8;margin:14px 0;">
        You won't be charged for anything you didn't receive. Just reply to this email
        or message us on WhatsApp and we'll send the missing ${missing.length > 1 ? 'books' : 'book'}
        or issue a refund — whichever you prefer.
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
      <h2 style="color:#e0a94a;font-size:20px;font-weight:400;">Incomplete order reported</h2>
      <p style="color:#a09080;font-size:13px;">Order ID: <strong style="color:#c9a84c;">${orderId(order)}</strong></p>
      <table style="font-size:14px;line-height:1.8;color:#f0e8d8;margin:10px 0;">
        <tr><td style="color:#a09080;padding-right:16px;">Name</td><td>${order.customer_name || '—'}</td></tr>
        <tr><td style="color:#a09080;padding-right:16px;">Phone</td><td>${order.customer_phone || '—'}</td></tr>
        <tr><td style="color:#a09080;padding-right:16px;">Email</td><td>${order.customer_email || '—'}</td></tr>
      </table>
      <p style="color:#a09080;margin:14px 0 6px;">Missing book(s) — the customer has been notified:</p>
      <ul style="margin:0 0 16px;padding-left:20px;">${rows}</ul>
      <p style="color:#a09080;font-size:13px;">Next: send a replacement (Replacement flow) or issue a refund from the admin panel.</p>
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#7a6330;font-size:11px;">Sent to the store owner &middot; inkandchai.in</p>
    </div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase env vars missing' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const id = String(body.id || '').trim();
  const orderRef = String(body.order_ref || '').trim();
  const missing = Array.from(new Set(
    (Array.isArray(body.missing) ? body.missing : [])
      .map(t => String(t || '').trim()).filter(Boolean)
  ));
  if (!id && !orderRef) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide order id' }) };
  if (!missing.length)  return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Select at least one missing book' }) };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const SEL = 'id, razorpay_order_id, customer_name, customer_phone, customer_email, cart_items, amount_paise, status';

    // Locate the order by ANY identifier we were given, robust to PK type
    // (uuid or bigint) and to older cached admin JS that sends only `id`.
    let order = null;
    const tryEq = async (col, val) => {
      if (order || !val) return;
      const r = await supabase.from('orders').select(SEL).eq(col, val).maybeSingle();
      if (!r.error && r.data) order = r.data;
    };
    await tryEq('id', id);
    await tryEq('razorpay_order_id', orderRef);
    await tryEq('razorpay_order_id', id);
    if (!order) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: `Order not found (id="${id}", ref="${orderRef}")` }) };
    }

    // Flag the missing items on the order row so the record persists. Match by
    // title (case-insensitive) against cart_items.
    const items = Array.isArray(order.cart_items) ? order.cart_items : [];
    const missLower = new Set(missing.map(t => t.toLowerCase()));
    const stampedItems = items.map(it => {
      const title = String(it?.title || it?.name || '').trim();
      return title && missLower.has(title.toLowerCase())
        ? { ...it, _missing: true, _missing_at: new Date().toISOString() }
        : it;
    });
    try {
      await supabase.from('orders').update({ cart_items: stampedItems }).eq('id', order.id);
    } catch (e) {
      console.error('[missing-books] flag update failed:', e.message);
    }

    const result = { email: false, whatsapp: false, ownerEmail: false };
    const first = String(order.customer_name || 'there').split(' ')[0];
    const missingList = missing.join(', ');

    // ── Customer email ──────────────────────────────────────────────────────
    if (order.customer_email) {
      const em = await sendEmail({
        to: order.customer_email,
        subject: `About your order ${orderId(order)} — a book was missing`,
        html: missingEmailHtml(order, missing),
      });
      result.email = !!em?.ok;
    }

    // ── Customer WhatsApp ─────────────────────────────────────────────────────
    // Template first (deliverable outside the 24h window); free-form text as a
    // fallback so the customer still hears from us if the template isn't live.
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
          `Hi ${first}, we're sorry — your Ink & Chai order ${orderId(order)} arrived incomplete. ` +
          `Missing: ${missingList}. We'll send the missing book(s) or refund you — just reply here and let us know which you'd prefer. 💛`
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
          subject: `📦 Incomplete order ${orderId(order)} — ${missingList}`,
          html: ownerMissingEmailHtml(order, missing),
        });
        result.ownerEmail = !!sent?.ok;
      } catch (e) {
        console.error('[missing-books] owner email:', e.message);
      }
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, id: order.id, missing, result }),
    };
  } catch (err) {
    console.error('notify-missing-books error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
