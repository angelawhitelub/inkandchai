/**
 * Netlify Function: img-proxy
 *
 * Proxies public Supabase Storage images through Netlify's durable CDN so each
 * image is fetched from Supabase at most once per 30 days per edge — the rest
 * of the traffic (crawlers, Merchant Center refetches, ad-preview clicks, the
 * long tail of product-page views) is served from Netlify's edge.
 *
 * Why this exists: our admin-created product listings (Heartstopper, crossword
 * imports, etc.) upload covers to Supabase Storage. When the HTML references
 * <project>.supabase.co/storage/... directly, every hit is Supabase cached
 * egress — Supabase's free-plan meter blew past 400% off this alone.
 *
 * Usage: /.netlify/functions/img-proxy?u=<absolute-supabase-storage-url>
 * Also mounted at /spimg/<path> via a netlify.toml redirect for shorter URLs.
 *
 * Safety: only proxies URLs pointing at the configured Supabase Storage host
 * (SUPABASE_URL). Anything else returns 400 — we're not a general open proxy.
 */

const HEADERS = {
  // 30-day durable cache at Netlify's edge; immutable because image URLs are
  // content-addressed (upload paths change when a new file replaces one).
  'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=2592000, immutable',
  'Cache-Control':             'public, max-age=86400, immutable',
  'Access-Control-Allow-Origin': '*',
};

function allowedHost() {
  const url = process.env.SUPABASE_URL;
  if (!url) return null;
  try { return new URL(url).host; } catch { return null; }
}

function pickSource(event) {
  const q = event.queryStringParameters || {};
  // ?u=<full-supabase-url>  — used when we rewrite absolute URLs in HTML
  if (q.u) return q.u;
  // /spimg/<bucket>/<path>  — cleaner form used by the redirect
  const m = event.path.match(/\/spimg\/(.+)$/);
  if (m && process.env.SUPABASE_URL) {
    return `${process.env.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/${m[1]}`;
  }
  return null;
}

exports.handler = async (event) => {
  const host = allowedHost();
  if (!host) return { statusCode: 500, body: 'SUPABASE_URL not configured' };

  const src = pickSource(event);
  if (!src) return { statusCode: 400, body: 'Missing image source' };

  let parsed;
  try { parsed = new URL(src); } catch { return { statusCode: 400, body: 'Bad URL' }; }
  if (parsed.host !== host) {
    return { statusCode: 400, body: 'Only proxies configured Supabase host' };
  }
  // Extra defence: only allow the public storage prefix.
  if (!parsed.pathname.startsWith('/storage/v1/object/public/')) {
    return { statusCode: 400, body: 'Only public storage objects allowed' };
  }

  try {
    const res = await fetch(parsed.toString());
    if (!res.ok) return { statusCode: res.status, body: `upstream ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') || 'image/jpeg';
    return {
      statusCode: 200,
      headers: { ...HEADERS, 'Content-Type': ct },
      body: buf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e) {
    console.error('img-proxy error:', e.message);
    return { statusCode: 502, body: 'Upstream fetch failed' };
  }
};
