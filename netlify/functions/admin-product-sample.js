/**
 * Netlify Function: admin-product-sample   (admin)
 *
 * The "Read sample" PDF of a physical book, managed from the product editor.
 *
 *   GET  ?slug=…                               → { sample }  (the current one, or null)
 *   POST { action:'sign',   slug }             → { upload_url, key }  presigned R2 PUT, 10 min
 *   POST { action:'save',   slug, key, pages } → { sample }  after confirming the upload landed
 *   POST { action:'remove', slug }             → { removed: true }
 *
 * The PDF goes browser → R2 directly (a sample can be several MB, over the
 * function body limit), already trimmed to its first pages by the admin panel.
 * Saving checks the object is really there, is a PDF and is within the size
 * cap before the storefront is pointed at it.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { r2PresignPut, r2HeadObject, r2Config, r2Configured } = require('./utils/r2-put');
const { purgeUrls, purgeProductSlugs } = require('./utils/purge-cache');
const S = require('./utils/product-sample');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const MIGRATION = 'The product_samples table is missing — run sql/product_samples.sql in Supabase first.';

async function purgeSample(slug) {
  const site = (process.env.SITE_URL || 'https://inkandchai.in').replace(/\/+$/, '');
  const [a, b] = await Promise.all([
    purgeUrls([`${site}/.netlify/functions/get-product-sample?slug=${encodeURIComponent(slug)}`]),
    purgeProductSlugs([slug]),
  ]);
  return !!(a && a.purged && b && b.purged);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return json(500, { error: 'Supabase is not configured.' });
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  if (event.httpMethod === 'GET') {
    const slug = S.cleanSlug((event.queryStringParameters || {}).slug);
    if (!slug) return json(400, { error: 'Missing product slug' });
    const { data, error } = await db.from(S.TABLE).select('*').eq('slug', slug).maybeSingle();
    if (error) return S.isMissingTable(error) ? json(200, { sample: null, migration: MIGRATION }) : json(500, { error: error.message });
    return json(200, { sample: S.publicSample(data) });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const slug = S.cleanSlug(body.slug);
  if (!slug) return json(400, { error: 'Missing product slug' });

  try {
    if (body.action === 'sign') {
      if (!r2Configured()) return json(503, { error: 'R2 is not configured on this deploy.' });
      const key = S.newSampleKey(slug);
      const signed = r2PresignPut(r2Config(), { key, contentType: 'application/pdf', expiresIn: 600 });
      return json(200, { upload_url: signed.uploadUrl, key, content_type: 'application/pdf', max_bytes: S.MAX_BYTES, max_pages: S.MAX_PAGES });
    }

    if (body.action === 'save') {
      const key = String(body.key || '');
      if (!S.isSampleKeyFor(key, slug)) return json(400, { error: 'That upload does not belong to this product.' });
      const pages = S.cleanPages(body.pages);
      if (!pages) return json(400, { error: `Pages must be between 1 and ${S.MAX_PAGES}.` });
      const head = await r2HeadObject(r2Config(), key);
      if (!head.exists) return json(400, { error: `The PDF did not reach storage (HTTP ${head.status}). Upload it again.` });
      if (head.size > S.MAX_BYTES) return json(400, { error: `The sample is ${(head.size / 1048576).toFixed(1)} MB; the limit is ${S.MAX_BYTES / 1048576} MB.` });
      if (head.contentType && !/pdf/i.test(head.contentType)) return json(400, { error: `Stored file is ${head.contentType}, not a PDF.` });

      const row = { slug, r2_key: key, pages, size_bytes: head.size || null, updated_at: new Date().toISOString() };
      const { data, error } = await db.from(S.TABLE).upsert(row, { onConflict: 'slug' }).select().single();
      if (error) return json(S.isMissingTable(error) ? 503 : 500, { error: S.isMissingTable(error) ? MIGRATION : error.message });
      const purged = await purgeSample(slug);
      return json(200, { sample: S.publicSample(data), cache_purged: purged });
    }

    if (body.action === 'remove') {
      const { error } = await db.from(S.TABLE).delete().eq('slug', slug);
      if (error) return json(S.isMissingTable(error) ? 503 : 500, { error: S.isMissingTable(error) ? MIGRATION : error.message });
      const purged = await purgeSample(slug);
      return json(200, { removed: true, cache_purged: purged });
    }

    return json(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('[admin-product-sample]', e);
    return json(500, { error: e.message });
  }
};
