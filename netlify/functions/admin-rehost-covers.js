/**
 * Owner-only: find admin-added books whose cover no longer loads and give them
 * one that does, hosted on our own R2 bucket.
 *
 * In October 2026 about 1,400 covers stored in Shopify Files started returning
 * 404 -- almost all of them Amazon images (41JXUQY-eRL._AC_UY218.jpg) copied
 * there June-September 2026, plus the generated "ChatGPT_Image_May_25_2026…"
 * placeholders. A cover on someone else's storage can vanish without notice,
 * so a recovered cover is copied to R2 rather than linked.
 *
 *   GET  ?offset=0&limit=300[&table=product_overrides]
 *        -> { broken: [{ table, slug, title, isbn, image_url, status }], scanned, total }
 *        Checks every Shopify-hosted cover in that window with a HEAD request.
 *   POST { items: [{ table?, slug, from, sources: [url | 'placeholder', …] }], dry_run? }
 *        Tries each source in order; the first that returns a real image is
 *        uploaded to R2 and becomes image_url. 'placeholder' sets the site's
 *        "Cover coming soon" card, which the Merchant feed already skips.
 *        `goodreads:<book id>` reads that Goodreads page's og:image (the old
 *        files were Goodreads 50px thumbnails named <id>._SX50.jpg) and is used
 *        only when the page's title shares most words with ours.
 *        Written only while the stored image_url still equals `from`.
 */
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { r2PutObject, r2Config, r2Configured } = require('./utils/r2-put');
const { purgeProductSlugs } = require('./utils/purge-cache');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const PLACEHOLDER = 'https://inkandchai.in/images/cover-coming-soon.png';
const TABLES = new Set(['custom_products', 'product_overrides']);
const MAX_ITEMS = 25;
const MIN_BYTES = 2000;          // Open Library and Amazon both answer some misses with a 1x1 / 43-byte gif
// Where a recovered cover may come from. Anything else is refused so this
// cannot be used to copy arbitrary URLs into the bucket.
const SOURCE_HOSTS = /^(m\.media-amazon\.com|images-na\.ssl-images-amazon\.com|covers\.openlibrary\.org|archive\.org|[a-z0-9-]+\.us\.archive\.org)$/;

function sourceAllowed(url) {
  if (url === 'placeholder' || /^goodreads:\d{3,12}$/.test(String(url))) return true;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && SOURCE_HOSTS.test(u.hostname);
  } catch { return false; }
}

const isShopify = (url) => /^https:\/\/cdn\.shopify\.com\//.test(String(url || ''));

async function headStatus(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return res.status;
  } catch { return 0; }
}

/** Fetch a candidate cover; null unless it is a real image. */
async function fetchImage(url) {
  // Open Library follows redirects to archive.org; each hop must stay allowed.
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    if (!sourceAllowed(current)) return null;
    const res = await fetch(current, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    if (!res.ok) return null;
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length < MIN_BYTES) return null;
    return { body, type };
  }
  return null;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'book', 'books', 'paperback', 'hardcover', 'edition']);
// Letters and marks of any script, so Hindi titles compare too.
const words = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{M}\p{N} ]+/gu, ' ')
  .split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

const share = (a, b) => (a.length ? a.filter((w) => b.includes(w)).length / a.length : 0);

// Ours often ends "by Author"; Goodreads adds "(Series #3)", subtitles, and
// cuts long titles off with "…". Compare the full titles and the parts before
// a subtitle, and let either side being mostly inside the other count.
const variants = (t) => {
  const full = String(t || '').replace(/\s*\|\s*Goodreads\s*$/i, '').replace(/\S*…\s*$/, '')
    .replace(/\s+by\s+[^:()]+$/i, '').replace(/\([^)]*\)/g, ' ');
  const main = full.split(/\s*[:–—]\s*|\s+-\s+/)[0];
  return [words(full), words(main)].filter((w) => w.length);
};

/** How well two titles agree, 0-1. */
function titleOverlap(ours, theirs) {
  let best = 0;
  for (const a of variants(ours)) for (const b of variants(theirs)) best = Math.max(best, share(a, b), share(b, a));
  return best;
}

/**
 * The cover URL on a Goodreads book page, if the page is the same book.
 * Returns { url } or { why } so a refusal (Goodreads answers bursts with 202)
 * can be told apart from a title mismatch.
 */
