/**
 * Books customers asked for because they could not find them on the website.
 *
 * POST /.netlify/functions/site-book-request          (public, the search form)
 *   { title, author?, name?, phone?, email?, note?, q?, source?, page_url?, website? }
 *   Needs a title and a WhatsApp number or email. One row per customer per
 *   book; asking again bumps request_count (utils/site-book-request).
 *
 * GET  /.netlify/functions/site-book-request?status=new   (admin)
 *   → { requests: [...], demand: [{ title, customers, open }], table_missing? }
 * POST /.netlify/functions/site-book-request  { id, status?, admin_note? }   (admin)
 *
 * Records only: nothing is sent to the customer from here. The admin tab has a
 * WhatsApp button for telling them when the book is in.
 *
 * Anonymous posts get the same origin check and per-IP limits as site-feedback.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { parseRequest, demandByTitle, STATUSES } = require('./utils/site-book-request');
const { ALLOWED_ORIGINS, overEdgeLimit } = require('./ink-ai');

const TABLE = 'site_book_requests';
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

// Isolate-local backstop. A person asks for a handful of books, not dozens.
const HITS = new Map();
function throttled(ip) {
  const now = Date.now();
  const hits = (HITS.get(ip) || []).filter(t => now - t < 10 * 60_000);
  hits.push(now);
  HITS.set(ip, hits);
  if (HITS.size > 5000) HITS.clear();
  return hits.length > 6;
}

async function save(event, origin) {
  const ip = event.headers?.['cf-connecting-ip'] || event.headers?.['x-forwarded-for'] || 'unknown';
  if (throttled(ip) || await overEdgeLimit(ip)) {
    return json(429, { ok: false, error: 'Too many requests. Please try again in a few minutes.' }, origin);
  }
  if ((event.body || '').length > 4096) return json(413, { ok: false, error: 'Too long' }, origin);

  let body;
  try { body = JSON.parse(event.body || '{}') || {}; } catch { return json(400, { ok: false, error: 'Bad JSON' }, origin); }
  const { row, error } = parseRequest(body);
  // A honeypot hit looks like success, so a bot learns nothing.
  if (error === 'spam') return json(200, { ok: true }, origin);
  if (error) return json(400, { ok: false, error }, origin);

  try {
    const client = db();
    const { data: existing, error: findErr } = await client.from(TABLE)
      .select('id, request_count, author, note, customer_name, phone, email')
      .eq('contact_key', row.contact_key).eq('title_key', row.title_key).maybeSingle();
    if (findErr) throw findErr;

    if (existing) {
      const { error: upErr } = await client.from(TABLE).update({
        request_count: (existing.request_count || 1) + 1,
        updated_at: new Date().toISOString(),
        author: existing.author || row.author,
        note: row.note || existing.note,
        customer_name: existing.customer_name || row.customer_name,
        phone: existing.phone || row.phone,
        email: existing.email || row.email,
      }).eq('id', existing.id);
      if (upErr) throw upErr;
      return json(200, { ok: true, again: true }, origin);
    }

    const { error: insErr } = await client.from(TABLE).insert(row);
    // Two taps at once: the other one saved it.
    if (insErr && insErr.code !== '23505') throw insErr;
    return json(200, { ok: true }, origin);
  } catch (e) {
    console.warn('[site-book-request] save:', e.message);
    return json(503, { ok: false, error: 'Could not save your request just now. Please try again, or message us on WhatsApp.' }, origin);
  }
}

async function adminList(event) {
  const q = event.queryStringParameters || {};
  let query = db().from(TABLE).select('*').order('updated_at', { ascending: false }).limit(1000);
  if (STATUSES.includes(q.status)) query = query.eq('status', q.status);
  else if (q.status === 'open') query = query.in('status', ['new', 'sourcing']);
  const { data, error } = await query;
  if (error) {
    if (MISSING_TABLE.test(error.message)) return json(200, { requests: [], demand: [], table_missing: true });
    throw new Error(error.message);
  }
  const rows = data || [];
  return json(200, { requests: rows, demand: demandByTitle(rows) });
}

async function adminUpdate(body) {
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return json(400, { error: 'Provide the request id.' });
  const patch = { updated_at: new Date().toISOString() };
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return json(400, { error: `status must be one of ${STATUSES.join(', ')}` });
    patch.status = body.status;
  }
  if (body.admin_note !== undefined) patch.admin_note = String(body.admin_note || '').slice(0, 500) || null;
  if (Object.keys(patch).length === 1) return json(400, { error: 'Nothing to change.' });
  const { data, error } = await db().from(TABLE).update(patch).eq('id', id).select('id');
  if (error) throw new Error(error.message);
  if (!data || !data.length) return json(404, { error: 'Request not found.' });
  return json(200, { success: true });
}

exports.handler = async (event = {}) => {
  const origin = event.headers?.origin || '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers(origin), body: '' };

  // The admin may be signed in by cookie alone, so an update is told apart by
  // its body: only the admin's carries a request id.
  let adminBody = null;
  if (event.httpMethod === 'POST') {
    try { const b = JSON.parse(event.body || '{}'); if (b && b.id !== undefined) adminBody = b; } catch { /* public path reports it */ }
  }
  if (event.httpMethod === 'GET' || adminBody) {
    const block = requireAdmin(event, headers());
    if (block) return block;
    try {
      if (event.httpMethod === 'GET') return await adminList(event);
      return await adminUpdate(adminBody);
    } catch (e) {
      console.error('[site-book-request] admin:', e.message);
      return json(500, { error: e.message });
    }
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' }, origin);
  if (!ALLOWED_ORIGINS.includes(origin)) return json(403, { ok: false }, origin);
  return save(event, origin);
};

exports._test = { save, throttled };
