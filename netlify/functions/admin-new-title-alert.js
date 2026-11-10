/**
 * Netlify Function: admin-new-title-alert   (admin)
 *
 * Tell past buyers about one new book on WhatsApp (utils/new-title-alert).
 *
 *   POST { slug, dry_run: true,  match?, days_back?, cooldown_days?, limit? }
 *        → who would get it, what it says, what it costs. Sends nothing.
 *   POST { slug, dry_run: false, …same, expect }   → sends. `expect` must equal
 *        the dry run's `will_send`, so the count the admin confirmed is the
 *        count that goes out (a re-run with new orders refuses instead).
 *   POST { slug, test_phone }  → sends to that one number only, no ledger.
 *   POST { slug, test_email }  → emails that one address only, no ledger.
 *
 * Who (match):
 *   'author' / 'author_or_category'  past buyers of the same author / shelf
 *   'bought'   past buyers of the books named in bought_slugs (1-20 slugs or
 *              /product/ links): "send this title to people who ordered X".
 * Channels: whatsapp (default on) and email (off unless email:true). Email
 * has its own ledger (new-title-email:<slug>, never twice per book), skips
 * unsubscribed addresses (utils/email-unsub; every email carries a signed
 * unsubscribe link) and anyone emailed in the cooldown window. `expect_email`
 * must equal the dry run's will_email, as `expect` does for WhatsApp.
 *
 * Template: WHATSAPP_NEW_TITLE_TEMPLATE (default new_title_alert_v1), a Meta
 * MARKETING template with an IMAGE header, four body variables and a URL
 * button whose base is https://inkandchai.in/product/{{1}}. For a template
 * without the image header set WHATSAPP_NEW_TITLE_IMAGE=off.
 *
 * The header is the book's cover, but WhatsApp takes only JPEG/PNG (≤ 5 MB)
 * and some covers are webp or gone from Shopify, so each candidate is fetched
 * and checked; webp catalogue covers use the JPEG copy in /images/wa/. Covers
 * uploaded in admin are webp, so the admin page converts one in the browser
 * and posts it back ({ slug, cover_jpeg }) to R2 at covers/wa/<slug>-<hash of
 * the source>.jpg — a new cover gets a new copy. Failing all that, the shop's
 * card /images/og-default.jpg.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { sendWhatsApp, normalizePhone } = require('./utils/whatsapp');
const { optedOutPhoneSet, phoneKey } = require('./utils/bot-optout');
const { resolveCartPrices, makeSlug } = require('./utils/pricing');
const { catalogueBook } = require('./utils/catalog-content');
const { releasesFor } = require('./utils/release-date');
const crypto = require('crypto');
const { r2PutObject, r2Config, r2Configured } = require('./utils/r2-put');
const A = require('./utils/new-title-alert');
const { summarize } = require('./utils/campaign-receipts');
const { sendEmail } = require('./utils/email');
const EU = require('./utils/email-unsub');
const CATALOGUE = require('../../data/ALL_BOOKS.json');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const STATUSES = ['paid', 'delivered', 'shipped', 'out_for_delivery', 'cod_pending', 'partial_cod_pending', 'confirmed'];
const MAX_SEND = 1000;
const MAX_SEND_BOTH = 400;   // WhatsApp + email: two requests a customer, under the Worker's subrequest cap
const EMAIL_BATCH = 10;
const BATCH = 20;
const COST_PER_MSG = 0.91;   // ₹, Meta marketing conversation (India), as the broadcast modal quotes

const SITE = 'https://inkandchai.in';
const FALLBACK_COVER = SITE + '/images/og-default.jpg';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (p) => String(p).slice(0, 4) + '****' + String(p).slice(-3);

// Supabase answers 1000 rows at most; a list cut short would re-message people.
async function allRows(query) {
  const rows = [];
  for (let from = 0; from < 100000; from += 1000) {
    const { data, error } = await query().range(from, from + 999);
    if (error) return { rows, error: error.message };
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return { rows, error: '' };
}
async function phoneKeys(query, keep = () => true) {
  const { rows, error } = await allRows(query);
  return { keys: new Set(rows.filter(keep).map((r) => phoneKey(r.customer_phone))), error };
}

// Author/category for a past cart line: catalogue by slug, then by title.
let _bySlug = null, _byTitle = null;
function catalogueMeta(item, custom) {
  if (!_bySlug) {
    _bySlug = new Map(); _byTitle = new Map();
    for (const b of CATALOGUE) {
      if (!b || !b.title) continue;
      const meta = { author: b.author, category: b.category };
      _bySlug.set(makeSlug(b.title, b.shopify_id).toLowerCase(), meta);
      _byTitle.set(String(b.title).trim().toLowerCase(), meta);
    }
  }
  const slug = String(item.url || item.id || '').match(/\/product\/([^/?#]+)/i)?.[1]?.toLowerCase() || String(item.slug || '').toLowerCase();
  const base = custom.get(slug) || _bySlug.get(slug) || _byTitle.get(String(item.title || '').trim().toLowerCase()) || null;
  const edited = custom.get('override:' + slug);   // author typed in admin for a catalogue book
  return edited && edited.author ? { ...(base || {}), author: edited.author } : base;
}

// Absolute URL; Supabase storage covers become their same-site /spimg/ path,
// as product-page shows them, so the admin page can read them into a canvas.
const absolute = (u) => {
  const s = String(u || '').trim();
  if (!s || s.startsWith('data:')) return '';
  if (/^https?:\/\//i.test(s)) {
    try {
      const supa = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).host : '';
      const url = new URL(s);
      if (supa && url.host === supa && url.pathname.startsWith('/storage/v1/object/public/')) {
        return `${SITE}/spimg/${url.pathname.slice('/storage/v1/object/public/'.length)}`;
      }
    } catch { /* not a URL: use as is */ }
    return s.replace(/^http:/i, 'https:');
  }
  return SITE + (s.startsWith('/') ? s : '/' + s);
};

