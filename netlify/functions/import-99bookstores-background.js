/**
 * Netlify Background Function: import-99bookstores
 * POST /.netlify/functions/import-99bookstores-background
 *
 * Admin one-shot: scrapes 99bookstores.com (Shopify products.json), dedupes
 * against ALL_BOOKS.json + existing custom_products by normalized title, and
 * inserts the new titles into custom_products.
 *
 * Decisions (per store owner):
 *   - price = 99bookstores' selling price MINUS ₹10 (floor ₹1); MRP = compare-at.
 *   - listed as NEW (no used-condition note).
 *   - titles are de-obfuscated (the source hides letters as digits: M0UNTAlN → MOUNTAIN).
 *   - VISIBILITY: the newest FEED_COUNT (by created_at) are shown on the homepage
 *     feed; ALL others are tagged '99bookstores-catalog' → excluded from the
 *     per-pageview get-product-overrides feed (egress) and browsed via /books.
 *
 * Requires a browser User-Agent header or the origin returns 503 (bot block).
 * Background variant: ~5k products + batched upserts exceed the 26s sync ceiling.
 *
 * Body (all optional): { max_pages=30, feed_count=150 }
 * Headers: X-Admin-Token (requireAdmin).
 */

const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs   = require('fs');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-Admin-Key',
  'Content-Type': 'application/json',
};

const SOURCE       = '99bookstores.com';
const SOURCE_TAG   = 'imported-99bookstores';
const BROWSE_TAG   = '99bookstores-catalog';   // excluded from homepage feed; shown in /books
const PRICE_CUT    = 10;                        // ₹ off the source selling price
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ── Title de-obfuscation ─────────────────────────────────────────────────────
// 99bookstores hides letters as look-alike digits to dodge publisher scrapers
// ("THE M0UNTAlN IS Y0U"). Only swap a digit that sits BETWEEN two letters, so
// real numbers ("1984", "Catch 22") are untouched. Match the neighbour's case.
function deobfuscate(raw) {
  let s = String(raw || '');
  s = s.replace(/(?<=[A-Za-z])0(?=[A-Za-z])/g, (m, i, str) => {
    const next = str[i + 1]; return next && next === next.toUpperCase() ? 'O' : 'o';
  });
  s = s.replace(/(?<=[A-Za-z])1(?=[A-Za-z])/g, (m, i, str) => {
    const next = str[i + 1]; return next && next === next.toUpperCase() ? 'I' : 'i';
  });
  return s;
}

// ── Title normalization (shared shape with the other importers) ──────────────
function normalizeTitle(raw) {
  let s = deobfuscate(String(raw || '')).toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  s = s.replace(/\s+(?:by|[–—-])\s+.+$/i, '');
  s = s.replace(/\b(paperback|hardcover|hardback|edition|book|novel|pb|hb)\b/g, ' ');
  s = s.replace(/[^a-z0-9]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return s;
}

function slugify(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#\d+;|&[a-z]+;/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function loadCatalogTitles() {
  const candidates = [
    path.join(__dirname, '..', '..', 'data', 'ALL_BOOKS.json'),
    path.join(process.cwd(), 'data', 'ALL_BOOKS.json'),
    path.join('/var/task', 'data', 'ALL_BOOKS.json'),
  ];
  for (const p of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      return raw.map(b => String(b.title || ''));
    } catch (e) { /* next */ }
  }
  console.warn('[import-99bookstores] ALL_BOOKS.json not found');
  return [];
}

async function fetchAll(maxPages) {
  const products = [];
  const diag = { first_status: null, fetch_error: null };
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://99bookstores.com/products.json?limit=250&page=${page}`;
    let batch;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      if (page === 1) diag.first_status = res.status;
      if (!res.ok) {
        const snippet = (await res.text().catch(() => '')).slice(0, 200);
        console.warn(`[import-99bookstores] page ${page} HTTP ${res.status}`);
        if (page === 1) diag.fetch_error = `HTTP ${res.status} on page 1 — ${snippet}`;
        break;
      }
      const data = await res.json();
      batch = data.products || [];
    } catch (e) {
      console.warn(`[import-99bookstores] page ${page} error: ${e.message}`);
      if (page === 1) diag.fetch_error = e.message;
      break;
    }
    if (!batch.length) break;
    products.push(...batch);
    if (batch.length < 250) break;
  }
  return { products, diag };
}

function priceOf(p) {
  const v = (p.variants || [])[0] || {};
  const sale = Math.round(parseFloat(v.price || 0) || 0);
  const compare = Math.round(parseFloat(v.compare_at_price || 0) || 0);
  return { sale, compare };
}

// Author from a trailing "… by <Name>" in the title, else blank.
function authorFrom(title) {
  const m = String(title).match(/\bby\s+([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+){0,3})\s*$/);
  return m ? m[1].trim().slice(0, 120) : '';
}

// First human-friendly category tag, else 'Books'.
function categoryFrom(tags) {
  const skip = /^(booksat99|rack:|ordered:|selfhelp$)/i;
  const nice = (tags || [])
    .filter(t => t && !/^rack:|^ordered:|^booksat99$/i.test(t))
    .map(t => String(t).trim());
  const map = { selfhelp: 'Self Help', romance: 'Romance', romancenew: 'Romance', fiction: 'Fiction', 'non-fiction': 'Non-Fiction' };
  for (const t of nice) {
    const key = t.toLowerCase();
    if (map[key]) return map[key];
  }
  const firstWord = nice.find(t => /^[A-Za-z][A-Za-z\s&-]+$/.test(t));
  return firstWord ? firstWord.slice(0, 60) : 'Books';
}

