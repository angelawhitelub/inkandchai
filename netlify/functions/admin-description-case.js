/**
 * Owner-only: read and re-case admin-added book descriptions in bulk.
 *
 * Thousands of imported listings (crossword.in, 99bookstores, bookstohome)
 * arrived with descriptions In Title Case Like This. The sentence-casing
 * needs a full English word list to tell "The Mice" from "Lady Jane Grey",
 * which does not belong in the Worker, so it runs offline and this endpoint
 * only moves text:
 *
 *   GET  ?offset=0&limit=1000  -> { rows: [{ slug, title, author, description }], total }
 *   POST { items: [{ slug, from, to }], dry_run? }
 *
 * A POST writes `to` only when it differs from `from` by letter case alone and
 * the stored description is still exactly `from`, so it cannot change a
 * word, and cannot overwrite an edit made after the read. updated_at is left
 * alone: re-casing is not an edit, and bumping it would push thousands of
 * imports to the top of the "newest 1000" product list.
 */
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const MAX_ITEMS = 200;

/** Why an item may not be written, or null when it may. */
function rejectReason(item) {
  if (!item || typeof item.slug !== 'string' || !item.slug) return 'missing slug';
  if (typeof item.from !== 'string' || typeof item.to !== 'string') return 'missing text';
  if (item.from === item.to) return 'unchanged';
  if (item.from.length !== item.to.length || item.from.toLowerCase() !== item.to.toLowerCase()) return 'not a case-only change';
  return null;
}

exports.handler = async (event = {}) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS);
  if (block) return block;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return json(500, { error: 'Supabase is not configured' });
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      const offset = Math.max(0, Math.floor(Number(q.offset) || 0));
      const limit = Math.min(1000, Math.max(1, Math.floor(Number(q.limit) || 1000)));
      const { data, error, count } = await db.from('custom_products')
        .select('slug,title,author,description', { count: 'exact' })
        .order('slug', { ascending: true })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      return json(200, { rows: data || [], total: count, offset, limit });
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'GET or POST' });

    let body;
    try { body = JSON.parse(event.body || '{}') || {}; } catch { return json(400, { error: 'Invalid JSON' }); }
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length || items.length > MAX_ITEMS) return json(400, { error: `send 1-${MAX_ITEMS} items` });

    const results = [];
    const valid = [];
    for (const item of items) {
      const why = rejectReason(item);
      if (why) results.push({ slug: item && item.slug, ok: false, reason: why });
      else valid.push(item);
    }
    const { data: current, error } = valid.length
      ? await db.from('custom_products').select('slug,description').in('slug', valid.map((i) => i.slug))
      : { data: [] };
    if (error) throw error;
    const stored = new Map((current || []).map((r) => [r.slug, r.description]));

    for (const item of valid) {
      if (!stored.has(item.slug)) { results.push({ slug: item.slug, ok: false, reason: 'not found' }); continue; }
      if (stored.get(item.slug) !== item.from) { results.push({ slug: item.slug, ok: false, reason: 'changed since read' }); continue; }
      if (body.dry_run === true) { results.push({ slug: item.slug, ok: true, dry_run: true }); continue; }
      const { error: upErr } = await db.from('custom_products').update({ description: item.to }).eq('slug', item.slug);
      results.push(upErr ? { slug: item.slug, ok: false, reason: upErr.message } : { slug: item.slug, ok: true });
    }
    const written = results.filter((r) => r.ok && !r.dry_run).length;
    return json(200, { written, skipped: results.length - results.filter((r) => r.ok).length, results });
  } catch (e) {
    console.error('[admin-description-case]', e);
    return json(500, { error: e.message });
  }
};

exports.rejectReason = rejectReason;
