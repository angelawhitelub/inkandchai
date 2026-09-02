/**
 * Netlify Function: link-order
 * POST /.netlify/functions/link-order
 *
 * Attach an existing order to the signed-in account.
 *
 * Customers routinely check out with one email and sign in with another — a
 * Google account, a work address — and then find My Orders empty for an order
 * that has already been delivered. get-my-orders can only match what checkout
 * recorded, so there was no way for them to fix it themselves.
 *
 * Proof required is exactly what /track/ already asks for: the order ID plus
 * the email or phone that is ON the order. Nothing weaker — an order ID alone
 * is guessable enough (IC-YYYYMMDD-XXXXX) that it must never be sufficient to
 * pull someone else's order into your account.
 *
 * On success the order's user_id is stamped, and get-my-orders picks it up
 * from then on.
 *
 * Body: { order_id: "IC-...", proof: "email-or-phone" }
 * Auth: Authorization: Bearer <supabase access token>
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function norm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ''); }
function digits10(s) { const d = String(s || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; }

/**
 * Does `proof` identify the person who placed this order?
 * Same rule as track-order: full email match, or the last 10 phone digits.
 */
function proofMatchesOrder(order, proof) {
  const qn = norm(proof);
  if (!qn) return false;
  if (order.customer_email && norm(order.customer_email) === qn) return true;
  const wanted = digits10(qn);
  return !!(wanted && digits10(order.customer_phone) === wanted);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // Same normalisation as track-order: strip internal whitespace, never
  // uppercase (legacy Razorpay order_ ids are case-sensitive).
  const orderId = String(body.order_id || '').trim().replace(/\s+/g, '');
  const proof   = String(body.proof || '').trim();
  if (!orderId || !proof) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Order ID and the email or phone used at checkout are both required.' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Who is asking ─────────────────────────────────────────────────────────
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Sign in to link an order.' }) };
  }
  let user = null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (!error) user = data?.user || null;
  } catch (e) { /* handled below */ }
  if (!user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Your session has expired. Sign in again.' }) };
  }

  try {
    // ── Find the order ──────────────────────────────────────────────────────
    let { data: order, error } = await supabase
      .from('orders').select('*').eq('razorpay_order_id', orderId).limit(1).maybeSingle();
    if (error) throw error;
    if (!order) {
      const r2 = await supabase
        .from('orders').select('*').ilike('razorpay_order_id', orderId).limit(1).maybeSingle();
      if (!r2.error) order = r2.data;
    }
    if (!order) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Order not found. Check the order ID and try again.' }) };
    }

    // ── Prove it is theirs ──────────────────────────────────────────────────
    if (!proofMatchesOrder(order, proof)) {
      // Deliberately the same wording as track-order, and deliberately no hint
      // about what IS on the order.
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Email or phone does not match this order. Please use the same email/phone you used at checkout.' }) };
    }

    // Already someone else's. Not an error worth explaining in detail — say it
    // is already linked and stop.
    if (order.user_id && order.user_id !== user.id) {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'This order is already linked to another account.' }) };
    }
    if (order.user_id === user.id) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, already_linked: true, order_id: order.razorpay_order_id }) };
    }

    const { error: upErr } = await supabase
      .from('orders').update({ user_id: user.id }).eq('id', order.id);
    if (upErr) throw upErr;

    // Link every other order that carries the same checkout identity, so a
    // customer who ordered three times under one email does not have to repeat
    // this three times. Each one is matched on the identity they just proved.
    const alsoLinked = [];
    const sameEmail = order.customer_email || '';
    const samePhone10 = digits10(order.customer_phone);
    const candidates = new Map();
    const collect = rows => (rows || []).forEach(r => { if (r.id !== order.id && !r.user_id) candidates.set(r.id, r); });
    if (sameEmail) {
      const { data } = await supabase
        .from('orders').select('id,razorpay_order_id,customer_email,customer_phone,user_id')
        .ilike('customer_email', sameEmail).limit(100);
      collect(data);
    }
    if (samePhone10) {
      // customer_phone is stored raw, +91-prefixed, and with spaces, so widen
      // in SQL and settle it on the normalised last 10 digits in JS — the same
      // two-step get-my-orders uses.
      const { data } = await supabase
        .from('orders').select('id,razorpay_order_id,customer_email,customer_phone,user_id')
        .ilike('customer_phone', `%${samePhone10.slice(-4)}`).limit(200);
      collect((data || []).filter(r => digits10(r.customer_phone) === samePhone10));
    }
    for (const sib of candidates.values()) {
      const emailSame = sameEmail && norm(sib.customer_email) === norm(sameEmail);
      const phoneSame = samePhone10 && digits10(sib.customer_phone) === samePhone10;
      if (!emailSame && !phoneSame) continue;
      const { error: sErr } = await supabase.from('orders').update({ user_id: user.id }).eq('id', sib.id);
      if (!sErr) alsoLinked.push(sib.razorpay_order_id);
    }

    console.log(`[link-order] ${user.id} linked ${order.razorpay_order_id}` +
                (alsoLinked.length ? ` (+${alsoLinked.length} more)` : ''));

    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      success: true,
      order_id: order.razorpay_order_id,
      also_linked: alsoLinked,
      message: alsoLinked.length
        ? `Order linked, along with ${alsoLinked.length} other order${alsoLinked.length === 1 ? '' : 's'} placed with the same details.`
        : 'Order linked to your account.',
    }) };
  } catch (err) {
    console.error('link-order error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

exports._test = { proofMatchesOrder, norm, digits10 };
