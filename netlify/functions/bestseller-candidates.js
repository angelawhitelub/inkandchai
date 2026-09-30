/**
 * Netlify Function: bestseller-candidates   (admin)
 *
 * The review queue behind the admin "Bestsellers" tab.
 *
 * GET  ?status=pending|approved|rejected|skipped|in_catalogue (default pending)
 *      → { candidates, counts, last_run }
 * POST { action: 'update',  id, fields }     edit a pending draft
 *      { action: 'approve', id, fields? }    create the product listing
 *      { action: 'reject',  id, reason? }    never suggest it again
 *      { action: 'restore', id }             back to pending
 *
 * Approve goes through create-product-listing itself (same slug rules, cache
 * purge and column fallbacks as a listing made by hand), after copying the
 * cover into our own storage so the shop never hotlinks someone else's server.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { isbnToGtin } = require('./utils/gtin');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const STATUSES = ['pending', 'approved', 'rejected', 'skipped', 'in_catalogue'];

// What an admin may change on a draft before approving it.
const EDITABLE = {
  title: 220, author: 140, category: 140, publisher: 160, language: 60, format: 60,
  description: 5000, author_bio: 5000, tags: 700, seo_title: 220, meta_description: 300,
  image_url: 4000, isbn13: 20, dimensions: 80, published_on: 40, reading_age: 40,
};
const NUMERIC = { price_inr: 100000, mrp_inr: 100000, pages: 20000, weight_grams: 50000 };

function cleanFields(fields) {
  const out = {};
  for (const [k, max] of Object.entries(EDITABLE)) {
    if (fields[k] === undefined) continue;
    const v = String(fields[k] == null ? '' : fields[k]).trim();
    out[k] = v ? v.slice(0, max) : null;
  }
  for (const [k, max] of Object.entries(NUMERIC)) {
    if (fields[k] === undefined) continue;
    const n = Number(String(fields[k]).replace(/[^0-9.]/g, ''));
    out[k] = Number.isFinite(n) && n > 0 && n <= max ? (k === 'pages' || k === 'weight_grams' ? Math.round(n) : Math.round(n * 100) / 100) : null;
  }
  return out;
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' };

/** Our own copy of the cover. Falls back to the original URL if the copy fails. */
async function storeCover(supabase, url, slugHint) {
  if (!url || !/^https:\/\//i.test(url) || /supabase\.co\/storage/.test(url)) return url || null;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const type = String(res.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!res.ok || !EXT[type]) return url;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length < 2000 || buf.length > 4 * 1024 * 1024) return url;
    const path = `custom/${slugHint}-${Date.now()}.${EXT[type]}`;
    const { error } = await supabase.storage.from('product-images').upload(path, buf, { contentType: type, upsert: true });
    if (error) throw error;
    return supabase.storage.from('product-images').getPublicUrl(path).data?.publicUrl || url;
  } catch (e) {
    console.warn('[bestseller-candidates] cover copy failed:', e.message);
    return url;
  }
}

const slugHint = (t) => String(t || 'book').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'book';

