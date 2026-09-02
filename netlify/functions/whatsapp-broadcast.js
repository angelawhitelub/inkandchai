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
const { optedOutPhoneSet, phoneKey } = require('./utils/bot-optout');
const { requireAdmin } = require('./utils/admin-auth');
const { loadPromotions, isLive } = require('./utils/promotions');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

const BATCH_SIZE   = 20;
const BATCH_DELAY  = 250;
const MAX_PER_RUN  = 5000;
// Hard ceiling on messages sent to people who have NOT recorded consent.
// Counted from the delivery ledger for all time, not per run -- see the pilot
// block below for why that distinction is the whole point.
const PILOT_CAP = Math.max(0, parseInt(process.env.WHATSAPP_BROADCAST_PILOT_CAP, 10) || 100);
const REC_COUNT    = 3;   // recommendations per customer
const SITE_URL     = 'https://inkandchai.in';

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
function absoluteProductUrl(book) {
  const raw = String(book?.url || '').trim();
  if (/^https:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return SITE_URL + raw;
  return raw ? `${SITE_URL}/${raw.replace(/^\/+/, '')}` : SITE_URL;
}

function absoluteImageUrl(book) {
  const raw = String(book?.image_url || '').trim();
  if (/^https:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return SITE_URL + raw;
  return raw ? `${SITE_URL}/${raw.replace(/^\/+/, '')}` : null;
}

/**
 * The slug for the template's URL button, or '' when we cannot link this book.
 *
 * The button appends this to https://inkandchai.in/product/, so the ONLY shape
 * that can be used is one that already lives at /product/<slug>/:
 *
 *   /product/<slug>/     -- a real static page. Usable.
 *   /product/?id=<slug>  -- NOT usable. These books have no page of their own;
 *                           the dynamic route looks them up client-side, and
 *                           /product/<slug>/ returns "Product not found". An
 *                           earlier version of this function extracted the id
 *                           and sent it anyway, which put a 404 button in front
 *                           of 9 customers on 2 Sept.
 *   99bookstores /products/<slug> -- NOT usable. Off-site slug, does not exist
 *                           here either.
 *
 * Everything but the first returns '', and the caller picks another book. An
 * empty parameter is what Meta rejects as "(#131008) Required parameter is
 * missing", so a book that reaches the send with '' would kill the message --
 * a dropped recommendation is the better failure than a dead link.
 */
function productSlug(book) {
  const url = absoluteProductUrl(book);
  if (!/^https:\/\/(?:[a-z0-9-]+\.)?inkandchai\.in\//i.test(url)) return '';
  return url.match(/\/product\/([^/?#]+)/i)?.[1] || '';
}

/** First recommendation we can actually link to, or null if none can be. */
function heroRec(recs) {
  return (recs || []).find(book => productSlug(book)) || null;
}

function markdownPercent(book) {
  const price = Number(book?.price_inr) || 0;
  const original = Number(book?.original_price_inr) || 0;
  return original > price && price > 0 ? Math.round((original - price) * 100 / original) : 0;
}

function formatBookLine(book) {
  const title = (book.title || '').replace(/\s+/g, ' ').trim().slice(0, 50);
  const price = book.price_inr ? `₹${Math.round(parseFloat(book.price_inr))}` : '';
  const saving = markdownPercent(book);
  const offer = saving ? ` · ${saving}% off MRP` : '';
  return `• ${title}${price ? ' · ' + price : ''}${offer}\n  ${absoluteProductUrl(book)}`;
}

function promotionLabel(promotions, now = new Date()) {
  const eligible = (promotions || [])
    .filter(p => isLive(p, now) && p.code && p.payment_methods?.includes('prepaid'))
    .sort((a, b) => {
      const av = a.discount_type === 'percent' ? a.discount_value : a.discount_value / 10;
      const bv = b.discount_type === 'percent' ? b.discount_value : b.discount_value / 10;
      return bv - av;
    });
  const p = eligible[0];
  if (!p) return 'Special prices are already live — tap below to shop.';
  const saving = p.discount_type === 'percent' ? `${p.discount_value}% off` : `₹${p.discount_value} off`;
  const minimum = p.min_subtotal_inr ? ` above ₹${p.min_subtotal_inr}` : '';
  return `Use ${p.code} for ${saving} on prepaid orders${minimum}.`;
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
  const richMedia     = !!body.rich_media;
  const source        = String(body.source || 'manual').toLowerCase();
  const campaignKey   = String(body.campaign_key || '').trim().slice(0, 120);
  const cooldownDays  = Math.max(1, Math.min(90, parseInt(body.cooldown_days) || 14));
  const requireOptIn  = !!body.require_opt_in;
  // Which order states count as "a customer". Defaults to the full buying
  // history; a caller can narrow it (e.g. ['delivered']) for a campaign that
  // only makes sense once the books are actually in someone's hands.
  const statuses = Array.isArray(body.statuses) && body.statuses.length
    ? [...new Set(body.statuses.map(v => String(v).trim().toLowerCase()).filter(Boolean))].slice(0, 12)
    : ['paid', 'delivered', 'shipped', 'out_for_delivery',
       'cod_pending', 'partial_cod_pending', 'confirmed'];

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
        .in('status', statuses)
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

    let recipients = [...phoneToOrders.entries()]
      .map(([phone, info]) => ({ phone, name: info.name, orders: info.orders }));

    // Scheduled marketing is opt-in only. The separate subscriber table makes
    // consent auditable instead of assuming that placing an order is consent.
    let consentRemoved = 0;
    if (requireOptIn) {
      const { data: subscribers, error: subscriberError } = await supabase
        .from('whatsapp_marketing_subscribers')
        .select('customer_phone')
        .eq('status', 'subscribed')
        .limit(20000);
      if (subscriberError) throw new Error('Marketing consent list unavailable; run sql/whatsapp_campaign_deliveries.sql before enabling automation. ' + subscriberError.message);
      const allowed = new Set((subscribers || []).map(row => phoneKey(row.customer_phone)));
      const before = recipients.length;
      recipients = recipients.filter(r => allowed.has(phoneKey(r.phone)));
      consentRemoved = before - recipients.length;
    }

    if (!recipients.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        success: true, message: requireOptIn ? 'No opted-in recipients found' : 'No recipients found', total: 0,
        consent_removed: consentRemoved,
      }) };
    }

    // ── Personalization: build per-customer params ──────────────────────────
    let bookData = null;
    let campaignOffer = '';
    if (personalized) {
      try { bookData = loadBookData(); }
      catch (e) {
        return { statusCode: 500, headers: CORS, body: JSON.stringify({
          error: 'Failed to load book data for personalization: ' + e.message,
        }) };
      }

      campaignOffer = promotionLabel(await loadPromotions(), new Date());
      for (const r of recipients) {
        const profile = buildCustomerProfile(r.orders, bookData);
        const { recs, bucketLabel } = pickRecs(profile, bookData, segmentBy);
        r.params = [
          r.name,
          bucketLabel || 'great books',
          recs.length ? recs.map(formatBookLine).join('\n') : '• New arrivals just dropped on inkandchai.in',
        ];
        if (richMedia) r.params.push(campaignOffer);
        r.recs = recs;
        const hero = richMedia ? heroRec(recs) : null;
        r.hero = hero;
        r.headerImageUrl = hero ? absoluteImageUrl(hero) : null;
        r.urlButtonParam = hero ? productSlug(hero) : null;
        r.bucketLabel = bucketLabel;
        r.profile     = { topCategory: profile.topCategory, topAuthor: profile.topAuthor, totalBooks: profile.totalBooks };
      }
    } else {
      for (const r of recipients) r.params = [r.name];
    }

    // A rich-media send with no linkable book is a guaranteed Meta rejection,
    // and a rejected recipient still burns a slot in the run. Drop them here,
    // before the limit slice, so the next eligible customer takes the place.
    let unlinkableRemoved = 0;
    if (personalized && richMedia) {
      const before = recipients.length;
      recipients = recipients.filter(r => r.urlButtonParam);
      unlinkableRemoved = before - recipients.length;
    }

    // ── Drop anyone who sent STOP ───────────────────────────────────────────
    // A broadcast is exactly what opting out means you no longer want. One bulk
    // lookup rather than a query per recipient. Deliberately NOT wrapped in a
    // try/catch that carries on: if we cannot tell who opted out, the safe move
    // is to send nothing, not to message everyone and hope.
    let optedOutRemoved = 0;
    {
      const blocked = await optedOutPhoneSet(supabase);
      if (blocked.size) {
        const before = recipients.length;
        recipients = recipients.filter(r => !blocked.has(phoneKey(r.phone)));
        optedOutRemoved = before - recipients.length;
        console.log(`[broadcast] ${optedOutRemoved} opted-out recipient(s) removed; ${recipients.length} remain`);
      }
    }
    if (!recipients.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        success: true, sent: 0, opted_out_removed: optedOutRemoved,
        consent_removed: consentRemoved,
        message: 'Every matching recipient has opted out — nothing was sent.',
      }) };
    }

    // Automated campaigns are cooled down across campaign keys so the same
    // reader cannot be repeatedly contacted by every scheduled run. Missing
    // migration is fail-closed for automation, but does not break manual sends.
    let cooldownRemoved = 0;
    if (source === 'scheduled') {
      const cutoff = new Date(Date.now() - cooldownDays * 86400000).toISOString();
      const { data: recent, error: recentError } = await supabase
        .from('whatsapp_campaign_deliveries')
        .select('customer_phone')
        .eq('status', 'sent')
        .gte('created_at', cutoff)
        .limit(20000);
      if (recentError) throw new Error('Campaign log unavailable; run sql/whatsapp_campaign_deliveries.sql before enabling automation. ' + recentError.message);
      const recentlySent = new Set((recent || []).map(row => phoneKey(row.customer_phone)));
      const before = recipients.length;
      recipients = recipients.filter(r => !recentlySent.has(phoneKey(r.phone)));
      cooldownRemoved = before - recipients.length;
    }

    // ── Cap on sending without recorded consent ────────────────────────────
    // "Send to 100 first" has to mean 100 ever, not 100 per run. The cooldown
    // above removes anyone already contacted, so an uncapped pilot would simply
    // pick up the NEXT 100 on the following run and work through the entire
    // 9,700-customer list within a couple of months -- the exact outcome the
    // pilot exists to avoid. Counting from the ledger makes the cap survive
    // redeploys, restarts and any number of repeated cron fires.
    let pilotSentAlready = 0;
    let effectiveLimit = limit;
    if (!requireOptIn && !testPhone) {
      const { count, error: pilotError } = await supabase
        .from('whatsapp_campaign_deliveries')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'sent')
        .contains('metadata', { pilot: true });
      // Fail closed: if we cannot prove how many un-consented messages have
      // already gone out, the safe move is to send none.
      if (pilotError) throw new Error('Cannot count pilot sends; refusing to send without recorded consent. ' + pilotError.message);
      pilotSentAlready = count || 0;
      const remaining = Math.max(0, PILOT_CAP - pilotSentAlready);
      if (remaining === 0) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({
          success: true, sent: 0, pilot_cap: PILOT_CAP, pilot_sent_already: pilotSentAlready,
          message: `Pilot cap reached: ${pilotSentAlready} message(s) have already gone to customers who never opted in. `
            + 'Raise WHATSAPP_BROADCAST_PILOT_CAP deliberately, or grow whatsapp_marketing_subscribers, before sending more.',
        }) };
      }
      effectiveLimit = Math.min(limit, remaining);
    }

    recipients = recipients.slice(0, effectiveLimit);

    if (!recipients.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        success: true, sent: 0, opted_out_removed: optedOutRemoved, consent_removed: consentRemoved, cooldown_removed: cooldownRemoved,
        message: 'No eligible recipients remain after opt-out and cooldown checks.',
      }) };
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
        opted_out_removed: optedOutRemoved,
        consent_removed: consentRemoved,
        cooldown_removed: cooldownRemoved,
        personalized,
        rich_media: richMedia,
        offer: campaignOffer,
        total: recipients.length,
        segment_counts: personalized ? segmentCounts : undefined,
        sample: recipients.slice(0, 10).map(r => ({
          phone: r.phone.slice(0,4) + '****' + r.phone.slice(-3),
          name: r.name,
          bucket: r.bucketLabel,
          recs_preview: r.params?.[2]?.split('\n').slice(0,3),
          image: r.headerImageUrl,
          product_url: r.hero ? absoluteProductUrl(r.hero) : null,
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
          const result = await sendWhatsApp({
            to: r.phone,
            template,
            params: r.params,
            lang,
            headerImageUrl: r.headerImageUrl,
            urlButtonParam: r.urlButtonParam,
            marketing: true,
          });
          return { phone: r.phone, ok: !!result?.ok, error: result?.data?.error?.message || result?.error || (result?.skipped ? 'send skipped' : 'WhatsApp API rejected message') };
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

      if (campaignKey) {
        const rows = results.map((res, index) => {
          const recipient = batch[index];
          const value = res.status === 'fulfilled' ? res.value : { ok:false, error:res.reason?.message };
          return {
            campaign_key: campaignKey,
            customer_phone: recipient.phone,
            template_name: template,
            status: value.ok ? 'sent' : 'failed',
            error: value.ok ? null : String(value.error || 'Unknown send failure').slice(0, 1000),
            product_url: recipient.hero ? absoluteProductUrl(recipient.hero) : null,
            metadata: { bucket:recipient.bucketLabel, offer:campaignOffer, source, pilot: !requireOptIn },
          };
        });
        const { error: logError } = await supabase.from('whatsapp_campaign_deliveries').upsert(rows, { onConflict:'campaign_key,customer_phone' });
        if (logError && source === 'scheduled') throw new Error('Unable to record campaign deliveries: ' + logError.message);
        if (logError) console.warn('[broadcast] campaign log skipped:', logError.message);
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
        rich_media: richMedia,
        offer: campaignOffer,
        opted_out_removed: optedOutRemoved,
        consent_removed: consentRemoved,
        cooldown_removed: cooldownRemoved,
        unlinkable_removed: unlinkableRemoved,
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

exports._internal = {
  absoluteProductUrl, absoluteImageUrl, productSlug, heroRec, markdownPercent,
  formatBookLine, promotionLabel, canonicalCategory, guessLanguage,
  buildCustomerProfile, pickRecs,
};
