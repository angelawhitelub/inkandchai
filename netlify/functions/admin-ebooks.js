/**
 * Netlify Function: admin-ebooks  (admin only)
 *
 * GET                     → every eBook, with how many copies each has sold
 * POST   { slug, ... }    → create or update one (price, title, PDF key, active)
 * DELETE ?slug=…          → delist it
 *
 * DELISTING IS NOT DELETING
 * A DELETE marks the row inactive and leaves both the row and the PDF in place,
 * because customers who already paid still have to be able to download it.
 * Removing the object would take a book away from someone who bought it, which
 * is the digital equivalent of repossessing a parcel.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { r2EbookConfig, r2EbookConfigured, r2HeadObject } = require('./utils/r2-put');
const { normaliseSlug, validatePrice } = require('./utils/ebook');

const TABLE = 'ebooks';
const SALES = 'ebook_entitlements';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body, null, 2) });

const MISSING_TABLE = /relation .* does not exist/i;

/**
 * Can these credentials actually reach the eBook bucket?
 *
 * Worth knowing before the first upload rather than after. R2 API tokens can be
 * scoped to a single bucket, and the images token predates this bucket, so a
 * token that works perfectly for covers may have no access here at all. HEAD a
 * key that cannot exist: 404 means authorised, 403 means the token cannot see
 * this bucket, and the panel can say which.
 */
async function bucketReachable() {
  if (!r2EbookConfigured()) return { ok: false, reason: 'credentials not set' };
  try {
    const probe = await r2HeadObject(r2EbookConfig(), 'ebooks/__probe__/does-not-exist.pdf');
    if (probe.status === 404) return { ok: true, bucket: r2EbookConfig().bucket };
    if (probe.status === 403) {
      return {
        ok: false,
        reason: `The R2 token cannot access the "${r2EbookConfig().bucket}" bucket. `
              + 'Create an R2 API token with access to it (or to all buckets) and update R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.',
      };
    }
    return { ok: false, reason: `Unexpected status ${probe.status} from R2.` };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event);
  if (block) return block;

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    if (event.httpMethod === 'GET') {
      const { data, error } = await db.from(TABLE).select('*').order('updated_at', { ascending: false });
      if (error) {
        // The same courtesy ink-ai-questions.js extends: say the migration has
        // not been run rather than throwing a 500 the panel renders as "failed".
        if (MISSING_TABLE.test(error.message)) return json(200, { ebooks: [], table_missing: true });
        throw new Error(error.message);
      }
      // Sales per slug, so the panel can show what is actually selling.
      const counts = {};
      const { data: sales } = await db.from(SALES).select('slug');
      for (const row of sales || []) counts[row.slug] = (counts[row.slug] || 0) + 1;
      return json(200, {
        ebooks: (data || []).map(r => ({ ...r, sold: counts[r.slug] || 0 })),
        r2_configured: r2EbookConfigured(),
        r2_bucket: await bucketReachable(),
      });
    }

    if (event.httpMethod === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch { return json(400, { error: 'Invalid JSON' }); }

      const slug = normaliseSlug(body.slug);
      if (!slug) return json(400, { error: 'Pick a book first.' });

      const priced = validatePrice(body.price);
      if (!priced.ok) return json(400, { error: priced.error });

      const { data: existing } = await db.from(TABLE).select('r2_key').eq('slug', slug).maybeSingle();
      const r2Key = String(body.r2_key || '').trim() || existing?.r2_key || '';
      if (!r2Key) return json(400, { error: 'Upload the PDF before saving.' });

      // Confirm the object is really in the bucket. A presigned PUT that failed
      // halfway leaves the admin looking at a success message and the customer
      // buying a book that 404s at download — the worst possible order of
      // discovery, since by then they have paid.
      if (r2EbookConfigured()) {
        const head = await r2HeadObject(r2EbookConfig(), r2Key);
        if (!head.exists) {
          return json(400, { error: 'That PDF is not in storage — the upload did not finish. Try uploading again.' });
        }
        if (!body.size_bytes) body.size_bytes = head.size;
      }

      const row = {
        slug,
        title: String(body.title || '').slice(0, 300),
        author: String(body.author || '').slice(0, 200),
        cover: String(body.cover || '').slice(0, 500),
        price: priced.price,
        mrp: Number(body.mrp) > 0 ? Math.round(Number(body.mrp)) : null,
        pages: Number(body.pages) > 0 ? Math.round(Number(body.pages)) : null,
        r2_key: r2Key,
        file_name: String(body.file_name || '').slice(0, 200),
        size_bytes: Number(body.size_bytes) || null,
        active: body.active !== false,
        updated_at: new Date().toISOString(),
      };

      const { error } = await db.from(TABLE).upsert(row, { onConflict: 'slug' });
      if (error) {
        if (MISSING_TABLE.test(error.message)) return json(503, { error: 'The ebooks table does not exist yet — run the SQL migration.' });
        throw new Error(error.message);
      }
      return json(200, { ok: true, ebook: row });
    }

    if (event.httpMethod === 'DELETE') {
      const slug = normaliseSlug((event.queryStringParameters || {}).slug);
      if (!slug) return json(400, { error: 'Which one?' });
      const { error } = await db.from(TABLE)
        .update({ active: false, updated_at: new Date().toISOString() }).eq('slug', slug);
      if (error) throw new Error(error.message);
      return json(200, { ok: true, delisted: slug });
    }

    return json(405, { error: 'Method Not Allowed' });
  } catch (e) {
    console.error('[admin-ebooks]', e.message);
    return json(500, { error: e.message });
  }
};
