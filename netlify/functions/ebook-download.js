/**
 * Netlify Function: ebook-download
 * POST { slug } → { url, expires_in }
 *
 * The gate. Issues a signed R2 URL for a PDF, and only to a signed-in customer
 * who has an entitlement row for that exact slug.
 *
 * WHY A SIGNED URL RATHER THAN STREAMING THE FILE
 * Streaming 40 MB through the function would pay for the bytes twice and put a
 * worker invocation in the path of every resumed download. A signed URL lets
 * the browser talk to R2 directly, where Cloudflare egress is free — the same
 * reason the covers are on R2 at all. The trade is that the URL is bearer
 * proof for its lifetime, which is why that lifetime is five minutes.
 *
 * The response is no-store: a cached 200 here would be a download link sitting
 * in an intermediary for anyone who asks.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireCustomer } = require('./utils/customer-auth');
const { r2PresignGet, r2EbookConfig, r2EbookConfigured } = require('./utils/r2-put');
const { normaliseSlug, DOWNLOAD_TTL_SEC } = require('./utils/ebook');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const who = await requireCustomer(event, db);
  if (who.error) return json(who.status, { error: who.error });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const slug = normaliseSlug(body.slug);
  if (!slug) return json(400, { error: 'Which eBook?' });

  if (!r2EbookConfigured()) return json(503, { error: 'Downloads are temporarily unavailable.' });

  try {
    const { data: owned } = await db.from('ebook_entitlements')
      .select('id, downloads').eq('slug', slug).eq('user_id', who.user.id).maybeSingle();
    // Deliberately the same answer whether they never bought it or it does not
    // exist. Distinguishing the two turns this endpoint into a way to ask which
    // titles are on sale privately.
    if (!owned) return json(403, { error: 'You have not bought this eBook.' });

    // Note this reads the CURRENT r2_key, so replacing a PDF with a corrected
    // edition reaches everyone who already owns it.
    const { data: ebook } = await db.from('ebooks').select('r2_key, title').eq('slug', slug).maybeSingle();
    if (!ebook?.r2_key) return json(404, { error: 'That file is missing. Please contact support.' });

    const url = r2PresignGet(r2EbookConfig(), {
      key: ebook.r2_key,
      expiresIn: DOWNLOAD_TTL_SEC,
      downloadName: `${(ebook.title || slug).slice(0, 80)}.pdf`,
    });

    // Best-effort: a counter that fails must not cost them the download. It is
    // awaited rather than fired and forgotten because the worker may be torn
    // down the moment the response returns, which would drop the write.
    try {
      await db.from('ebook_entitlements')
        .update({ downloads: (owned.downloads || 0) + 1, last_download_at: new Date().toISOString() })
        .eq('id', owned.id);
    } catch (e) { console.warn('[ebook-download] counter:', e.message); }

    return json(200, { url, expires_in: DOWNLOAD_TTL_SEC });
  } catch (e) {
    console.error('[ebook-download]', e.message);
    return json(500, { error: 'Could not prepare the download.' });
  }
};
