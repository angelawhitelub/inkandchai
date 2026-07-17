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

/**
 * Auto-create a FREE replacement order for just the missing book(s) — same
 * conventions as request-replacement.js (status replacement_pending, source
 * 'replacement', ₹0, `_replacement` meta on the first item) so it flows into
 * the existing unshipped list / NimbusPost push / admin replacement tooling.
 * Guard: at most ONE replacement per original order. Returns the new order id
 * or null (never throws — the report itself must still succeed).
 */
async function createMissingReplacement(supabase, order, missingItems) {
  try {
    // One replacement per original — matches request-replacement's abuse guard.
    const { data: existing } = await supabase
      .from('orders')
      .select('razorpay_order_id')
      .eq('source', 'replacement')
      .eq('cart_items->0->_replacement->>original_order_id', String(order.razorpay_order_id || order.id))
      .limit(1)
      .maybeSingle();
    if (existing) return { id: existing.razorpay_order_id, existed: true };

    const now = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
    const randPart = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
    const origIsCW = /^IC-CW-/i.test(String(order.razorpay_order_id || ''));
    const replId = origIsCW ? `IC-R-CW-${datePart}-${randPart}` : `IC-R-${datePart}-${randPart}`;

    // Cart = ONLY the missing books (fresh copies, without the _missing flags).
    const cart = missingItems.map(({ _missing, _missing_at, ...it }) => ({ ...it }));
    cart[0]._replacement = {
      original_order_id: order.razorpay_order_id || order.id,
      reason: 'missing_item',
      reason_label: 'Item missing from package',
      note: 'Auto-created from the customer\'s missing-book report.',
      requested_at: now.toISOString(),
    };

    const { error } = await supabase.from('orders').insert({
      razorpay_order_id:   replId,
      razorpay_payment_id: null,
      amount_paise:        0,                       // free reshipment
      status:              'replacement_pending',
      customer_name:       order.customer_name || '',
      customer_email:      order.customer_email || '',
      customer_phone:      order.customer_phone || '',
      customer_address:    order.customer_address || '',
      cart_items:          cart,
      ...(order.user_id ? { user_id: order.user_id } : {}),
      source:              'replacement',
    });
    if (error) throw error;
    return { id: replId, existed: false };
  } catch (e) {
    console.error('[report-missing-books] replacement create failed:', e.message);
    return null;
  }
}

function missingEmailHtml(order, missing, replId) {
  const first = String(order.customer_name || 'there').split(' ')[0];
  const rows = missing.map(t => `
    <tr><td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#f0e8d8;">📕 ${t}</td></tr>`).join('');
  const nextStep = replId
    ? `
      <div style="margin:18px 0;padding:16px;background:#152315;border-left:3px solid #6dbf6d;">
        <p style="color:#f0e8d8;margin:0 0 6px;font-size:15px;">✅ <strong>Replacement created — nothing to pay.</strong></p>
        <p style="color:#a09080;margin:0;line-height:1.8;">
          We've automatically created a <strong style="color:#c9a84c;">free replacement order ${replId}</strong>
          for the missing ${missing.length > 1 ? 'books' : 'book'}. It ships at no charge and we'll send you
          tracking details as soon as it's dispatched.
        </p>
      </div>
      <p style="color:#a09080;line-height:1.8;margin:14px 0;">
        Prefer a refund instead? Just reply to this email or message us on WhatsApp and we'll switch it.
      </p>`
    : `
      <p style="color:#a09080;line-height:1.8;margin:14px 0;">
        Our team has been alerted and will reach out shortly. You won't be charged for anything you
        didn't receive — we'll send the missing ${missing.length > 1 ? 'books' : 'book'} or issue a
        refund, whichever you prefer. Just reply to this email or message us on WhatsApp.
      </p>`;
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
      ${nextStep}
      <p style="color:#a09080;font-size:13px;line-height:1.8;">Thank you for your patience — we'll make this right. 💛</p>
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai &middot; support@inkandchai.in</p>
    </div>`;
}

function ownerMissingEmailHtml(order, missing, replId) {
  const rows = missing.map(t => `<li style="margin:4px 0;color:#f0e8d8;">${t}</li>`).join('');
  const nextLine = replId
    ? `<p style="color:#6dbf6d;font-size:14px;">✅ Replacement order <strong style="color:#c9a84c;">${replId}</strong> was created automatically (₹0, only the missing book${missing.length > 1 ? 's' : ''}). It's in the unshipped list — ship it from the Orders tab. The customer has been notified.</p>`
    : `<p style="color:#a09080;font-size:13px;">Next: send a replacement (Replacement flow) or issue a refund from the admin panel. The customer has been emailed a confirmation.</p>`;
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
      ${nextLine}
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

    // ── Auto-create the FREE replacement order for the missing book(s) ───────
    const missingItems = stampedItems.filter(it => it && it._missing);
    const repl = await createMissingReplacement(supabase, order, missingItems);
    const replId = repl?.id || null;

    const result = { email: false, whatsapp: false, ownerEmail: false, replacement_order_id: replId, replacement_existed: !!repl?.existed };
    const first = String(order.customer_name || 'there').split(' ')[0];
    const missingList = valid.join(', ');

    // ── Customer email confirmation ──────────────────────────────────────────
    if (order.customer_email) {
      const em = await sendEmail({
        to: order.customer_email,
        subject: replId
          ? `Replacement on the way — order ${replId}`
          : `We've noted your incomplete order ${orderId(order)}`,
        html: missingEmailHtml(order, valid, replId),
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
        // Follow-up text with the replacement id (in-window after the template).
        if (replId && !repl.existed) {
          await sendText(
            order.customer_phone,
            `📦 Good news ${first} — we've created a free replacement order ${replId} for: ${missingList}. It ships at no charge and you'll get tracking as soon as it's dispatched.`
          ).catch(() => {});
        }
      } else {
        const txt = await sendText(
          order.customer_phone,
          `Hi ${first}, thanks for reporting that your Ink & Chai order ${orderId(order)} arrived incomplete. ` +
          `Missing: ${missingList}. ` +
          (replId
            ? `We've created a free replacement order ${replId} — it ships at no charge and you'll get tracking once dispatched. 💛`
            : `Our team will reach out — we'll send the missing book(s) or refund you. 💛`)
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
          subject: replId
            ? `📦 Incomplete order ${orderId(order)} → replacement ${replId} created — ${missingList}`
            : `📦 Customer reported incomplete order ${orderId(order)} — ${missingList}`,
          html: ownerMissingEmailHtml(order, valid, replId),
        });
        result.ownerEmail = !!sent?.ok;
      } catch (e) {
        console.error('[report-missing-books] owner email:', e.message);
      }
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, missing: valid, replacement_order_id: replId, result }),
    };
  } catch (err) {
    console.error('report-missing-books error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