function descriptionFor(title, body) {
  const clean = stripHtml(body);
  const extra = clean && clean.length > 20 ? `<p>${clean.slice(0, 3000)}</p>` : '';
  return (
    `<p><strong>${title}</strong> — available at Ink &amp; Chai with fast pan-India ` +
    `delivery. Cash on Delivery and prepaid (UPI/cards) both accepted, and a GST ` +
    `invoice is available on request.</p>` + extra
  );
}

async function runImport(supabase, opts) {
  const maxPages  = Math.max(1, Math.min(60, Number(opts.max_pages)  || 30));
  const feedCount = Math.max(0, Math.min(1000, Number(opts.feed_count) ?? 150));

  const catalogNorm = new Set(loadCatalogTitles().map(normalizeTitle).filter(Boolean));

  const { data: existing, error: exErr } = await supabase
    .from('custom_products').select('slug,title').limit(30000);
  if (exErr) throw new Error('custom_products lookup: ' + exErr.message);
  const existingNorm  = new Set((existing || []).map(r => normalizeTitle(r.title)).filter(Boolean));
  const existingSlugs = new Set((existing || []).map(r => r.slug).filter(Boolean));

  const { products, diag } = await fetchAll(maxPages);
  console.log(`[import-99bookstores] fetched ${products.length}; catalog=${catalogNorm.size} custom=${existingNorm.size} first_status=${diag.first_status} fetch_error=${diag.fetch_error || '-'}`);

  // Sort newest-first by created_at so the "feed" slice is genuinely the newest.
  products.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

  const rows = [];
  const seenNorm = new Set();
  const skipped = { dupe_catalog: 0, dupe_custom: 0, dupe_batch: 0, no_title: 0, no_price: 0, no_image: 0, dupe_slug: 0 };

  for (const p of products) {
    const title = deobfuscate(stripHtml(p.title));
    if (!title) { skipped.no_title++; continue; }
    const norm = normalizeTitle(title);
    if (!norm) { skipped.no_title++; continue; }
    if (catalogNorm.has(norm))  { skipped.dupe_catalog++; continue; }
    if (existingNorm.has(norm)) { skipped.dupe_custom++;  continue; }
    if (seenNorm.has(norm))     { skipped.dupe_batch++;   continue; }
    seenNorm.add(norm);

    const { sale, compare } = priceOf(p);
    if (!sale || sale <= 0) { skipped.no_price++; continue; }
    const price = Math.max(1, sale - PRICE_CUT);
    const mrp   = compare > price ? compare : null;

    const img = (p.images || [])[0]?.src || '';
    if (!img) { skipped.no_image++; continue; }

    let slug = slugify(p.handle || title);
    if (existingSlugs.has(slug)) slug = `${slug}-99b${String(p.id).slice(-5)}`;
    if (existingSlugs.has(slug)) { skipped.dupe_slug++; continue; }
    existingSlugs.add(slug);

    rows.push({
      slug,
      title: title.slice(0, 220),
      author: authorFrom(title),
      category: categoryFrom(p.tags),
      description: descriptionFor(title, p.body_html),
      price_inr: price,
      original_price_inr: mrp,
      image_url: img,   // cdn.shopify.com — external, no Supabase egress
      publisher: '',
      isbn: '',
      seo_title: `${title.slice(0, 150)} | Buy Online in India | Ink & Chai`,
      meta_description: `Buy ${title.slice(0, 120)} online at Ink & Chai — fast pan-India delivery, COD & prepaid, GST invoice available.`.slice(0, 300),
      // tag assigned below once we know the newest-slice cutoff
      _created_at: p.created_at || '',
      is_active: true,
      updated_at: new Date().toISOString(),
    });
  }

  // rows are already newest-first (products were sorted). The first `feedCount`
  // stay OFF the browse-only tag → they appear on the homepage feed; the rest
  // get BROWSE_TAG → excluded from the per-pageview feed, shown via /books.
  rows.forEach((r, i) => {
    r.tags = (i < feedCount ? SOURCE_TAG : `${SOURCE_TAG},${BROWSE_TAG}`);
    delete r._created_at;
  });

  console.log(`[import-99bookstores] to-insert=${rows.length} on-feed=${Math.min(feedCount, rows.length)} skipped=${JSON.stringify(skipped)}`);

  let inserted = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from('custom_products').upsert(chunk, { onConflict: 'slug' });
    if (error) { errors.push(`batch ${i}: ${error.message}`); console.error('[import-99bookstores]', error.message); }
    else inserted += chunk.length;
  }

  const summary = {
    source: SOURCE, fetched: products.length, inserted,
    on_homepage_feed: Math.min(feedCount, rows.length),
    browse_only: Math.max(0, rows.length - feedCount),
    first_status: diag.first_status, fetch_error: diag.fetch_error,
    skipped, errors, finished_at: new Date().toISOString(),
  };
  console.log('[import-99bookstores] SUMMARY', JSON.stringify(summary));
  // Persist so the outcome is queryable — Netlify hides background-function
  // logs, so this is the only way to see what happened. Best-effort.
  await recordRun(supabase, summary);
  return summary;
}

// Write the run summary to import_runs so it can be inspected with SQL
// (Netlify does not surface background-function logs). Never throws.
async function recordRun(supabase, summary) {
  try {
    await supabase.from('import_runs').insert({
      source: SOURCE,
      summary,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[import-99bookstores] recordRun (run sql/import_runs.sql):', e.message);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase env vars missing' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* defaults */ }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const summary = await runImport(supabase, body);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, ...summary }) };
  } catch (err) {
    console.error('[import-99bookstores] fatal:', err.message);
    await recordRun(supabase, { source: SOURCE, fatal_error: err.message, finished_at: new Date().toISOString() });
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
