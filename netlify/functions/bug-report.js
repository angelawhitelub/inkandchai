/**
 * "Report a problem" on the website.
 *
 * POST  /.netlify/functions/bug-report   { message, contact?, page_url, device, viewport, user_agent, cart, errors, visitor_id }
 *   Public, from public/js/site-feedback.js. → { ok, ref: "BUG-123" }
 *
 * GET   /.netlify/functions/bug-report?status=new&limit=150      (admin)
 *   → { reports: [...], counts: { new, looking, fixed, closed }, table_missing? }
 *
 * PATCH /.netlify/functions/bug-report   { id, status?, admin_note? }   (admin)
 *
 * Posts are anonymous: same origin check and per-IP limits as Ink AI and the
 * feedback widget. Unlike a star rating, a failed report IS shown to the
 * customer -- they took the trouble to describe a problem, and silently losing
 * it is worse than telling them to message us instead.
 *
 * Needs sql/bug_reports.sql.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { parseBugReport, refFor, STATUSES } = require('./utils/bug-report');
const { ALLOWED_ORIGINS, overEdgeLimit } = require('./ink-ai');

const TABLE = 'bug_reports';
const MISSING_TABLE = /relation .* does not exist|Could not find the table/i;

const headers = (origin) => ({
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': origin || ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
});
const json = (statusCode, body, origin) => ({ statusCode, headers: headers(origin), body: JSON.stringify(body) });
const db = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Isolate-local backstop: a person reports a problem once or twice, not 5 a minute.
const HITS = new Map();
function throttled(ip) {
  const now = Date.now();
  const hits = (HITS.get(ip) || []).filter((t) => now - t < 60_000);
  hits.push(now);
  HITS.set(ip, hits);
  if (HITS.size > 5000) HITS.clear();
  return hits.length > 4;
}

async function submit(event, origin) {
  const ip = event.headers?.['cf-connecting-ip'] || event.headers?.['x-forwarded-for'] || 'unknown';
  if (throttled(ip) || await overEdgeLimit(ip)) return json(429, { ok: false, error: 'Too many reports from here — please try again in a minute.' }, origin);
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Bad request' }, origin); }
  const { row, error } = parseBugReport(body);
  if (error) return json(400, { ok: false, error }, origin);
  try {
    const { data, error: dbError } = await db().from(TABLE).insert(row).select('id').single();
    if (dbError) {
      console.warn('[bug-report] save:', dbError.message);
      return json(503, { ok: false, error: 'Could not save that right now.' }, origin);
    }
    return json(200, { ok: true, ref: refFor(data.id) }, origin);
  } catch (e) {
    console.warn('[bug-report] save:', e.message);
    return json(503, { ok: false, error: 'Could not save that right now.' }, origin);
  }
}

async function list(event) {
  const q = event.queryStringParameters || {};
  const client = db();
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 150, 1), 500);
  let query = client.from(TABLE).select('*').order('created_at', { ascending: false }).limit(limit);
  if (STATUSES.includes(q.status)) query = query.eq('status', q.status);
  else if (q.status === 'open') query = query.in('status', ['new', 'looking']);
  const { data, error } = await query;
  if (error) {
    if (MISSING_TABLE.test(error.message)) return json(200, { reports: [], counts: null, table_missing: true });
    throw new Error(error.message);
  }
  const { data: all, error: countError } = await client.from(TABLE).select('status').limit(50000);
  if (countError) throw new Error(countError.message);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of all || []) if (counts[r.status] !== undefined) counts[r.status] += 1;
  return json(200, { reports: (data || []).map((r) => ({ ...r, ref: refFor(r.id) })), counts });
}

async function update(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const id = parseInt(body.id, 10);
  if (!(id > 0)) return json(400, { error: 'id required' });
  const patch = { updated_at: new Date().toISOString() };
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return json(400, { error: 'Unknown status' });
    patch.status = body.status;
  }
  if (body.admin_note !== undefined) patch.admin_note = String(body.admin_note || '').trim().slice(0, 2000) || null;
  const { data, error } = await db().from(TABLE).update(patch).eq('id', id).select('*').maybeSingle();
  if (error) return json(500, { error: error.message });
  if (!data) return json(404, { error: 'Report not found' });
  return json(200, { success: true, report: { ...data, ref: refFor(data.id) } });
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers(allowed), body: '' };

  if (event.httpMethod === 'POST') {
    // An empty Origin is a same-origin post or a curl; a foreign one is refused.
    if (origin && !allowed) return json(403, { error: 'Forbidden' }, '');
    return submit(event, allowed);
  }
  if (event.httpMethod === 'GET' || event.httpMethod === 'PATCH') {
    const block = requireAdmin(event);
    if (block) return block;
    try {
      return event.httpMethod === 'GET' ? await list(event) : await update(event);
    } catch (e) {
      console.error('[bug-report]', e.message);
      return json(500, { error: e.message });
    }
  }
  return json(405, { error: 'Method Not Allowed' }, allowed);
};