async function goodreadsCover(id, title) {
  const res = await fetch(`https://www.goodreads.com/book/show/${id}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' },
  });
  if (res.status !== 200) return { why: `goodreads ${res.status}` };
  const html = await res.text();
  const img = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1];
  const theirs = (html.match(/<meta property="og:title" content="([^"]+)"/) || html.match(/<title>([^<]+)/) || [])[1];
  if (!img || !theirs) return { why: 'goodreads page has no cover' };
  if (titleOverlap(title, theirs) < 0.6) return { why: `title mismatch: ${theirs.slice(0, 80)}` };
  return { url: img.replace(/&amp;/g, '&') };
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

async function scan(db, table, offset, limit) {
  let q = db.from(table).select(table === 'custom_products' ? 'slug,title,isbn,image_url' : 'slug,title,image_url', { count: 'exact' });
  if (table === 'product_overrides') q = q.not('image_url', 'is', null);
  const { data, error, count } = await q.order('slug', { ascending: true }).range(offset, offset + limit - 1);
  if (error) throw error;
  const rows = (data || []).filter((r) => isShopify(r.image_url));
  const broken = [];
  for (let i = 0; i < rows.length; i += 25) {
    const chunk = rows.slice(i, i + 25);
    const statuses = await Promise.all(chunk.map((r) => headStatus(r.image_url)));
    chunk.forEach((r, k) => {
      if (statuses[k] === 404 || statuses[k] === 403 || statuses[k] === 410) {
        broken.push({ table, slug: r.slug, title: r.title, isbn: r.isbn || null, image_url: r.image_url, status: statuses[k] });
      }
    });
  }
  return { broken, scanned: rows.length, total: count, rows: (data || []).length };
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
      const table = TABLES.has(q.table) ? q.table : 'custom_products';
      const offset = Math.max(0, Math.floor(Number(q.offset) || 0));
      const limit = Math.min(400, Math.max(1, Math.floor(Number(q.limit) || 300)));
      return json(200, { table, offset, limit, ...(await scan(db, table, offset, limit)) });
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'GET or POST' });
    if (!r2Configured()) return json(500, { error: 'R2 is not configured' });

    let body;
    try { body = JSON.parse(event.body || '{}') || {}; } catch { return json(400, { error: 'Invalid JSON' }); }
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length || items.length > MAX_ITEMS) return json(400, { error: `send 1-${MAX_ITEMS} items` });

    const results = [];
    const purged = [];
    for (const item of items) {
      const table = item && TABLES.has(item.table) ? item.table : 'custom_products';
      const slug = item && typeof item.slug === 'string' ? item.slug : '';
      const sources = Array.isArray(item && item.sources) ? item.sources.filter(sourceAllowed).slice(0, 4) : [];
      if (!slug || typeof item.from !== 'string' || !sources.length) { results.push({ slug, ok: false, reason: 'bad item' }); continue; }

      const { data: row, error } = await db.from(table).select('slug,title,image_url').eq('slug', slug).maybeSingle();
      if (error) { results.push({ slug, ok: false, reason: error.message }); continue; }
      if (!row) { results.push({ slug, ok: false, reason: 'not found' }); continue; }
      if (row.image_url !== item.from) { results.push({ slug, ok: false, reason: 'changed since read' }); continue; }

      let url = null;
      let via = null;
      const why = [];
      for (const src of sources) {
        if (src === 'placeholder') { url = PLACEHOLDER; via = 'placeholder'; break; }
        let from = src;
        if (src.startsWith('goodreads:')) {
          const gr = await goodreadsCover(src.slice(10), row.title).catch((e) => ({ why: `goodreads ${e.message}` }));
          if (!gr.url || !sourceAllowed(gr.url)) { why.push(gr.why || 'goodreads cover host not allowed'); continue; }
          from = gr.url;
        }
        const img = await fetchImage(from).catch(() => null);
        if (!img) { why.push(`no image at ${new URL(from).hostname}`); continue; }
        if (body.dry_run === true) { url = '(dry run)'; via = src.startsWith('goodreads:') ? 'goodreads' : new URL(src).hostname; break; }
        const key = `covers/rehost/${slug}.${EXT[img.type]}`;
        url = await r2PutObject(r2Config(), { key, body: img.body, contentType: img.type });
        via = src.startsWith('goodreads:') ? 'goodreads' : new URL(src).hostname;
        break;
      }
      if (!url) { results.push({ slug, ok: false, reason: 'no source worked', why }); continue; }
      if (body.dry_run === true) { results.push({ slug, ok: true, via, dry_run: true }); continue; }

      const { error: upErr } = await db.from(table).update({ image_url: url }).eq('slug', slug);
      if (upErr) { results.push({ slug, ok: false, reason: upErr.message }); continue; }
      purged.push(slug);
      results.push({ slug, ok: true, via, image_url: url });
    }
    if (purged.length) await purgeProductSlugs(purged).catch(() => {});
    return json(200, { written: purged.length, results });
  } catch (e) {
    console.error('[admin-rehost-covers]', e);
    return json(500, { error: e.message });
  }
};

exports.sourceAllowed = sourceAllowed;
exports.isShopify = isShopify;
exports.titleOverlap = titleOverlap;
