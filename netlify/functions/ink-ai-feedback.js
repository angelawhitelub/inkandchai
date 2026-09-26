/**
 * Ink AI star ratings.
 *
 * POST /.netlify/functions/ink-ai-feedback  { session_id, rating 1-5, comment?, page_url?, turns? }
 *   Public, from the chat widget. One row per chat session: rating again, or
 *   adding a comment after the stars, updates the same row.
 *
 * GET  /.netlify/functions/ink-ai-feedback?limit=100&max_rating=3&with_comment=1
 *   Admin. → { feedback: [...], stats: {count, average, distribution}, table_missing? }
 * GET  /.netlify/functions/ink-ai-feedback?session=<id>
 *   Admin. → { conversation: [...] } — the chat behind a rating, so a 1-star
 *   can be read in full instead of guessed at.
 *
 * The widget posts are anonymous, so they get the same origin check and
 * per-IP limiter as the chat itself. A rating is never allowed to put an error
 * in front of a customer: a missing table or a failed write is logged and the
 * widget is told it did not stick, nothing more.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { parseFeedback, summarise } = require('./utils/ink-ai-feedback');
const { TABLE: CONVERSATIONS, ALLOWED_ORIGINS, overEdgeLimit } = require('./ink-ai');

const TABLE = 'ink_ai_feedback';
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

// Isolate-local backstop, as in ink-ai.js. A person rates once or twice.
const HITS = new Map();
function throttled(ip) {
  const now = Date.now();
  const hits = (HITS.get(ip) || []).filter(t => now - t < 60_000);
  hits.push(now);
  HITS.set(ip, hits);
  if (HITS.size > 5000) HITS.clear();
  return hits.length > 8;
}

async function saveRating(event, origin) {
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return json(403, { error: 'Forbidden' }, '');
  const ip = event.headers?.['cf-connecting-ip'] || event.headers?.['x-forwarded-for'] || 'unknown';
  if (throttled(ip) || await overEdgeLimit(ip)) return json(429, { ok: false, error: 'Too many requests' }, origin);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Bad JSON' }, origin); }
  const { row, error } = parseFeedback(body);
  if (error) return json(400, { ok: false, error }, origin);

  try {
    const { error: dbError } = await db().from(TABLE).upsert(row, { onConflict: 'session_id' });
    if (dbError) {
      console.warn('[ink-ai-feedback] save:', dbError.message);
      return json(503, { ok: false }, origin);
    }
    return json(200, { ok: true }, origin);
  } catch (e) {
    console.warn('[ink-ai-feedback] save:', e.message);
    return json(503, { ok: false }, origin);
  }
}

async function adminRead(event) {
  const q = event.queryStringParameters || {};
  const client = db();

  if (q.session) {
    const { data, error } = await client.from(CONVERSATIONS)
      .select('created_at, question, answer, escalated, page_url, turn')
      .eq('session_id', String(q.session).slice(0, 64))
      .order('created_at', { ascending: true })
      .limit(60);
    if (error) throw new Error(error.message);
    return json(200, { conversation: data || [] });
  }

  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 100, 1), 300);
  let query = client.from(TABLE)
    .select('id, created_at, updated_at, session_id, rating, comment, page_url, turns')
    .order('updated_at', { ascending: false })
    .limit(limit);
  const max = parseInt(q.max_rating, 10);
  if (max >= 1 && max <= 5) query = query.lte('rating', max);
  if (q.with_comment === '1') query = query.not('comment', 'is', null);

  const { data, error } = await query;
  if (error) {
    if (MISSING_TABLE.test(error.message)) return json(200, { feedback: [], stats: null, table_missing: true });
    throw new Error(error.message);
  }

  // Stats over every rating, not just the page shown. Ratings are one small
  // integer per chat, so reading the column is cheap for a long while yet.
  const { data: all, error: statsError } = await client.from(TABLE).select('rating').limit(20000);
  if (statsError) throw new Error(statsError.message);

  return json(200, { feedback: data || [], stats: summarise((all || []).map(r => r.rating)) });
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers(allowed), body: '' };

  if (event.httpMethod === 'POST') return saveRating(event, allowed || (origin ? origin : ''));

  if (event.httpMethod === 'GET') {
    const block = requireAdmin(event);
    if (block) return block;
    try {
      return await adminRead(event);
    } catch (e) {
      console.error('[ink-ai-feedback]', e.message);
      return json(500, { error: e.message });
    }
  }
  return json(405, { error: 'Method Not Allowed' }, allowed);
};
