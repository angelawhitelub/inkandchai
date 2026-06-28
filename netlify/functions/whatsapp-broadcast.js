/**
 * Netlify Function: whatsapp-broadcast
 * POST /.netlify/functions/whatsapp-broadcast
 *
 * TWO MODES:
 *
 * Mode 1 — Simple blast (one message to everyone):
 *   { template: "broadcast_reengage_v1", days_back: 60 }
 *
 * Mode 2 — Personalized (each customer gets relevant book recommendations):
 *   { template: "broadcast_personal_v1", days_back: 90, personalized: true,
 *     segment_by: "author" | "category" | "language" | "auto" }
 *
 * In personalized mode, the function:
 *   1. Loads ALL_BOOKS.json (in included_files)
 *   2. Builds {title → meta} and {category → top books} maps
 *   3. For each customer, analyses their past orders to derive their primary
 *      reading signal (author / category / language)
 *   4. Picks 3 in-stock recommendations they haven't already bought
 *   5. Sends template with params:
 *        {{1}} = first name
 *        {{2}} = bucket label   (e.g. "Romance books" or "Ana Huang's novels")
 *        {{3}} = bullet list of 3 book recommendations
 *
 * Suggested Meta template (Marketing category):
 *
 *   Hi {{1}}! 📚
 *
 *   You loved {{2}} — and we just got these in stock:
 *
 *   {{3}}
 *
 *   🎁 Every prepaid order this week comes with a cashback scratch card (up to ₹200).
 *
 *   Tap to browse your matches →
 */

const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { sendWhatsApp, normalizePhone } = require('./utils/whatsapp');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

const BATCH_SIZE   = 20;
const BATCH_DELAY  = 250;
const MAX_PER_RUN  = 5000;
const REC_COUNT    = 3;   // recommendations per customer

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Category normalization ───────────────────────────────────────────────────
// The raw categories have noisy suffixes like "(On Sale)" or "All …". Collapse
// them into a small set of human-readable buckets used in WhatsApp copy.
function canonicalCategory(rawCat) {
  const c = String(rawCat || '').toLowerCase();
  if (!c) return null;
  if (c.includes('hindi'))                                    return 'Hindi';
  if (c.includes('other lang') || c.includes('marathi') ||
      c.includes('tamil') || c.includes('bengali') ||
      c.includes('gujarati') || c.includes('telugu'))         return 'Indian languages';
  if (c.includes('self') || c.includes('self-help'))          return 'Self-help';
  if (c.includes('romance'))                                  return 'Romance';
  if (c.includes('thriller') || c.includes('mystery'))        return 'Thriller';
  if (c.includes('kids'))                                     return 'Kids';
  if (c.includes('manga'))                                    return 'Manga';
  if (c.includes('comic'))                                    return 'Comics';
  if (c.includes('preloved') || c.includes('used'))           return 'Preloved';
  if (c.includes('biograph') || c.includes('memoir'))         return 'Biography';
  if (c.includes('business') || c.includes('finance'))        return 'Business & finance';
  if (c.includes('fiction'))                                  return 'Fiction';
  if (c.includes('new arrival'))                              return 'New arrivals';
  return 'Fiction';  // safe default
}

// Cheap language guess from title text
function guessLanguage(book) {
  const title = String(book?.title || '');
  const tags  = String(book?.tags || '').toLowerCase();
  const cat   = String(book?.category || '').toLowerCase();
  if (/[ऀ-ॿ]/.test(title))                                return 'hindi';   // Devanagari
  if (cat.includes('hindi') || tags.includes('hindi'))              return 'hindi';
  if (cat.includes('other lang') || cat.includes('marathi') ||
      cat.includes('tamil') || cat.includes('bengali'))             return 'regional';
  return 'english';
}

// Format a single book line for the recommendation block
function formatBookLine(book) {
  const title = (book.title || '').replace(/\s+/g, ' ').trim().slice(0, 50);
  const price = book.price_inr ? `₹${Math.round(parseFloat(book.price_inr))}` : '';
  return `• ${title}${price ? ' · ' + price : ''}`;
}