/** Loaded at call time so tests can stub it. */
const createListing = () => require('./create-product-listing');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  if (event.httpMethod === 'GET') {
    const status = STATUSES.includes((event.queryStringParameters || {}).status) ? event.queryStringParameters.status : 'pending';
    const order = status === 'pending' ? 'best_rank' : 'updated_at';
    const { data, error } = await supabase.from('bestseller_candidates').select('*')
      .eq('status', status).order(order, { ascending: status === 'pending', nullsFirst: false }).limit(300);
    if (error) {
      const missing = /bestseller_candidates/.test(error.message) && /exist|find/i.test(error.message);
      return json(missing ? 503 : 500, { error: missing ? 'The bestseller_candidates table does not exist yet. Run sql/bestseller_candidates.sql in Supabase.' : error.message });
    }
    const counts = {};
    for (const s of STATUSES) {
      const { count } = await supabase.from('bestseller_candidates').select('id', { count: 'exact', head: true }).eq('status', s);
      counts[s] = count || 0;
    }
    const { data: runs } = await supabase.from('bestseller_agent_runs').select('trigger, started_at, finished_at, summary').order('id', { ascending: false }).limit(1);
    const last = runs && runs[0];
    const lastRun = last ? {
      trigger: last.trigger, started_at: last.started_at, finished_at: last.finished_at,
      drafted: last.summary?.drafted, in_catalogue: last.summary?.in_catalogue, skipped: last.summary?.skipped,
      failed: last.summary?.failed, remaining: last.summary?.remaining, errors: (last.summary?.errors || []).slice(0, 5),
    } : null;
    return json(200, { candidates: data || [], counts, last_run: lastRun });
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const id = String(body.id || '').trim();
  if (!id) return json(400, { error: 'Missing id' });

  const { data: row, error: readErr } = await supabase.from('bestseller_candidates').select('*').eq('id', id).maybeSingle();
  if (readErr) return json(500, { error: readErr.message });
  if (!row) return json(404, { error: 'Draft not found' });
  const nowIso = new Date().toISOString();

  try {
    if (body.action === 'update') {
      if (row.status !== 'pending') return json(409, { error: `This draft is ${row.status}; restore it first.` });
      const fields = cleanFields(body.fields || {});
      const { data, error } = await supabase.from('bestseller_candidates').update({ ...fields, updated_at: nowIso }).eq('id', id).select().single();
      if (error) throw error;
      return json(200, { ok: true, candidate: data });
    }

    if (body.action === 'reject' || body.action === 'restore') {
      const toPending = body.action === 'restore';
      if (toPending && row.status === 'approved') return json(409, { error: 'Already listed as a product. Edit or delete it in Products & Prices.' });
      if (!toPending && row.status === 'approved') return json(409, { error: 'Already listed as a product.' });
      const { error } = await supabase.from('bestseller_candidates').update({
        status: toPending ? 'pending' : 'rejected',
        status_reason: toPending ? null : (String(body.reason || '').trim().slice(0, 300) || 'Rejected in admin'),
        decided_at: toPending ? null : nowIso,
        updated_at: nowIso,
      }).eq('id', id);
      if (error) throw error;
      return json(200, { ok: true });
    }

    if (body.action === 'approve') {
      if (row.status !== 'pending') return json(409, { error: `This draft is already ${row.status}.` });
      const draft = { ...row, ...cleanFields(body.fields || {}) };
      if (!draft.title) return json(400, { error: 'A title is required.' });
      if (!(Number(draft.price_inr) > 0)) return json(400, { error: 'Set a selling price before approving.' });

      // Someone may have listed it by hand since the draft was made.
      const isbn = isbnToGtin(draft.isbn13 || '');
      if (isbn && !body.force) {
        const { data: same } = await supabase.from('custom_products').select('slug, title').eq('isbn', isbn).limit(1);
        if (same && same.length) {
          return json(409, { error: `Already listed with this ISBN: "${same[0].title}" (/product/${same[0].slug}/).`, existing: same[0] });
        }
      }

      const imageUrl = await storeCover(supabase, draft.image_url, slugHint(draft.title));
      const mrp = Number(draft.mrp_inr) > Number(draft.price_inr) ? draft.mrp_inr : null;
      const res = await createListing().handler({
        ...event,
        httpMethod: 'POST',
        path: '/.netlify/functions/create-product-listing',
        body: JSON.stringify({
          mode: 'create',
          title: draft.title,
          author: draft.author,
          category: draft.category || 'Books',
          description: draft.description,
          author_bio: draft.author_bio || undefined,
          price_inr: draft.price_inr,
          original_price_inr: mrp,
          image_url: imageUrl,
          publisher: draft.publisher,
          isbn: isbn || draft.isbn13,
          seo_title: draft.seo_title,
          meta_description: draft.meta_description,
          tags: [draft.tags, 'bestseller'].filter(Boolean).join(', '),
          format: draft.format || undefined,
          language: draft.language || undefined,
          pages: draft.pages || undefined,
          weight_grams: draft.weight_grams || undefined,
          dimensions: draft.dimensions || undefined,
          published_on: draft.published_on || undefined,
          reading_age: draft.reading_age || undefined,
          is_active: true,
        }),
      });
      let out = {};
      try { out = JSON.parse(res.body || '{}'); } catch { /* below */ }
      if (res.statusCode !== 200 || !out.product) {
        return json(502, { error: `Could not create the listing: ${out.error || 'HTTP ' + res.statusCode}` });
      }
      const { error } = await supabase.from('bestseller_candidates').update({
        ...cleanFields(body.fields || {}),
        status: 'approved', product_slug: out.product.slug, image_url: imageUrl,
        decided_at: nowIso, updated_at: nowIso, status_reason: out.warning || null,
      }).eq('id', id);
      if (error) console.error('[bestseller-candidates] mark approved:', error.message);
      return json(200, { ok: true, slug: out.product.slug, url: out.url, warning: out.warning || null });
    }

    return json(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('[bestseller-candidates]', e);
    return json(500, { error: e.message || 'Failed' });
  }
};
