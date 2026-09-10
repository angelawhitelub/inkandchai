/**
 * Netlify Function: submit-refund-upi
 * GET  /.netlify/functions/submit-refund-upi?id=IC-R-…&t=<token>   → form context
 * POST /.netlify/functions/submit-refund-upi                       → save the UPI id
 *
 * The customer-facing half of the refund-UPI flow. request-refund-upi emails a
 * signed link for one cancelled missing-book replacement; this serves the little
 * that the form needs and takes back the one field it collects.
 *
 * GET and POST live in one file on purpose: they are the same resource behind
 * the same token check, and splitting them would mean two copies of the lookup
 * and every guard below.
 *
 * Two ways in:
 *   • the signed token from the email — the customer's credential
 *   • an admin key — for the customer who replies by WhatsApp or on the phone,
 *     so the handle still lands in one place instead of a note somewhere
 *
 * Deliberately NOT returned: address, phone, email, payment or refund state. A
 * "where should we send your refund" form has no use for any of it, and the
 * token must not become a way to read an order.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyRefundUpiToken } = require('./utils/refund-upi-token');
const { normalizeUpiId } = require('./utils/upi-id');
const { isAdminAuthed } = require('./utils/admin-auth');
const { sendEmail } = require('./utils/email');
const {
  replacementMeta,
  isMissingBookReplacement,
  refundSplitPaise,
} = require('./utils/missing-books');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const rupees = (paise) => (Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function loadReplacement(sb, id) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const { data, error } = await sb
    .from('orders').select('*')
    .eq(isUuid ? 'id' : 'razorpay_order_id', id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/** Amount owed by UPI, preferring the figure the admin actually emailed. */
async function amountOwedPaise(sb, repl, meta) {
  const emailed = Number(meta.upi_requested_amount_paise);
  if (Number.isFinite(emailed) && emailed > 0) return emailed;
  const originalId = String(meta.original_order_id || '').trim();
  const { data: original } = originalId
    ? await sb.from('orders').select('razorpay_payment_id, amount_paise').eq('razorpay_order_id', originalId).maybeSingle()
    : { data: null };
  return refundSplitPaise(repl, original).upiPaise;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const admin = isAdminAuthed(event);
  const q = event.queryStringParameters || {};

  let body = {};
  if (event.httpMethod === 'POST') {
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON' }); }
  } else if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method Not Allowed' });
  }

  const id = String(body.id || q.id || '').trim();
  const token = String(body.t || body.token || q.t || q.token || '').trim();
  if (!id) return json(400, { error: 'Missing order id' });
  if (!admin && !verifyRefundUpiToken(id, token)) {
    return json(403, { error: 'This link is not valid any more. Reply to our email with your UPI ID and we will take it from there.' });
  }

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const repl = await loadReplacement(sb, id);
    if (!repl) return json(404, { error: 'We could not find that order.' });

    const meta = replacementMeta(repl);
    if (!meta || !isMissingBookReplacement(repl)) {
      return json(400, { error: 'That order is not a missing-book replacement.' });
    }
    if (String(repl.status || '').toLowerCase() !== 'cancelled') {
      return json(400, { error: 'Good news — this replacement has not been cancelled, so your books are still on their way. Nothing to refund.' });
    }

    const owedPaise = await amountOwedPaise(sb, repl, meta);
    const items = Array.isArray(repl.cart_items) ? repl.cart_items : [];

    if (event.httpMethod === 'GET') {
      return json(200, {
        order_id: meta.original_order_id || repl.razorpay_order_id || repl.id,
        first_name: String(repl.customer_name || '').split(' ')[0] || '',
        books: items.map(it => ({
          title: String((it && (it.title || it.name)) || 'Book'),
          qty: Number(it && it.qty) > 0 ? Number(it.qty) : 1,
        })),
        amount_paise: owedPaise,
        // Lets the page say "we already have this" instead of silently
        // overwriting a handle the customer gave us last week.
        existing_upi_id: meta.refund_upi_id || '',
      });
    }

    const upi = normalizeUpiId(body.upi_id);
    if (!upi.ok) {
      return json(400, { error: upi.reason || 'Please enter your UPI ID — for example 9876543210@ybl.' });
    }

    const cart = JSON.parse(JSON.stringify(items));
    const idx = cart.findIndex(it => it && it._replacement);
    if (idx < 0) return json(500, { error: 'This order is missing its replacement details.' });
    const previous = cart[idx]._replacement.refund_upi_id || '';
    cart[idx]._replacement = {
      ...cart[idx]._replacement,
      refund_upi_id: upi.value,
      refund_upi_at: new Date().toISOString(),
      refund_upi_source: admin ? 'admin' : 'customer',
    };

    const { error: upErr } = await sb.from('orders').update({ cart_items: cart }).eq('id', repl.id);
    if (upErr) throw upErr;

    // Tell the shop, because nothing else will: this is the signal that a payout
    // is now possible, and it is the only step in the chain a person must do.
    const owner = process.env.STORE_OWNER_EMAIL;
    if (owner && !admin) {
      sendEmail({
        to: owner,
        subject: `💸 UPI ID received — pay ₹${rupees(owedPaise)} for ${meta.original_order_id || repl.razorpay_order_id}`,
        html: `
          <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:28px;">
            <h2 style="color:#c9a84c;font-weight:400;margin:0 0 16px;">Refund payout ready</h2>
            <p style="color:#a09080;line-height:1.8;margin:0 0 14px;">
              ${esc(repl.customer_name || 'The customer')} gave us a UPI ID for the cancelled missing-book
              replacement <strong style="color:#c9a84c;">${esc(repl.razorpay_order_id || repl.id)}</strong>
              (original ${esc(meta.original_order_id || '—')}).
            </p>
            <div style="margin:0 0 16px;padding:14px;background:#152315;border-left:3px solid #6dbf6d;">
              <p style="color:#a09080;margin:0 0 4px;font-size:12px;letter-spacing:1px;text-transform:uppercase;">Pay</p>
              <p style="color:#f0e8d8;margin:0 0 10px;font-size:24px;">&#8377; ${rupees(owedPaise)}</p>
              <p style="color:#a09080;margin:0 0 4px;font-size:12px;letter-spacing:1px;text-transform:uppercase;">To</p>
              <p style="color:#f0e8d8;margin:0;font-size:18px;font-family:ui-monospace,Menlo,monospace;">${esc(upi.value)}</p>
            </div>
            ${previous && previous !== upi.value
              ? `<p style="color:#e8a030;line-height:1.7;margin:0 0 14px;">Note: this replaces the earlier handle <strong>${esc(previous)}</strong>.</p>`
              : ''}
            <p style="color:#7a6f5f;font-size:13px;line-height:1.7;margin:0;">
              Mark it paid in the admin panel's Missing Books tab once the transfer is done.
            </p>
          </div>`,
      }).catch(e => console.error('[submit-refund-upi] owner email:', e.message));
    }

    return json(200, { ok: true, upi_id: upi.value, amount_paise: owedPaise });
  } catch (e) {
    console.error('[submit-refund-upi]', e);
    return json(500, { error: e.message || 'Could not save that right now. Please try again.' });
  }
};
