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
 * Body: { id: <order_id>, q: <email-or-phone>, missing: string[]|{title,qty}[],
 *         comment: string, upi_id: string }
 * `comment` is required (min 10 chars). `upi_id` is required on a pure-COD
 * order and ignored on any other — see the isDefinitelyCod block below.
 */

const { createClient } = require('@supabase/supabase-js');
const { isDefinitelyCod } = require('./utils/order-payment-kind');
const { normalizeUpiId, requireUpiId } = require('./utils/upi-id');
const { matchMissingItems, fileMissingBookReport } = require('./utils/missing-book-report');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// A missing-from-the-box report only makes sense once the customer actually
// holds the parcel — i.e. it's DELIVERED. shipped / out_for_delivery haven't
// arrived yet; rto / undelivered never reached the customer. Blocks all of
// those plus pending / cancelled / refunded.
const REPORTABLE = new Set(['delivered']);

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

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
  // REQUIRED customer note. Validated server-side (not just in the form) so the
  // owner always gets an account of what actually happened — an empty report
  // gives nothing to act on. Min length keeps it from being a single character.
  const comment = String(body.comment || '').trim().slice(0, 1000);
  const MIN_COMMENT = 10;
  // Required on a COD order, ignored on every other kind — and which one this
  // is cannot be known until the order is loaded, so the REQUIRED check waits
  // until below. The FORMAT check happens here so a typo comes back to the
  // customer while they are still looking at the form, with no database round
  // trip and no chance of it being mistaken for the missing-field message.
  const upi = normalizeUpiId(body.upi_id);
  if (!upi.ok && upi.reason) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: upi.reason, need_upi: true }) };
  }
  // Accept either legacy `missing: ["Title", ...]` or the new
  // `missing: [{ title, qty }, ...]`. Qty is validated/capped later against the
  // quantity actually ordered; null here means "default to the full ordered qty".
  const requested = [];
  const seenTitles = new Set();
  for (const m of (Array.isArray(body.missing) ? body.missing : [])) {
    let title = '', qty = null;
    if (typeof m === 'string') { title = m.trim(); }
    else if (m && typeof m === 'object') { title = String(m.title || '').trim(); const n = Number(m.qty); if (Number.isFinite(n) && n > 0) qty = Math.floor(n); }
    if (!title) continue;
    const key = title.toLowerCase();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    requested.push({ title, qty });
  }
  if (!id || !q)          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide order id and email/phone' }) };
  if (!requested.length)  return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Select at least one missing book' }) };
  if (comment.length < MIN_COMMENT) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({
      error: `Please tell us what happened (at least ${MIN_COMMENT} characters) — e.g. "the packet was open and one book was missing".`,
    }) };
  }

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
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'You can report a missing book only after the parcel is delivered.' }) };
    }

    // A prepaid refund goes back to the instrument that paid, so a UPI handle is
    // neither needed nor ours to keep. Only a pure-COD order has nowhere to send
    // money back to — and on those the handle is now REQUIRED rather than a
    // nice-to-have. What went wrong with asking nicely: the report is the one
    // moment the customer is engaged and wants something from us. Skip the field
    // then and it has to be collected later, from someone who has stopped
    // replying because as far as they know the matter is closed — so the money
    // owed for an unarrangeable book just sits there. Refusing the report is the
    // only lever that works, and the customer loses nothing by it: they are
    // three seconds from being able to submit.
    //
    // isDefinitelyCod fails closed, so partial COD (a deposit captured online)
    // and prepaid are never asked. `need_upi` tells the form which field to open
    // and focus — a page may have decided, on the looser signal it has, not to
    // render it at all.
    const isCod = isDefinitelyCod(order);
    if (isCod) {
      const required = requireUpiId(body.upi_id);
      if (!required.ok) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: required.reason, need_upi: true }) };
      }
    }
    const refundUpi = isCod ? upi.value : '';

    // Keep only titles in this order; clamp qty to [1, ordered] (the max limit).
    const { valid } = matchMissingItems(order, requested);
    if (!valid.length) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Selected book(s) are not part of this order.' }) };
    }

    // Stamp the report, create the free replacement, notify customer + owner.
    const result = await fileMissingBookReport(supabase, order, { valid, comment, refundUpi, photos: body.photos, via: 'website' });
    const missingLabels = result.missing;
    const replId = result.replacement_order_id;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, missing: missingLabels, replacement_order_id: replId, result }),
    };
  } catch (err) {
    console.error('report-missing-books error:', err.message);
    return { statusCode: err.statusCode || 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
