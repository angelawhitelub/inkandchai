/**
 * Customer feedback on the website and on ordering.
 *
 * POST /.netlify/functions/site-feedback
 *   { kind: 'website'|'order', rating 1-5, visitor_id, order_id?, comment?, page_url?, device? }
 *   Public, from public/js/site-feedback.js. Rating again, or adding a comment
 *   after the stars, updates the same row (one per visitor for the website, one
 *   per order for ordering).
 *
 * GET /.netlify/functions/site-feedback?kind=order&max_rating=3&with_comment=1&limit=150
 *   Admin. → { feedback: [...], stats: { website, order }, table_missing? }
 *   Ordering rows come back with the order's customer name, amount and status,
 *   so a 1-star can be followed up.
 *
 * Ordering feedback is checked against the orders table. The confirmation
 * screen has the order id in hand, but so could anyone typing one in, so a
 * rating is only linked to an order that exists (order_verified). The paid
 * flow can hand over a payment id rather than the order id, so both are tried.
 *
 * Posts are anonymous: same origin check and per-IP limiter as Ink AI. Saving
 * a rating must never put an error in front of a customer who just paid, so
 * failures are logged and the page is told only that it did not stick.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { parseFeedback, summarise, KINDS } = require('./utils/site-feedback');
const { ALLOWED_ORIGINS, overEdgeLimit } = require('./ink-ai');

const TABLE = 'site_feedback';
const MISSING_TABLE = /relation .* does not exist|Could not find the table/i;

const headers = (origin) => ({
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': origin || ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
});
const json = (statusCode, body, origin) => ({ statusCode, headers: headers(origin), body: JSON.stringify(body) });

const db = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Isolate-local backstop. A person rates once or twice.
const HITS = new Map();
function throttled(ip) {
  const now = Date.now();
  const hits = (HITS.get(ip) || []).filter(t => now - t < 60_000);
  hits.push(now);
  HITS.set(ip, hits);
  if (HITS.size > 5000) HITS.clear();
  return hits.length > 8;
}

/** The real order id for what the confirmation screen passed, or null. */
async function findOrder(client, ref) {
  for (const col of ['razorpay_order_id', 'razorpay_payment_id']) {
    const { data } = await client.from('orders').select('razorpay_order_id').eq(col, ref).limit(1).maybeSingle();
    if (data?.razorpay_order_id) return data.razorpay_order_id;
  }
  return null;
}

async function save(event, origin) {
  const ip = event.headers?.['cf-connecting-ip'] || event.headers?.['x-forwarded-for'] || 'unknown';
  if (throttled(ip) || await overEdgeLimit(ip)) return json(429, { ok: false, error: 'Too many requests' }, origin);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Bad JSON' }, origin); }
  const { row, error } = parseFeedback(body);
  if (error) return json(400, { ok: false, error }, origin);

  try {
    const client = db();
    if (row.kind === 'order') {
      const real = await findOrder(client, row.order_id);
      row.order_verified = !!real;
      if (real) { row.order_id = real; row.feedback_key = `order:${real}`; }
    }
    const { error: dbError } = await client.from(TABLE).upsert(row, { onConflict: 'feedback_key' });
    if (dbError) {
      console.warn('[site-feedback] save:', dbError.message);
      return json(503, { ok: false }, origin);
    }
    return json(200, { ok: true }, origin);
  } catch (e) {
    console.warn('[site-feedback] save:', e.message);
    return json(503, { ok: false }, origin);
  }
}

async function adminRead(event) {
  const q = event.queryStringParameters || {};
  const client = db();
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 150, 1), 500);

  let query = client.from(TABLE)
    .select('id, created_at, updated_at, kind, rating, comment, order_id, order_verified, page_url, device')
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (KINDS.includes(q.kind)) query = query.eq('kind', q.kind);
  const max = parseInt(q.max_rating, 10);
  if (max >= 1 && max <= 5) query = query.lte('rating', max);
  if (q.with_comment === '1') query = query.not('comment', 'is', null);

  const { data, error } = await query;
  if (error) {
    if (MISSING_TABLE.test(error.message)) return json(200, { feedback: [], stats: null, table_missing: true });
    throw new Error(error.message);
  }
  const rows = data || [];

  // Who placed the order, for following up a low rating.
  const ids = [...new Set(rows.filter(r => r.order_verified && r.order_id).map(r => r.order_id))];
  if (ids.length) {
    const { data: orders } = await client.from('orders')
      .select('razorpay_order_id, customer_name, customer_phone, amount_paise, status')
      .in('razorpay_order_id', ids);
    const byId = new Map((orders || []).map(o => [o.razorpay_order_id, o]));
    for (const r of rows) {
      const o = r.order_id && byId.get(r.order_id);
      if (o) r.order = { name: o.customer_name, phone: o.customer_phone, amount: Math.round((o.amount_paise || 0) / 100), status: o.status };
    }
  }

  // Stats over every rating, not just the page shown.
  const { data: all, error: statsError } = await client.from(TABLE).select('kind, rating').limit(50000);
  if (statsError) throw new Error(statsError.message);
  const stats = {};
  for (const k of KINDS) stats[k] = summarise((all || []).filter(r => r.kind === k).map(r => r.rating));

  return json(200, { feedback: rows, stats });
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers(allowed), body: '' };

  if (event.httpMethod === 'POST') {
    // An empty Origin is a same-origin post or a curl; a foreign one is refused.
    if (origin && !allowed) return json(403, { error: 'Forbidden' }, '');
    return save(event, allowed);
  }

  if (event.httpMethod === 'GET') {
    const block = requireAdmin(event);
    if (block) return block;
    try {
      return await adminRead(event);
    } catch (e) {
      console.error('[site-feedback]', e.message);
      return json(500, { error: e.message });
    }
  }
  return json(405, { error: 'Method Not Allowed' }, allowed);
};