// A real JPEG/PNG that WhatsApp can fetch, judged by its first bytes.
async function isSendableImage(url) {
  try {
    const res = await fetch(url, { headers: { Accept: 'image/jpeg,image/png' }, redirect: 'follow' });
    if (!res.ok) return false;
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_IMAGE_BYTES) return false;
    const head = new Uint8Array((await res.arrayBuffer()).slice(0, 8));
    const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    return jpeg || png;
  } catch { return false; }
}

// Where the browser-made JPEG copy of a cover lives in R2.
function jpegCopyKey(slug, sourceUrl) {
  const h = crypto.createHash('sha1').update(String(sourceUrl)).digest('hex').slice(0, 10);
  return `covers/wa/${slug}-${h}.jpg`;
}

// WhatsApp shows a template image as a 1.91:1 banner and crops a tall cover
// to its middle strip. Fit the whole cover into a banner instead, the way
// order_confirmed_image does (utils/order-cover whatsappCoverUrl): wsrv.nl
// also turns webp into JPEG. Only the public cover URL goes to wsrv.
const bannerUrl = (src) => `https://wsrv.nl/?url=${encodeURIComponent(src)}&w=800&h=418&fit=contain&cbg=1a1613&output=jpg&q=80`;
const emailCoverUrl = (src) => `https://wsrv.nl/?url=${encodeURIComponent(src)}&w=440&output=jpg&q=82`;

