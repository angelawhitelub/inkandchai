/**
 * Netlify Function: get-product-sample   (public)
 *
 *   GET ?slug=…            → { sample: { pages, file_url } | null }
 *   GET ?slug=…&file=pdf   → the sample PDF itself
 *
 * public/js/read-sample.js asks the first on every product page and shows the
 * "Read sample" button only when there is one. The PDF is served from our own
 * origin rather than the R2 public URL so pdf.js can read it without depending
 * on the bucket's CORS rules. Both are the same for every visitor and safe to
 * cache; the file URL carries the save time, so a replaced sample is a new URL.
 */

const { createClient } = require('@supabase/supabase-js');
const { r2GetObject, r2Config, r2Configured } = require('./utils/r2-put');
const S = require('./utils/product-sample');

const JSON_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=0, must-revalidate',
  'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=300, stale-while-revalidate=86400',
  'Netlify-Cache-Tag': 'products',
};
const json = (statusCode, body, extra = {}) => ({ statusCode, headers: { ...JSON_HEADERS, ...extra }, body: JSON.stringify(body) });
const NONE = { sample: null };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: JSON_HEADERS, body: '' };
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });
  const q = event.queryStringParameters || {};
  const slug = S.cleanSlug(q.slug);
  if (!slug) return json(400, { error: 'Missing product slug' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return json(200, NONE);

  let row = null;
  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data, error } = await db.from(S.TABLE).select('slug,r2_key,pages,updated_at').eq('slug', slug).maybeSingle();
    if (error) throw error;
    row = data;
  } catch (e) {
    // A missing migration or a Supabase blip must not break product pages.
    if (!S.isMissingTable(e)) console.warn('[get-product-sample]', e.message);
    return json(200, NONE, { 'Netlify-CDN-Cache-Control': 'public, s-maxage=30' });
  }

  if (q.file !== 'pdf') return json(200, { sample: S.publicSample(row) });

  if (!row || !r2Configured()) return json(404, { error: 'No sample for this book.' }, { 'Cache-Control': 'no-store' });
  try {
    const obj = await r2GetObject(r2Config(), row.r2_key);
    if (!obj.ok) return json(404, { error: 'No sample for this book.' }, { 'Cache-Control': 'no-store' });
    const bytes = Buffer.from(obj.body);
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${slug}-sample.pdf"`,
        'Content-Length': String(bytes.length),
        'Cache-Control': 'public, max-age=86400',
        'Netlify-CDN-Cache-Control': 'public, s-maxage=86400',
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    console.error('[get-product-sample] file', e.message);
    return json(502, { error: 'Could not load the sample.' }, { 'Cache-Control': 'no-store' });
  }
};