// ── Build segmentation maps from ALL_BOOKS.json ──────────────────────────────
let _bookCache = null;
function loadBookData() {
  if (_bookCache) return _bookCache;

  // included_files in netlify.toml puts data/ALL_BOOKS.json at runtime
  // alongside the function. Try several path candidates.
  const candidates = [
    path.join(__dirname, '..', '..', 'data', 'ALL_BOOKS.json'),
    path.join(__dirname, 'data', 'ALL_BOOKS.json'),
    path.join(process.cwd(), 'data', 'ALL_BOOKS.json'),
  ];
  let books = null;
  for (const p of candidates) {
    try { books = JSON.parse(fs.readFileSync(p, 'utf8')); if (books?.length) break; }
    catch {}
  }
  if (!books) throw new Error('ALL_BOOKS.json not found in any expected location');

  // {lowercase_title → meta}, {category → [books desc by recency]}, {author → [books]}
  const titleToMeta = new Map();
  const byCategory  = new Map();
  const byAuthor    = new Map();

  for (const b of books) {
    const title = String(b.title || '').trim();
    if (!title) continue;
    const cat   = canonicalCategory(b.category);
    const auth  = String(b.author || '').trim();
    const lang  = guessLanguage(b);

    titleToMeta.set(title.toLowerCase(), { title, author: auth, category: cat, language: lang });

    if (cat) {
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(b);
    }
    if (auth) {
      const ak = auth.toLowerCase();
      if (!byAuthor.has(ak)) byAuthor.set(ak, []);
      byAuthor.get(ak).push(b);
    }
  }

  // Sort each bucket by "newest first" — proxy: assume order in file is recency,
  // and prefer books with image_url (likely curated/current).
  for (const arr of byCategory.values()) {
    arr.sort((a, b) => {
      const ai = a.image_url ? 0 : 1;
      const bi = b.image_url ? 0 : 1;
      return ai - bi;
    });
  }

  _bookCache = { titleToMeta, byCategory, byAuthor, allBooks: books };
  return _bookCache;
}

// ── Compute a customer's reading profile from their orders ───────────────────
function buildCustomerProfile(orders, bookData) {
  const { titleToMeta } = bookData;
  const categories  = new Map();
  const authors     = new Map();
  const langs       = new Map();
  const boughtTitles = new Set();

  for (const order of orders) {
    const items = Array.isArray(order.cart_items) ? order.cart_items : [];
    for (const it of items) {
      const title = String(it.title || '').trim();
      if (!title) continue;
      boughtTitles.add(title.toLowerCase());
      const meta = titleToMeta.get(title.toLowerCase());
      if (!meta) continue;
      if (meta.category) categories.set(meta.category, (categories.get(meta.category) || 0) + 1);
      if (meta.author)   authors.set(meta.author.toLowerCase(), (authors.get(meta.author.toLowerCase()) || 0) + 1);
      if (meta.language) langs.set(meta.language,       (langs.get(meta.language) || 0) + 1);
    }
  }

  const topCategory = [...categories.entries()].sort((a,b) => b[1]-a[1])[0]?.[0] || null;
  const topAuthor   = [...authors.entries()].sort((a,b) => b[1]-a[1])[0];
  const topLang     = [...langs.entries()].sort((a,b) => b[1]-a[1])[0]?.[0] || 'english';

  return {
    topCategory,
    topAuthor:    topAuthor ? topAuthor[0] : null,
    topAuthorCount: topAuthor ? topAuthor[1] : 0,
    topLang,
    boughtTitles,
    totalBooks: [...boughtTitles].length,
  };
}