async function coverFor(images, slug) {
  const first = absolute(images.find((u) => absolute(u)));
  if (first && !/^off$/i.test(String(process.env.WHATSAPP_NEW_TITLE_BANNER || '').trim())) {
    const banner = bannerUrl(first);
    if (await isSendableImage(banner)) return { url: banner, email_url: emailCoverUrl(first), banner: true, fallback: false };
  }
  const r2 = r2Configured() ? r2Config() : null;
  if (first && r2 && r2.publicBase) {
    const copy = `${r2.publicBase}/${jpegCopyKey(slug, first)}`;
    if (await isSendableImage(copy)) return { url: copy, fallback: false };
  }
  for (const raw of images) {
    const url = absolute(raw);
    if (!url) continue;
    const local = url.match(/^https:\/\/inkandchai\.in\/images\/([^/?#]+)\.webp(?:[?#].*)?$/i);
    const tries = local ? [`${SITE}/images/wa/${local[1]}.jpg`] : [url];
    for (const t of tries) if (await isSendableImage(t)) return { url: t, fallback: false };
  }
  // The admin page can make a JPEG of a cover on our own site and post it back.
  const convertible = first && r2 && /^https:\/\/inkandchai\.in\//i.test(first) ? first : null;
  return { url: FALLBACK_COVER, fallback: true, convert_from: convertible };
}

async function saveJpegCopy(slug, images, base64) {
  if (!r2Configured()) throw new Error('R2 is not configured');
  const first = absolute(images.find((u) => absolute(u)));
  if (!first) throw new Error('This book has no cover');
  const bytes = Buffer.from(String(base64).replace(/^data:image\/jpeg;base64,/, ''), 'base64');
  if (bytes.length < 1000 || bytes.length > 3 * 1024 * 1024) throw new Error('The converted cover is the wrong size');
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) throw new Error('The converted cover is not a JPEG');
  return r2PutObject(r2Config(), { key: jpegCopyKey(slug, first), body: bytes, contentType: 'image/jpeg' });
}

async function loadBook(db, slug) {
  const { data: rows } = await db.from('custom_products')
    .select('slug,title,author,category,original_price_inr,is_active,image_url').ilike('slug', slug).limit(1);
  const custom = rows && rows[0];
  const cat = custom ? null : catalogueBook(slug);
  if (!custom && !cat) return null;
  if (custom && custom.is_active === false) return null;
  const src = custom || cat;
  const priced = await resolveCartPrices([{ id: `/product/${slug}/`, url: `/product/${slug}/`, qty: 1 }], db);
  const line = priced.cart[0];
  const release = (await releasesFor(db, [slug]))[slug.toLowerCase()] || '';
  let override = null;
  if (!custom) {
    const { data } = await db.from('product_overrides').select('image_url').eq('slug', slug).limit(1);
    override = data && data[0];
  }
  return {
    images: [custom && custom.image_url, override && override.image_url, src.image_url].filter(Boolean),
    slug: custom ? custom.slug : slug,
    title: (line && line.title) || src.title,
    author: src.author || '',
    category: src.category || '',
    price: line ? line.price : Number(src.price_inr) || 0,
    mrp: Number(src.original_price_inr) || 0,
    release,
    sold_out: !!(line && line._sold_out),
  };
}

async function pastCustomers(db, daysBack) {
  const since = new Date(Date.now() - daysBack * 86400000).toISOString();
  const customers = new Map();
  for (let from = 0; from < 40000; from += 1000) {
    const { data, error } = await db.from('orders')
      .select('customer_phone,customer_name,customer_email,cart_items,created_at')
      .in('status', STATUSES).gte('created_at', since)
      .order('created_at', { ascending: false }).range(from, from + 999);
    if (error) throw new Error('orders: ' + error.message);
    for (const r of data || []) {
      const phone = normalizePhone(r.customer_phone);
      if (!phone) continue;
      if (!customers.has(phone)) customers.set(phone, { name: r.customer_name || '', email: '', orders: [] });
      const c = customers.get(phone);
      // Newest order first: its address is the one they use now.
      if (!c.email && EU.isEmail(r.customer_email)) c.email = EU.normEmail(r.customer_email);
      c.orders.push(r);
    }
    if (!data || data.length < 1000) break;
  }
  return customers;
}

// Author/category for admin-added books seen in past orders, and authors the
// admin filled in for catalogue books (product_overrides, key 'override:<slug>').
async function customMeta(db, customers) {
  const slugs = new Set();
  for (const { orders } of customers.values()) for (const o of orders) for (const i of A.cartItemsOf(o)) {
    const s = String((i && (i.url || i.id)) || '').match(/\/product\/([^/?#]+)/i)?.[1];
    if (s && !(i && i.author)) slugs.add(s.toLowerCase());
  }
  const out = new Map();
  const list = [...slugs];
  for (let k = 0; k < list.length; k += 150) {
    const { data } = await db.from('custom_products').select('slug,author,category')
      .or(list.slice(k, k + 150).map((s) => `slug.ilike.${s}`).join(','));
    for (const r of data || []) out.set(String(r.slug).toLowerCase(), { author: r.author, category: r.category });
    const { data: ov } = await db.from('product_overrides').select('slug,author')
      .or(list.slice(k, k + 150).map((s) => `slug.ilike.${s}`).join(','));
    for (const r of ov || []) if (r.author) out.set('override:' + String(r.slug).toLowerCase(), { author: r.author });
  }
  return out;
}

const slugOf = (v) => String(v || '').trim().toLowerCase()
  .replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '').replace(/^\/?product\//, '').replace(/\/+$/, '');

/** The books picked under "ordered these books": slug + title, live or not. */
async function targetsFor(db, raw) {
  const slugs = [...new Set((Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/)).map(slugOf).filter((x) => /^[a-z0-9][a-z0-9-]*$/.test(x)))].slice(0, 20);
  const out = [];
  const missing = [];
  for (const slug of slugs) {
    const { data } = await db.from('custom_products').select('slug,title,author').ilike('slug', slug).limit(1);
    const row = (data && data[0]) || catalogueBook(slug);
    if (row && row.title) out.push({ slug: String(row.slug || slug).toLowerCase(), title: row.title, author: row.author || '' });
    else missing.push(slug);
  }
  return { targets: out, missing };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const slug = String(body.slug || '').trim().toLowerCase().replace(/^\/?product\//, '').replace(/\/+$/, '');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return json(400, { error: 'Pick a product first' });
  const match = ['author_or_category', 'bought'].includes(body.match) ? body.match : 'author';
  const viaWhatsApp = body.whatsapp !== false;
  const viaEmail = body.email === true;
  const daysBack = Math.max(30, Math.min(730, parseInt(body.days_back, 10) || 365));
  const cooldownDays = Math.max(0, Math.min(60, body.cooldown_days === 0 ? 0 : parseInt(body.cooldown_days, 10) || 7));
  const limit = Math.max(1, Math.min(viaWhatsApp && viaEmail ? MAX_SEND_BOTH : MAX_SEND, parseInt(body.limit, 10) || 300));
  const keywords = A.keywordsOf(body.keywords);
  const template = String(process.env.WHATSAPP_NEW_TITLE_TEMPLATE || 'new_title_alert_v1').trim();
  const lang = String(process.env.WHATSAPP_NEW_TITLE_LANG || 'en').trim();
  const withImage = !/^(off|0|false|no)$/i.test(String(process.env.WHATSAPP_NEW_TITLE_IMAGE || '').trim());
  const campaignKey = A.CAMPAIGN_PREFIX + slug;
  const emailKey = A.EMAIL_PREFIX + slug;

  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    // What Meta did with this book's alerts (receipts from whatsapp-bot).
    if (body.report) {
      const { rows, error } = await allRows(() => db.from('whatsapp_campaign_deliveries')
        .select('status,metadata,created_at').eq('campaign_key', campaignKey).order('id'));
      if (error) return json(500, { error: 'Delivery ledger unreadable: ' + error });
      const last = rows.reduce((m, r) => (r.created_at > m ? r.created_at : m), '');
      const em = await allRows(() => db.from('whatsapp_campaign_deliveries').select('status,created_at').eq('campaign_key', emailKey).order('id'));
      const email = { sent: em.rows.filter((r) => r.status === 'sent').length, failed: em.rows.filter((r) => r.status !== 'sent').length,
        last_sent_at: em.rows.reduce((m, r) => (r.created_at > m ? r.created_at : m), '') || null };
      return json(200, { report: summarize(rows), last_sent_at: last || null, email });
    }
    const book = await loadBook(db, slug);
    if (!book) return json(404, { error: 'No live product with that slug' });
    if (book.sold_out) return json(400, { error: 'This book is marked sold out — restock it before announcing it.' });
    if (!viaWhatsApp && !viaEmail && !body.test_phone && !body.test_email) return json(400, { error: 'Pick WhatsApp, email or both.' });
    let targets = [];
    if (match === 'bought') {
      const t = await targetsFor(db, body.bought_slugs);
      if (t.missing.length) return json(400, { error: `Not found: ${t.missing.join(', ')}. Paste the book's link or slug.` });
      if (!t.targets.length) return json(400, { error: 'Add the book(s) the customers ordered.' });
      if (t.targets.some((x) => x.slug === slug)) return json(400, { error: 'Pick other books: people who bought this book already have it.' });
      targets = t.targets;
    }
    if (!A.authorsOf(book.author).length && !keywords.length && match === 'author') {
      return json(400, { error: `This book has no usable author ("${book.author || 'blank'}"). Fill in the author, add series names, or match by author or category.` });
    }
    if (body.cover_jpeg) {
      const url = await saveJpegCopy(book.slug, book.images, body.cover_jpeg);
      return json(200, { cover_saved: true, url });
    }
    const cover = withImage || viaEmail || body.test_email ? await coverFor(book.images, book.slug) : null;
    const headerImageUrl = withImage && cover ? cover.url : null;
    const productUrl = `${SITE}/product/${book.slug}/`;
    const emailOf = (r) => ({
      to: r.email,
      subject: `Exclusive: ${A.bareTitle(book.title, book.author).slice(0, 90)} is now available`,
      html: A.emailHtml(r, book, {
        coverUrl: cover ? cover.email_url || cover.url : '',
        productUrl: `${productUrl}?utm_source=email&utm_medium=new_title&utm_campaign=${encodeURIComponent(book.slug)}`,
        unsubscribeUrl: EU.unsubscribeUrl(r.email),
      }),
    });

    // One address, for checking the email before the real send.
    if (body.test_email) {
      if (!EU.isEmail(body.test_email)) return json(400, { error: 'Test email is not a valid address' });
      const firstTarget = targets[0];
      const r = { name: 'there', email: EU.normEmail(body.test_email), reason: firstTarget ? A.bareTitle(firstTarget.title, firstTarget.author) : (book.author || 'books like this') };
      const sent = await sendEmail(emailOf(r)).catch((e) => ({ ok: false, error: e.message }));
      const ok = !!(sent && sent.ok !== false);
      return json(ok ? 200 : 502, { test: true, ok, email: r.email, cover, error: ok ? undefined : (sent && sent.error) || 'email failed' });
    }

    // One number, for checking the message on a phone before the real send.
    if (body.test_phone) {
      const phone = normalizePhone(body.test_phone);
      if (!phone) return json(400, { error: 'Test phone is not a valid Indian mobile' });
      // Make the JPEG copy first rather than test with the shop card.
      if (cover && cover.fallback && cover.convert_from && !body.allow_fallback) {
        return json(409, { need_cover: true, cover, error: 'The cover needs a JPEG copy first.' });
      }
      const params = A.templateParams({ name: 'there', reason: targets[0] ? A.bareTitle(targets[0].title, targets[0].author) : A.authorsOf(book.author).length ? book.author : (A.shelfOf(book.category) || 'books like this') }, book);
      const res = await sendWhatsApp({ to: phone, template, params, lang, headerImageUrl, urlButtonParam: book.slug, marketing: true });
      return json(res && res.ok ? 200 : 502, { test: true, ok: !!(res && res.ok), params, cover, error: res && !res.ok ? (res.data?.error?.message || res.error || 'send failed') : undefined });
    }

    const customers = await pastCustomers(db, daysBack);
    let matchResult;
    if (match === 'bought') matchResult = A.matchBuyersOf(customers, book, targets);
    else {
      const custom = await customMeta(db, customers);
      matchResult = A.matchCustomers(customers, book, (item) => catalogueMeta(item, custom), { match, keywords });
    }
    const { recipients: matched, counts } = matchResult;

    // Opt-outs. Either list unreadable → no send (a dry run still reports).
    // A WhatsApp opt-out also stops these emails: they asked for no marketing.
    let optedOut = new Set(), listError = '';
    try { optedOut = await optedOutPhoneSet(db); } catch (e) { listError = e.message; }
    const unsub = await phoneKeys(() => db.from('whatsapp_marketing_subscribers').select('customer_phone').eq('status', 'unsubscribed').order('customer_phone'));
    if (unsub.error) listError = listError || unsub.error;
    const unsubscribed = unsub.keys;
    // The ledger: who already had this book, and who had any marketing lately.
    // Meta accepted it (even if it later dropped it, e.g. its 131049 marketing
    // limit): do not try that customer again for this book.
    const prior = await phoneKeys(() => db.from('whatsapp_campaign_deliveries').select('customer_phone,status,metadata').eq('campaign_key', campaignKey).order('id'),
      (r) => r.status === 'sent' || !!(r.metadata && r.metadata.meta_failed));
    const already = prior.keys;
    let ledgerError = prior.error;
    let recent = new Set();
    const since = new Date(Date.now() - cooldownDays * 86400000).toISOString();
    if (cooldownDays && !ledgerError) {
      // WhatsApp cooldown counts WhatsApp sends only; emails have their own.
      const r = await phoneKeys(() => db.from('whatsapp_campaign_deliveries').select('customer_phone').eq('status', 'sent')
        .not('campaign_key', 'like', A.EMAIL_PREFIX + '%').gte('created_at', since).order('id'));
      recent = r.keys; ledgerError = r.error;
    }

    const removed = { opted_out: 0, already_sent_this_book: 0, cooldown: 0 };
    const eligible = [];
    for (const r of matched) {
      const key = phoneKey(r.phone);
      if (optedOut.has(key) || unsubscribed.has(key)) { removed.opted_out++; continue; }
      if (already.has(key)) { removed.already_sent_this_book++; continue; }
      if (recent.has(key)) { removed.cooldown++; continue; }
      eligible.push(r);
    }
    const toSend = viaWhatsApp ? eligible.slice(0, limit) : [];

    // Email: valid address, not unsubscribed, never twice for this book,
    // nothing else emailed inside the cooldown. Any list unreadable → no email.
    let emailError = '';
    const emailRemoved = { no_email: 0, opted_out: 0, unsubscribed: 0, already_emailed_this_book: 0, cooldown: 0 };
    const emailEligible = [];
    if (viaEmail) {
      let unsubEmails = new Set();
      try { unsubEmails = await EU.unsubscribedHashes(); } catch (e) { emailError = `Email unsubscribe list unreadable (${e.message})`; }
      const emailed = await phoneKeys(() => db.from('whatsapp_campaign_deliveries').select('customer_phone,status').eq('campaign_key', emailKey).order('id'), (r) => r.status === 'sent');
      let recentEmail = new Set();
      if (cooldownDays && !emailed.error) {
        const r = await phoneKeys(() => db.from('whatsapp_campaign_deliveries').select('customer_phone').eq('status', 'sent')
          .like('campaign_key', A.EMAIL_PREFIX + '%').gte('created_at', since).order('id'));
        recentEmail = r.keys;
        if (r.error) emailError = emailError || `Email ledger unreadable (${r.error})`;
      }
      if (emailed.error) emailError = emailError || `Email ledger unreadable (${emailed.error})`;
      if (!EU.unsubscribeUrl('check@example.com')) emailError = emailError || 'No unsubscribe secret configured, so no unsubscribe link';
      const seen = new Set();
      for (const r of matched) {
        const key = phoneKey(r.phone);
        const addr = EU.normEmail(r.email);
        if (!EU.isEmail(addr) || seen.has(addr)) { emailRemoved.no_email++; continue; }
        if (optedOut.has(key) || unsubscribed.has(key)) { emailRemoved.opted_out++; continue; }
        if (unsubEmails.has(EU.hashEmail(addr))) { emailRemoved.unsubscribed++; continue; }
        if (emailed.keys.has(key)) { emailRemoved.already_emailed_this_book++; continue; }
        if (recentEmail.has(key)) { emailRemoved.cooldown++; continue; }
        seen.add(addr);
        emailEligible.push({ ...r, email: addr });
      }
    }
    const toEmail = emailEligible.slice(0, limit);

    const preview = A.templateParams(toSend[0] || toEmail[0] || { name: 'Riya', reason: targets[0] ? A.bareTitle(targets[0].title, targets[0].author) : book.author }, book);
    const previewRecipient = toEmail[0] || toSend[0] || { name: 'Riya', reason: preview[1] };
    const summary = {
      book: { slug: book.slug, title: book.title, author: book.author, category: book.category, price: book.price, release: book.release || null },
      template, cover, match, keywords, days_back: daysBack, cooldown_days: cooldownDays,
      bought: targets.map((t) => ({ slug: t.slug, title: t.title })),
      channels: { whatsapp: viaWhatsApp, email: viaEmail },
      counts: { ...counts, ...removed, eligible: eligible.length },
      will_send: toSend.length, limit,
      est_cost_inr: Math.round(toSend.length * COST_PER_MSG),
      preview_params: preview,
      sample: (viaWhatsApp ? toSend : toEmail).slice(0, 8).map((r) => ({ phone: mask(r.phone), name: r.name, reason: r.reason, via: r.via })),
      email: viaEmail ? {
        counts: { ...emailRemoved, eligible: emailEligible.length },
        will_email: toEmail.length,
        subject: emailOf({ ...previewRecipient, email: 'preview@example.com' }).subject,
        preview_html: A.emailHtml({ ...previewRecipient, name: previewRecipient.name || 'there' }, book, { coverUrl: cover ? cover.email_url || cover.url : '', productUrl, unsubscribeUrl: '#' }),
        blocked_reason: emailError,
      } : null,
      blocked_reason: listError ? `Opt-out list unreadable (${listError})` : ledgerError ? `Delivery ledger unreadable — run sql/whatsapp_campaign_deliveries.sql (${ledgerError})` : '',
    };

    if (body.dry_run !== false) return json(200, { dry_run: true, ...summary });
    if (summary.blocked_reason) return json(409, { error: summary.blocked_reason + '. Nothing was sent.', ...summary });
    if (viaEmail && emailError) return json(409, { error: emailError + '. Nothing was sent.', ...summary });
    if (viaWhatsApp && Number(body.expect) !== toSend.length) {
      return json(409, { error: `The WhatsApp count changed since your dry run (${body.expect} → ${toSend.length}). Run the dry run again.`, ...summary });
    }
    if (viaEmail && Number(body.expect_email) !== toEmail.length) {
      return json(409, { error: `The email count changed since your dry run (${body.expect_email} → ${toEmail.length}). Run the dry run again.`, ...summary });
    }

    let sent = 0, failed = 0;
    const failures = [];
    let waStop = '';
    for (let i = 0; i < toSend.length; i += BATCH) {
      const batch = toSend.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async (r) => {
        try {
          const res = await sendWhatsApp({ to: r.phone, template, params: A.templateParams(r, book), lang, headerImageUrl, urlButtonParam: book.slug, marketing: true });
          return { r, ok: !!(res && res.ok), wamid: res?.data?.messages?.[0]?.id || null, error: res && !res.ok ? (res.data?.error?.message || res.error || 'send failed') : '' };
        } catch (e) { return { r, ok: false, error: e.message }; }
      }));
      const rows = results.map(({ r, ok, wamid, error }) => {
        if (ok) sent++; else { failed++; if (failures.length < 10) failures.push({ phone: mask(r.phone), error }); }
        return {
          campaign_key: campaignKey, customer_phone: r.phone, template_name: template,
          status: ok ? 'sent' : 'failed', error: ok ? null : String(error).slice(0, 1000),
          product_url: `https://inkandchai.in/product/${book.slug}/`,
          metadata: { source: 'new_title', reason: r.reason, via: r.via, match, ...(wamid ? { wamid } : {}) },
        };
      });
      const { error: logError } = await db.from('whatsapp_campaign_deliveries').upsert(rows, { onConflict: 'campaign_key,customer_phone' });
      // Without the ledger the next press would message the same people again.
      if (logError) return json(500, { error: 'Sent ' + sent + ' on WhatsApp, then could not record deliveries (' + logError.message + '). Stopped; no emails sent.', sent, failed });
      // A template problem fails every message the same way: stop WhatsApp after one batch.
      if (i === 0 && !sent && failed) { waStop = 'The first WhatsApp batch all failed — check the template is approved.'; break; }
      if (i + BATCH < toSend.length) await sleep(250);
    }

    let emailed = 0, emailFailed = 0;
    const emailFailures = [];
    for (let i = 0; i < toEmail.length; i += EMAIL_BATCH) {
      const batch = toEmail.slice(i, i + EMAIL_BATCH);
      const results = await Promise.all(batch.map(async (r) => {
        try {
          const res = await sendEmail(emailOf(r));
          return { r, ok: !!(res && res.ok), provider: res && res.provider, error: res && !res.ok ? (res.error || 'email failed') : '' };
        } catch (e) { return { r, ok: false, error: e.message }; }
      }));
      const rows = results.map(({ r, ok, provider, error }) => {
        if (ok) emailed++; else { emailFailed++; if (emailFailures.length < 10) emailFailures.push({ phone: mask(r.phone), error }); }
        return {
          campaign_key: emailKey, customer_phone: r.phone, template_name: 'email:new_title',
          status: ok ? 'sent' : 'failed', error: ok ? null : String(error).slice(0, 1000),
          product_url: productUrl,
          metadata: { source: 'new_title_email', channel: 'email', email_hash: EU.hashEmail(r.email), reason: r.reason, via: r.via, match, ...(provider ? { provider } : {}) },
        };
      });
      const { error: logError } = await db.from('whatsapp_campaign_deliveries').upsert(rows, { onConflict: 'campaign_key,customer_phone' });
      if (logError) return json(500, { error: `WhatsApp ${sent} sent. Emailed ${emailed}, then could not record emails (${logError.message}). Stopped.`, sent, failed, emailed, email_failed: emailFailed });
      if (i === 0 && !emailed && emailFailed) break;   // provider down: don't burn through the list
      if (i + EMAIL_BATCH < toEmail.length) await sleep(400);
    }
    console.log(`[new-title-alert] ${book.slug}: whatsapp ${sent}/${failed}, email ${emailed}/${emailFailed}`);
    const allFailed = (waStop || !toSend.length) && !emailed && (failed || emailFailed);
    return json(allFailed ? 502 : 200, {
      error: allFailed ? (waStop || 'Every email failed — check the email provider.') : undefined,
      sent, failed, sample_failures: failures, whatsapp_stopped: waStop || undefined,
      emailed, email_failed: emailFailed, email_failures: emailFailures,
      remaining: eligible.length - toSend.length, ...summary,
    });
  } catch (e) {
    console.error('[new-title-alert]', e);
    return json(500, { error: e.message });
  }
};
