/**
 * Netlify Function: ebook-file
 * GET ?slug=…  (Authorization: Bearer <supabase jwt>) → the PDF bytes
 *
 * The only way a paid PDF reaches anyone. It replaced a presigned R2 URL,
 * which was the wrong shape for a paid file: that URL was a bearer token for
 * the whole book, and forwarding it to a friend handed over the book. Here the
 * bytes only ever move in a response to a request that carried a valid session
 * and a matching entitlement, so there is nothing to forward.
 *
 * WHAT THIS CAN AND CANNOT DO
 * It cannot stop a determined person keeping the bytes — they have to reach the
 * reader to be read, and that is true of every reader ever built. What it does
 * is remove the casual routes (no file saved, no link to share) and make any
 * copy that does escape carry the buyer's name on every page, baked into the
 * document rather than painted over it by JavaScript. See utils/ebook-watermark.
 *
 * CACHING
 * Never. edgeCacheKey already refuses anything carrying an Authorization
 * header, so this cannot enter the shared edge cache; Vary and no-store say so
 * again at the response, because a paid book in a shared cache would be served
 * to the next person who asked.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireCustomer } = require('./utils/customer-auth');
const { r2GetObject, r2PutObject, r2EbookConfig, r2EbookConfigured } = require('./utils/r2-put');
const { normaliseSlug } = require('./utils/ebook');
const { stampPdf, watermarkLabel, personalKey, MAX_STAMP_BYTES } = require('./utils/ebook-watermark');

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    }, body: '' };
  }
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const who = await requireCustomer(event, db);
  if (who.error) return json(who.status, { error: who.error });

  const slug = normaliseSlug((event.queryStringParameters || {}).slug);
  if (!slug) return json(400, { error: 'Which eBook?' });
  if (!r2EbookConfigured()) return json(503, { error: 'Reading is temporarily unavailable.' });

  try {
    const { data: owned } = await db.from('ebook_entitlements')
      .select('id, payment_id, downloads').eq('slug', slug).eq('user_id', who.user.id).maybeSingle();
    // Same answer whether they never bought it or it does not exist, so this
    // cannot be used to enumerate the catalogue.
    if (!owned) return json(403, { error: 'You have not bought this eBook.' });

    const { data: ebook } = await db.from('ebooks').select('r2_key, title').eq('slug', slug).maybeSingle();
    if (!ebook?.r2_key) return json(404, { error: 'That file is missing. Please contact support.' });

    const cfg = r2EbookConfig();
    const mine = personalKey(slug, who.user.id);

    // A buyer's stamped copy is built once and reused. Re-stamping several
    // hundred pages on every page-turn would be the slowest thing on the site.
    let bytes = null;
    const cached = await r2GetObject(cfg, mine);
    if (cached.ok) {
      bytes = Buffer.from(cached.body);
    } else {
      const original = await r2GetObject(cfg, ebook.r2_key);
      if (!original.ok) {
        console.error('[ebook-file] original missing', slug, original.status);
        return json(404, { error: 'That file is missing. Please contact support.' });
      }
      const raw = Buffer.from(original.body);
      const label = watermarkLabel({
        email: who.user.email, userId: who.user.id, paymentId: owned.payment_id,
      });

      if (raw.length <= MAX_STAMP_BYTES) {
        try {
          bytes = await stampPdf(raw, { label });
          // Store it for next time. Best effort: failing to cache costs speed,
          // not correctness, and must not stop them reading.
          try {
            await r2PutObject({ ...cfg, publicBase: 'https://private.invalid' },
              { key: mine, body: bytes, contentType: 'application/pdf' });
          } catch (e) { console.warn('[ebook-file] cache write:', e.message); }
        } catch (e) {
          // A malformed or encrypted PDF that pdf-lib cannot parse. They paid;
          // serve the book rather than an error, and log it so it gets fixed.
          console.warn('[ebook-file] stamp failed, serving unstamped', slug, e.message);
          bytes = raw;
        }
      } else {
        // Past the cap, parsing the whole document would exceed the worker's
        // memory and take the request down with it. See ebook-watermark.js.
        console.warn('[ebook-file] too large to stamp', slug, raw.length);
        bytes = raw;
      }
    }

    try {
      await db.from('ebook_entitlements')
        .update({ downloads: (owned.downloads || 0) + 1, last_download_at: new Date().toISOString() })
        .eq('id', owned.id);
    } catch (e) { console.warn('[ebook-file] counter:', e.message); }

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        // inline, not attachment: this is opened by the reader, never saved.
        'Content-Disposition': `inline; filename="${String(ebook.title || slug).replace(/[^\w .-]/g, '_').slice(0, 80)}.pdf"`,
        'Content-Length': String(bytes.length),
        'Cache-Control': 'no-store, private',
        'Vary': 'Authorization',
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  } catch (e) {
    console.error('[ebook-file]', e.message);
    return json(500, { error: 'Could not open the book.' });
  }
};