// ── Pick recommendations for a customer based on chosen segment strategy ─────
function pickRecs(profile, bookData, strategy) {
  const { byCategory, byAuthor } = bookData;
  const { topCategory, topAuthor, topAuthorCount, topLang, boughtTitles } = profile;

  let pool = [], bucketLabel = '';

  // Determine effective strategy
  let effective = strategy;
  if (strategy === 'auto') {
    // Prefer author if customer bought 2+ from same author
    if (topAuthorCount >= 2 && topAuthor && byAuthor.has(topAuthor)) effective = 'author';
    else if (topCategory)                                            effective = 'category';
    else                                                             effective = 'language';
  }

  if (effective === 'author' && topAuthor && byAuthor.has(topAuthor)) {
    pool = byAuthor.get(topAuthor) || [];
    // Capitalise for display
    const displayName = pool[0]?.author || topAuthor;
    bucketLabel = `${displayName}'s books`;
  } else if (effective === 'category' && topCategory) {
    pool = byCategory.get(topCategory) || [];
    bucketLabel = topCategory.toLowerCase() === 'hindi'
      ? 'Hindi books'
      : `${topCategory.toLowerCase()} books`;
  } else if (effective === 'language') {
    // Just pick from popular categories in that language
    const lang = topLang || 'english';
    const cats = lang === 'hindi' ? ['Hindi']
              : lang === 'regional' ? ['Indian languages']
              : ['Fiction', 'Romance', 'Self-help'];
    pool = cats.flatMap(c => byCategory.get(c) || []);
    bucketLabel = lang === 'hindi' ? 'Hindi books'
                : lang === 'regional' ? 'books in your language'
                : 'fiction & self-help';
  }

  // Filter: not already bought, has image, has title
  const filtered = pool
    .filter(b => b.title && !boughtTitles.has(b.title.toLowerCase()))
    .filter(b => b.image_url)
    .slice(0, REC_COUNT * 4);  // grab extra for randomisation

  // Shuffle within filtered to vary recs per customer in the same bucket
  for (let i = filtered.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
  }

  const recs = filtered.slice(0, REC_COUNT);
  return { recs, bucketLabel };
}

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Bad JSON' }) }; }

  const template     = String(body.template || '').trim();
  const daysBack     = Math.max(1, Math.min(365, parseInt(body.days_back) || 60));
  const dryRun       = !!body.dry_run;
  const limit        = body.limit ? Math.max(1, parseInt(body.limit)) : MAX_PER_RUN;
  const testPhone    = body.test_phone ? normalizePhone(body.test_phone) : null;
  const lang         = String(body.lang || 'en').trim();
  const personalized = !!body.personalized;
  const segmentBy    = String(body.segment_by || 'auto').toLowerCase();

  if (!template) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({
      error: 'Missing "template"',
    }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── Load + group orders by phone ────────────────────────────────────────
    let phoneToOrders;

    if (testPhone) {
      // Test mode: use this phone, but also fetch their order history if any
      const { data } = await supabase
        .from('orders')
        .select('customer_phone, customer_name, cart_items, created_at')
        .eq('customer_phone', testPhone.replace(/^91/, ''))
        .order('created_at', { ascending: false })
        .limit(50);
      const orders = data || [];
      const name = orders[0]?.customer_name?.split(' ')[0] || 'there';
      phoneToOrders = new Map([[testPhone, { name, orders }]]);
    } else {
      const since = new Date(Date.now() - daysBack * 24 * 3600 * 1000).toISOString();
      const { data, error } = await supabase
        .from('orders')
        .select('customer_phone, customer_name, cart_items, status, created_at')
        .in('status', ['paid', 'delivered', 'shipped', 'out_for_delivery',
                       'cod_pending', 'partial_cod_pending', 'confirmed'])
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(20000);
      if (error) throw new Error('DB query failed: ' + error.message);

      phoneToOrders = new Map();
      for (const r of (data || [])) {
        const phone = normalizePhone(r.customer_phone);
        if (!phone) continue;
        if (!phoneToOrders.has(phone)) {
          phoneToOrders.set(phone, {
            name: (r.customer_name || 'there').split(' ')[0],
            orders: [],
          });
        }
        phoneToOrders.get(phone).orders.push(r);
      }
    }

    const recipients = [...phoneToOrders.entries()]
      .slice(0, limit)
      .map(([phone, info]) => ({ phone, name: info.name, orders: info.orders }));

    if (!recipients.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        success: true, message: 'No recipients found', total: 0,
      }) };
    }

    // ── Personalization: build per-customer params ──────────────────────────
    let bookData = null;
    if (personalized) {
      try { bookData = loadBookData(); }
      catch (e) {
        return { statusCode: 500, headers: CORS, body: JSON.stringify({
          error: 'Failed to load book data for personalization: ' + e.message,
        }) };
      }

      for (const r of recipients) {
        const profile = buildCustomerProfile(r.orders, bookData);
        const { recs, bucketLabel } = pickRecs(profile, bookData, segmentBy);
        r.params = [
          r.name,
          bucketLabel || 'great books',
          recs.length ? recs.map(formatBookLine).join('\n') : '• New arrivals just dropped on inkandchai.in',
        ];
        r.bucketLabel = bucketLabel;
        r.profile     = { topCategory: profile.topCategory, topAuthor: profile.topAuthor, totalBooks: profile.totalBooks };
      }
    } else {
      for (const r of recipients) r.params = [r.name];
    }

    // ── Dry run ─────────────────────────────────────────────────────────────
    if (dryRun) {
      const segmentCounts = {};
      if (personalized) {
        for (const r of recipients) {
          const key = r.bucketLabel || 'unknown';
          segmentCounts[key] = (segmentCounts[key] || 0) + 1;
        }
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        success: true,
        dry_run: true,
        personalized,
        total: recipients.length,
        segment_counts: personalized ? segmentCounts : undefined,
        sample: recipients.slice(0, 10).map(r => ({
          phone: r.phone.slice(0,4) + '****' + r.phone.slice(-3),
          name: r.name,
          bucket: r.bucketLabel,
          recs_preview: r.params?.[2]?.split('\n').slice(0,3),
        })),
        message: `Would send template "${template}" to ${recipients.length} recipients. Set dry_run:false to actually send.`,
      }) };
    }

    // ── Send in batches ─────────────────────────────────────────────────────
    let sent = 0, failed = 0;
    const failures = [];

    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const batch = recipients.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(batch.map(async r => {
        try {
          await sendWhatsApp({ to: r.phone, template, params: r.params, lang });
          return { phone: r.phone, ok: true };
        } catch (e) {
          return { phone: r.phone, ok: false, error: e.message };
        }
      }));

      for (const res of results) {
        if (res.status === 'fulfilled' && res.value.ok) sent++;
        else {
          failed++;
          const reason = res.status === 'rejected' ? res.reason?.message : res.value?.error;
          if (failures.length < 20) failures.push({ phone: res.value?.phone, error: reason });
        }
      }

      if (i + BATCH_SIZE < recipients.length) await sleep(BATCH_DELAY);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        template,
        personalized,
        total: recipients.length,
        sent,
        failed,
        sample_failures: failures,
      }),
    };

  } catch (err) {
    console.error('[whatsapp-broadcast] error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
