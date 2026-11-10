/**
 * Netlify Function: admin-copyright-reports   (owner only)
 *
 * GET  ?status=new|reviewing|removed|rejected|all&limit=100
 *        → { reports: [...], counts: {new, reviewing, removed, rejected} }
 *        Each report carries page_deleted: whether its product page is
 *        currently taken down (deleted_products), so the tab can offer
 *        "Take page down" or "Restore page" truthfully.
 * GET  ?ref=CR-…&image=1   → { type, data (base64) } — one of the report's
 *        images, read from the private R2 bucket. Never a public URL.
 * POST { ref, status?, owner_notes? } → { ok, report }
 *
 * The takedown itself is NOT done here: the tab calls delete-product (the
 * same action as the product editor's Delete Product Page, 410 Gone and
 * restorable) and then sets status 'removed' through this endpoint.
 *
 * Reports are written by the public copyright-report function
 * (sql/copyright_reports.sql). A missing table answers table_missing so the
 * tab can show the migration instead of an error.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });

const STATUSES = ['new', 'reviewing', 'removed', 'rejected'];
const LIST_COLS = 'id,ref,created_at,status,product_url,product_slug,reporter_name,reporter_email,reporter_phone,organisation,role,work_description,original_url,details,good_faith,accurate,signature,image_keys,image_count,owner_notes';
const isMissingTable = (err) => !!err && (err.code === '42P01' || err.code === 'PGRST205' || /copyright_reports/.test(String(err.message || '')) && /does not exist|could not find|schema cache/i.test(String(err.message || '')));

function realDeps(env = process.env) {
  const { r2GetObject, r2EbookConfig, r2EbookConfigured } = require('./utils/r2-put');
  return {
    db: env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY) : null,
    getImage: r2EbookConfigured(env) ? (key) => r2GetObject(r2EbookConfig(env), key) : null,
  };
}

async function deletedSlugs(db, slugs) {
  if (!slugs.length) return new Set();
  const { data, error } = await db.from('deleted_products').select('slug').in('slug', slugs);
  if (error) return new Set();
  return new Set((data || []).map((r) => String(r.slug).toLowerCase()));
}

async function list(db, q) {
  const status = STATUSES.includes(q.status) ? q.status : 'all';
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 100, 1), 300);
  let query = db.from('copyright_reports').select(LIST_COLS).order('created_at', { ascending: false }).limit(limit);
  if (status !== 'all') query = query.eq('status', status);
  const { data, error } = await query;
  if (error) {
    if (isMissingTable(error)) return json(200, { table_missing: true, reports: [], counts: {} });
    return json(500, { error: error.message });
  }
  const { data: all, error: cErr } = await db.from('copyright_reports').select('status').limit(5000);
  const counts = { new: 0, reviewing: 0, removed: 0, rejected: 0 };
  if (!cErr) for (const r of all || []) if (counts[r.status] !== undefined) counts[r.status] += 1;
  const reports = data || [];
  const gone = await deletedSlugs(db, [...new Set(reports.map((r) => r.product_slug).filter(Boolean))]);
  for (const r of reports) {
    r.page_deleted = gone.has(String(r.product_slug || '').toLowerCase());
    r.image_keys = Array.isArray(r.image_keys) ? r.image_keys : [];
  }
  return json(200, { reports, counts, status });
}

async function image(db, getImage, ref, n) {
  if (!getImage) return json(503, { error: 'Image storage is not configured.' });
  const { data, error } = await db.from('copyright_reports').select('image_keys').eq('ref', ref).maybeSingle();
  if (error) return json(isMissingTable(error) ? 404 : 500, { error: error.message });
  if (!data) return json(404, { error: 'No such report.' });
  const keys = Array.isArray(data.image_keys) ? data.image_keys : [];
  const key = keys[n - 1];
  // Only keys stored on the report itself, and only under its own folder.
  if (!key || !String(key).startsWith(`copyright/${ref}/`)) return json(404, { error: 'No such image.' });
  const got = await getImage(key);
  if (!got || !got.ok) return json(502, { error: `Could not read the image (${got ? got.status : 'no answer'}).` });
  const type = /^image\/(jpeg|png|webp)$/.test(got.contentType) ? got.contentType
    : key.endsWith('.png') ? 'image/png' : key.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  return json(200, { type, data: Buffer.from(got.body).toString('base64') });
}

async function update(db, body) {
  const ref = String(body.ref || '').trim();
  if (!/^CR-\d{8}-[A-Z0-9]{5}$/.test(ref)) return json(400, { error: 'Provide the report reference.' });
  const patch = {};
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return json(400, { error: 'Unknown status.' });
    patch.status = body.status;
  }
  if (body.owner_notes !== undefined) patch.owner_notes = String(body.owner_notes || '').slice(0, 4000) || null;
  if (!Object.keys(patch).length) return json(400, { error: 'Nothing to change.' });
  const { data, error } = await db.from('copyright_reports').update(patch).eq('ref', ref).select('ref,status,owner_notes').maybeSingle();
  if (error) return json(isMissingTable(error) ? 404 : 500, { error: error.message });
  if (!data) return json(404, { error: 'No such report.' });
  return json(200, { ok: true, report: data });
}

async function handle(event, injected) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!injected) { const block = requireAdmin(event, CORS); if (block) return block; }
  const deps = injected || realDeps();
  if (!deps.db) return json(500, { error: 'Supabase env vars missing' });
  const q = event.queryStringParameters || {};
  try {
    if (event.httpMethod === 'GET') {
      if (q.ref && q.image) return await image(deps.db, deps.getImage, String(q.ref), parseInt(q.image, 10) || 0);
      return await list(deps.db, q);
    }
    if (event.httpMethod === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
      return await update(deps.db, body);
    }
    return json(405, { error: 'Method Not Allowed' });
  } catch (e) {
    console.error('[admin-copyright-reports]', e.message);
    return json(500, { error: e.message });
  }
}

exports.handler = (event) => handle(event);
exports.handle = handle;
exports.STATUSES = STATUSES;
