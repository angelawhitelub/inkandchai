/**
 * Netlify Background Function: import-crossword-all
 * POST /.netlify/functions/import-crossword-all-background
 *
 * Admin one-shot: scrapes the ENTIRE crossword.in book catalogue (Shopify
 * products.json, ~100 pages), keeps only product_type === 'Books', dedupes
 * against ALL_BOOKS.json + existing custom_products by normalized title, and
 * inserts the new titles into custom_products with:
 *   - price = 22.5% off the compare-at MRP
 *   - tags  = publisher-sourced-bestseller,crossword-catalog,no-cod
 *       • publisher-sourced-bestseller → "Genuine, sourced from publisher"
 *         banner + IC-CW- order id prefix (existing behaviour)
 *       • crossword-catalog → EXCLUDED from the get-product-overrides homepage
 *         feed (that feed loads on every pageview; 8k books there would blow
 *         Supabase egress). Served instead by the paginated /books browse page.
 *       • no-cod → Cash on Delivery disabled at checkout; partial COD (pay 10%)
 *         recommended instead.
 *   - description mentions GST invoice availability.
 *
 * Background variant: scraping 100 pages + batched upserts of thousands of
 * rows needs more than the 26s sync ceiling.
 *
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

const DISCOUNT = 0.225;        // 22.5% off MRP
const TAGS = 'publisher-sourced-bestseller,crossword-catalog,no-cod';
const SOURCE = 'crossword.in';

// ── Title normalization — shared shape with the bookstohome importer ─────────
function normalizeTitle(raw) {
  let s = String(raw || '').toLowerCase();
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
  console.warn('[import-crossword-all] ALL_BOOKS.json not found');
  return [];
}

async function fetchAllBooks() {
  const books = [];
  for (let page = 1; page <= 120; page++) {
    const url = `https://www.crossword.in/products.json?limit=250&page=${page}`;
    let batch;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) { console.warn(`[import-crossword-all] page ${page} HTTP ${res.status}`); break; }
      const data = await res.json();
      batch = data.products || [];
    } catch (e) {
      console.warn(`[import-crossword-all] page ${page} fetch error: ${e.message}`);
      break;
    }
    if (!batch.length) break;
    for (const p of batch) {
      const type = String(p.product_type || '').toLowerCase();
      // Books only — skip toys, stationery, accessories, hotwheels, etc.
      if (type !== 'books' && type !== 'b-format paperback') continue;
      books.push(p);
    }
  }
  return books;
}

function priceOf(p) {
  const v = (p.variants || [])[0] || {};
  const sale = parseFloat(v.price || 0) || 0;
  const compare = parseFloat(v.compare_at_price || 0) || 0;
  // MRP is the compare-at price; fall back to the list price if none.
  const mrp = compare > 0 ? compare : sale;
  return { mrp, sale };
}

function descriptionFor(title, body) {
  const clean = stripHtml(body);
  const extra = clean && clean.length > 20 ? `<p>${clean.slice(0, 3500)}</p>` : '';
  return (
    `<p><strong>${title}</strong> is a 100% genuine paperback, sourced directly ` +
    `from the publisher or authorised distributors — never pirated or photocopied.</p>` +
    `<p><strong>GST invoice is available</strong> on every order. ` +
    `Cash on Delivery is not available on these titles — we recommend ` +
    `<strong>Partial COD</strong>: pay just 10% now to confirm your order and ` +
    `the balance on delivery. Fast pan-India shipping.</p>` +
    extra
  );
}

async function runImport(supabase) {
  const catalogNorm = new Set(loadCatalogTitles().map(normalizeTitle).filter(Boolean));

  const { data: existing, error: exErr } = await supabase
    .from('custom_products')
    .select('slug,title')
    .limit(20000);
  if (exErr) throw new Error('custom_products lookup: ' + exErr.message);
  const existingNorm  = new Set((existing || []).map(r => normalizeTitle(r.title)).filter(Boolean));
  const existingSlugs = new Set((existing || []).map(r => r.slug).filter(Boolean));

  const books = await fetchAllBooks();
  console.log(`[import-crossword-all] fetched ${books.length} books; catalog=${catalogNorm.size} custom=${existingNorm.size}`);

  const rows = [];
  const seenNorm = new Set();
  const skipped = { dupe_catalog: 0, dupe_custom: 0, dupe_batch: 0, no_title: 0, no_price: 0, no_image: 0 };

  for (const p of books) {
    const title = stripHtml(p.title);
    if (!title) { skipped.no_title++; continue; }
    const norm = normalizeTitle(title);
    if (!norm) { skipped.no_title++; continue; }
    if (catalogNorm.has(norm))  { skipped.dupe_catalog++; continue; }
    if (existingNorm.has(norm)) { skipped.dupe_custom++;  continue; }
    if (seenNorm.has(norm))     { skipped.dupe_batch++;   continue; }
    seenNorm.add(norm);

    const { mrp, sale } = priceOf(p);
    if (!mrp || mrp <= 0) { skipped.no_price++; continue; }
    const price = Math.max(1, Math.round(mrp * (1 - DISCOUNT)));

    const img = (p.images || [])[0]?.src || '';
    if (!img) { skipped.no_image++; continue; }

    let slug = slugify(p.handle || title);
    if (existingSlugs.has(slug)) slug = `${slug}-cw${String(p.id).slice(-5)}`;
    if (existingSlugs.has(slug)) continue;
    existingSlugs.add(slug);

    rows.push({
      slug,
      title: title.slice(0, 220),
      author: '',
      category: 'Books',
      description: descriptionFor(title, p.body_html),
      price_inr: price,
      original_price_inr: mrp > price ? Math.round(mrp) : null,
      image_url: img,
      publisher: '',
      isbn: '',
      seo_title: `${title.slice(0, 150)} | Genuine Paperback | Ink & Chai`,
      meta_description: `Buy ${title.slice(0, 120)} online — genuine publisher-sourced paperback at ${Math.round(DISCOUNT*100)}% off. GST invoice available. Partial COD (pay 10%) accepted.`.slice(0, 300),
      tags: TAGS,
      is_active: true,
      updated_at: new Date().toISOString(),
    });
  }

  console.log(`[import-crossword-all] to-insert=${rows.length} skipped=${JSON.stringify(skipped)}`);

  let inserted = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from('custom_products').upsert(chunk, { onConflict: 'slug' });
    if (error) { errors.push(`batch ${i}: ${error.message}`); console.error('[import-crossword-all]', error.message); }
    else inserted += chunk.length;
    if ((i / 500) % 4 === 3) console.log(`[import-crossword-all] progress inserted=${inserted}/${rows.length}`);
  }

  const summary = { source: SOURCE, fetched_books: books.length, inserted, skipped, errors, finished_at: new Date().toISOString() };
  console.log('[import-crossword-all] SUMMARY', JSON.stringify(summary));
  return summary;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase env vars missing' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const summary = await runImport(supabase);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, ...summary }) };
  } catch (err) {
    console.error('[import-crossword-all] fatal:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
