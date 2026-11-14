/**
 * Netlify Function: review-start
 * POST /.netlify/functions/review-start   { order_id, phone, slug }
 *
 * "Write a review" on a book page. Book pages have no sign-in, so the buyer
 * proves the order is theirs with its order id plus the phone number on it.
 * On a match we hand back the same signed /review/ link the WhatsApp review
 * request carries (utils/review-token.js), and the existing review page and
 * submit-review do the rest. Reviews written this way still wait for admin
 * approval, like every customer review.
 *
 * Any mismatch (no such order, wrong phone) gets one generic answer, so this
 * cannot be used to learn whether an order id exists or whose it is. Nothing
 * about the order is returned beyond the link.
 */

const { createClient } = require('@supabase/supabase-js');
const { findOrderByRef } = require('./utils/order-ref');
const { signReviewToken } = require('./utils/review-token');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const NO_MATCH = "We couldn't find an order with that order ID and phone number. Check both — the order ID is in your order confirmation email and WhatsApp (it looks like IC-20261104-AB12C).";

/** "ic 20261104 pbwyr", "IC20261104PBWYR", "IC-20261104 PBWYR" → "IC-20261104-PBWYR". */
function normalizeOrderId(raw) {
  let s = String(raw || '').toUpperCase().trim().replace(/[\s_]+/g, '-').replace(/[^A-Z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const m = s.match(/^(IC|PB)-?(\d{8})-?([A-Z0-9]{4,}(?:-[A-Z0-9]+)*)$/);
  if (m) s = `${m[1]}-${m[2]}-${m[3]}`;
  return s.slice(0, 64);
}

const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const slugOf = (i) => String((i && (i.slug || i.id)) || '').replace(/^\/product\//, '').replace(/\/$/, '').toLowerCase();

/**
 * Pure decision, for tests: given the order row (or null) and the request,
 * what to answer.
 */
function decide(order, { phone, slug }) {
  if (!order || last10(phone).length !== 10 || last10(order.customer_phone) !== last10(phone)) {
    return { status: 404, body: { error: NO_MATCH } };
  }
  if (String(order.status || '').toLowerCase() !== 'delivered') {
    return { status: 409, body: { error: 'This order has not been delivered yet. You can review it once it arrives.' } };
  }
  const id = order.razorpay_order_id;
  const t = signReviewToken(id);
  if (!t) return { status: 500, body: { error: 'Reviews are not available right now. Please try again later.' } };
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const has = !slug || items.some((i) => slugOf(i) === String(slug).toLowerCase());
  const url = `/review/?order=${encodeURIComponent(id)}${has && slug ? `&product=${encodeURIComponent(slug)}` : ''}&t=${encodeURIComponent(t)}`;
  if (!has) {
    return { status: 200, body: { url, in_order: false, message: "This book isn't on that order, but you can review the books that are." } };
  }
  return { status: 200, body: { url, in_order: true } };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request' }); }
  const orderId = normalizeOrderId(body.order_id);
  const phone = String(body.phone || '');
  const slug = String(body.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 160);
  if (!orderId || orderId.length < 5) return json(400, { error: 'Enter your order ID (the last 5 characters are enough).' });
  if (last10(phone).length !== 10) return json(400, { error: 'Enter the 10-digit phone number you ordered with.' });

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    // The full order id or just its 5-character short code (utils/order-ref.js).
    const found = await findOrderByRef(supabase, orderId,
      (o) => last10(phone).length === 10 && last10(o.customer_phone) === last10(phone),
      { select: 'razorpay_order_id, customer_phone, status, cart_items' });
    if (found.error) throw found.error;
    if (found.hint) return json(404, { error: found.hint });
    const out = decide(found.order || null, { phone, slug });
    if (out.status !== 200) console.log(`[review-start] ${out.status} ${orderId.slice(0, 12)}…`);
    return json(out.status, out.body);
  } catch (err) {
    console.error('[review-start]', err.message);
    return json(500, { error: 'Could not check that order right now. Please try again.' });
  }
};

exports._test = { normalizeOrderId, decide };
