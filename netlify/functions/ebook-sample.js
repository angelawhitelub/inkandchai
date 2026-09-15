/**
 * Netlify Function: ebook-sample   (public — no sign-in)
 * GET ?slug=… → a PDF of the first few pages
 *
 * The Kindle "Read sample" equivalent: enough of the book to decide, and
 * nothing more.
 *
 * WHY THE SAMPLE IS A SEPARATE DOCUMENT, NOT THE BOOK WITH A PAGE LIMIT
 * A viewer told to stop at page five is a suggestion; the rest of the book
 * still travelled to the browser. utils/ebook-watermark builds the sample by
 * copying five pages into a NEW document, so the other three hundred pages do
 * not exist in the bytes at all. There is nothing to scroll past and nothing to
 * recover from the file.
 *
 * This one IS cacheable, unlike every other eBook endpoint. It carries no
 * identity, it is the same for every visitor, and it is marketing — the whole
 * point is that it spreads.
 */

const { createClient } = require('@supabase/supabase-js');
const { r2GetObject, r2PutObject, r2EbookConfig, r2EbookConfigured } = require('./utils/r2-put');
const { normaliseSlug } = require('./utils/ebook');
const { buildSample, sampleKey, SAMPLE_PAGES, MAX_STAMP_BYTES } = require('./utils/ebook-watermark');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
             'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    }, body: '' };
  }
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const slug = normaliseSlug((event.queryStringParameters || {}).slug);
  if (!slug) return json(400, { error: 'Which eBook?' });
  if (!r2EbookConfigured()) return json(503, { error: 'Samples are temporarily unavailable.' });

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const { data: ebook } = await db.from('ebooks')
      .select('r2_key, title').eq('slug', slug).eq('active', true).maybeSingle();
    if (!ebook?.r2_key) return json(404, { error: 'No sample for that book.' });

    const cfg = r2EbookConfig();
    const key = sampleKey(slug, ebook.r2_key);

    let bytes = null;
    const cached = await r2GetObject(cfg, key);
    if (cached.ok) {
      bytes = Buffer.from(cached.body);
    } else {
      const original = await r2GetObject(cfg, ebook.r2_key);
      if (!original.ok) return json(404, { error: 'No sample for that book.' });
      const raw = Buffer.from(original.body);
      // Same memory reasoning as stamping: pdf-lib parses the whole document.
      if (raw.length > MAX_STAMP_BYTES) {
        console.warn('[ebook-sample] too large to sample', slug, raw.length);
        return json(503, { error: 'A sample is not available for this book.' });
      }
      const built = await buildSample(raw, {});
      bytes = built.bytes;
      try {
        await r2PutObject({ ...cfg, publicBase: 'https://private.invalid' },
          { key, body: bytes, contentType: 'application/pdf' });
      } catch (e) { console.warn('[ebook-sample] cache write:', e.message); }
    }

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="sample.pdf"',
        'Content-Length': String(bytes.length),
        'Cache-Control': 'public, max-age=600',
        'Netlify-CDN-Cache-Control': 'public, s-maxage=3600',
        'X-Content-Type-Options': 'nosniff',
        'X-Sample-Pages': String(SAMPLE_PAGES),
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    console.error('[ebook-sample]', e.message);
    return json(500, { error: 'Could not build the sample.' });
  }
};
