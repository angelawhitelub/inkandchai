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
 *
 * Template: WHATSAPP_NEW_TITLE_TEMPLATE (default new_title_alert_v1), a Meta
 * MARKETING template with an IMAGE header, four body variables and a URL
 * button whose base is https://inkandchai.in/product/{{1}}. For a template
 * without the image header set WHATSAPP_NEW_TITLE_IMAGE=off.
 *
 * The header is the book's cover, but WhatsApp takes only JPEG/PNG (≤ 5 MB)
 * and some covers are webp or gone from Shopify, so each candidate is fetched
 * and checked; webp catalogue covers use the JPEG copy in /images/wa/; failing
 * all that, the shop's card /images/og-default.jpg.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { sendWhatsApp, normalizePhone } = require('./utils/whatsapp');
const { optedOutPhoneSet, phoneKey } = require('./utils/bot-optout');
const { resolveCartPrices, makeSlug } = require('./utils/pricing');
const { catalogueBook } = require('./utils/catalog-content');
const { releasesFor } = require('./utils/release-date');
const A = require('./utils/new-title-alert');
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
const BATCH = 20;
const COST_PER_MSG = 0.91;   // ₹, Meta marketing conversation (India), as the broadcast modal quotes

const SITE = 'https://inkandchai.in';
const FALLBACK_COVER = SITE + '/images/og-default.jpg';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (p) => String(p).slice(0, 4) + '****' + String(p).slice(-3);

// Supabase answers 1000 rows at most; a list cut short would re-message people.
async function phoneKeys(query) {
  const out = new Set();
  for (let from = 0; from < 100000; from += 1000) {
    const { data, error } = await query().range(from, from + 999);
    if (error) return { keys: out, error: error.message };
    for (const r of data || []) out.add(phoneKey(r.customer_phone));
    if (!data || data.length < 1000) break;
  }
  return { keys: out, error: '' };
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
  return custom.get(slug) || _bySlug.get(slug) || _byTitle.get(String(item.title || '').trim().toLowerCase()) || null;
}

const absolute = (u) => {
  const s = String(u || '').trim();
  if (!s || s.startsWith('data:')) return '';
  if (/^https?:\/\//i.test(s)) return s.replace(/^http:/i, 'https:');
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

async function coverFor(images) {
  for (const raw of images) {
    const url = absolute(raw);
    if (!url) continue;
    const local = url.match(/^https:\/\/inkandchai\.in\/images\/([^/?#]+)\.webp(?:[?#].*)?$/i);
    const tries = local ? [`${SITE}/images/wa/${local[1]}.jpg`] : [url];
    for (const t of tries) if (await isSendableImage(t)) return { url: t, fallback: false };
  }
  return { url: FALLBACK_COVER, fallback: true };
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
      .select('customer_phone,customer_name,cart_items,created_at')
      .in('status', STATUSES).gte('created_at', since)
      .order('created_at', { ascending: false }).range(from, from + 999);
    if (error) throw new Error('orders: ' + error.message);
    for (const r of data || []) {
      const phone = normalizePhone(r.customer_phone);
      if (!phone) continue;
      if (!customers.has(phone)) customers.set(phone, { name: r.customer_name || '', orders: [] });
      customers.get(phone).orders.push(r);
    }
    if (!data || data.length < 1000) break;
  }
  return customers;
}

// Author/category for admin-added books seen in past orders.
async function customMeta(db, customers) {
  const slugs = new Set();
  for (const { orders } of customers.values()) for (const o of orders) for (const i of o.cart_items || []) {
    const s = String((i && (i.url || i.id)) || '').match(/\/product\/([^/?#]+)/i)?.[1];
    if (s && !(i && i.author)) slugs.add(s.toLowerCase());
  }
  const out = new Map();
  const list = [...slugs];
  for (let k = 0; k < list.length; k += 150) {
    const { data } = await db.from('custom_products').select('slug,author,category')
      .or(list.slice(k, k + 150).map((s) => `slug.ilike.${s}`).join(','));
    for (const r of data || []) out.set(String(r.slug).toLowerCase(), { author: r.author, category: r.category });
  }
  return out;
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
  const match = body.match === 'author_or_category' ? 'author_or_category' : 'author';
  const daysBack = Math.max(30, Math.min(730, parseInt(body.days_back, 10) || 365));
  const cooldownDays = Math.max(0, Math.min(60, body.cooldown_days === 0 ? 0 : parseInt(body.cooldown_days, 10) || 7));
  const limit = Math.max(1, Math.min(MAX_SEND, parseInt(body.limit, 10) || 300));
  const template = String(process.env.WHATSAPP_NEW_TITLE_TEMPLATE || 'new_title_alert_v1').trim();
  const lang = String(process.env.WHATSAPP_NEW_TITLE_LANG || 'en').trim();
  const withImage = !/^(off|0|false|no)$/i.test(String(process.env.WHATSAPP_NEW_TITLE_IMAGE || '').trim());
  const campaignKey = A.CAMPAIGN_PREFIX + slug;

  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const book = await loadBook(db, slug);
    if (!book) return json(404, { error: 'No live product with that slug' });
    if (book.sold_out) return json(400, { error: 'This book is marked sold out — restock it before announcing it.' });
    if (!A.authorsOf(book.author).length && match === 'author') {
      return json(400, { error: `This book has no usable author ("${book.author || 'blank'}"). Fill in the author, or match by author or category.` });
    }
    const cover = withImage ? await coverFor(book.images) : null;
    const headerImageUrl = cover ? cover.url : null;

    // One number, for checking the message on a phone before the real send.
    if (body.test_phone) {
      const phone = normalizePhone(body.test_phone);
      if (!phone) return json(400, { error: 'Test phone is not a valid Indian mobile' });
      const params = A.templateParams({ name: 'there', reason: A.authorsOf(book.author).length ? book.author : (A.shelfOf(book.category) || 'books like this') }, book);
      const res = await sendWhatsApp({ to: phone, template, params, lang, headerImageUrl, urlButtonParam: book.slug, marketing: true });
      return json(res && res.ok ? 200 : 502, { test: true, ok: !!(res && res.ok), params, cover, error: res && !res.ok ? (res.data?.error?.message || res.error || 'send failed') : undefined });
    }

    const customers = await pastCustomers(db, daysBack);
    const custom = await customMeta(db, customers);
    const { recipients: matched, counts } = A.matchCustomers(customers, book, (item) => catalogueMeta(item, custom), { match });

    // Opt-outs. Either list unreadable → no send (a dry run still reports).
    let optedOut = new Set(), listError = '';
    try { optedOut = await optedOutPhoneSet(db); } catch (e) { listError = e.message; }
    const unsub = await phoneKeys(() => db.from('whatsapp_marketing_subscribers').select('customer_phone').eq('status', 'unsubscribed').order('customer_phone'));
    if (unsub.error) listError = listError || unsub.error;
    const unsubscribed = unsub.keys;
    // The ledger: who already had this book, and who had any marketing lately.
    const prior = await phoneKeys(() => db.from('whatsapp_campaign_deliveries').select('customer_phone').eq('campaign_key', campaignKey).eq('status', 'sent').order('id'));
    const already = prior.keys;
    let ledgerError = prior.error;
    let recent = new Set();
    if (cooldownDays && !ledgerError) {
      const since = new Date(Date.now() - cooldownDays * 86400000).toISOString();
      const r = await phoneKeys(() => db.from('whatsapp_campaign_deliveries').select('customer_phone').eq('status', 'sent').gte('created_at', since).order('id'));
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
    const toSend = eligible.slice(0, limit);
    const preview = A.templateParams(toSend[0] || { name: 'Riya', reason: book.author }, book);
    const summary = {
      book: { slug: book.slug, title: book.title, author: book.author, category: book.category, price: book.price, release: book.release || null },
      template, cover, match, days_back: daysBack, cooldown_days: cooldownDays,
      counts: { ...counts, ...removed, eligible: eligible.length },
      will_send: toSend.length, limit,
      est_cost_inr: Math.round(toSend.length * COST_PER_MSG),
      preview_params: preview,
      sample: toSend.slice(0, 8).map((r) => ({ phone: mask(r.phone), name: r.name, reason: r.reason })),
      blocked_reason: listError ? `Opt-out list unreadable (${listError})` : ledgerError ? `Delivery ledger unreadable — run sql/whatsapp_campaign_deliveries.sql (${ledgerError})` : '',
    };

    if (body.dry_run !== false) return json(200, { dry_run: true, ...summary });
    if (summary.blocked_reason) return json(409, { error: summary.blocked_reason + '. Nothing was sent.', ...summary });
    if (Number(body.expect) !== toSend.length) {
      return json(409, { error: `The count changed since your dry run (${body.expect} → ${toSend.length}). Run the dry run again.`, ...summary });
    }

    let sent = 0, failed = 0;
    const failures = [];
    for (let i = 0; i < toSend.length; i += BATCH) {
      const batch = toSend.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async (r) => {
        try {
          const res = await sendWhatsApp({ to: r.phone, template, params: A.templateParams(r, book), lang, headerImageUrl, urlButtonParam: book.slug, marketing: true });
          return { r, ok: !!(res && res.ok), error: res && !res.ok ? (res.data?.error?.message || res.error || 'send failed') : '' };
        } catch (e) { return { r, ok: false, error: e.message }; }
      }));
      const rows = results.map(({ r, ok, error }) => {
        if (ok) sent++; else { failed++; if (failures.length < 10) failures.push({ phone: mask(r.phone), error }); }
        return {
          campaign_key: campaignKey, customer_phone: r.phone, template_name: template,
          status: ok ? 'sent' : 'failed', error: ok ? null : String(error).slice(0, 1000),
          product_url: `https://inkandchai.in/product/${book.slug}/`,
          metadata: { source: 'new_title', reason: r.reason, match },
        };
      });
      const { error: logError } = await db.from('whatsapp_campaign_deliveries').upsert(rows, { onConflict: 'campaign_key,customer_phone' });
      // Without the ledger the next press would message the same people again.
      if (logError) return json(500, { error: 'Sent ' + sent + ', then could not record deliveries (' + logError.message + '). Stopped.', sent, failed });
      // A template problem fails every message the same way: stop after one batch.
      if (i === 0 && !sent && failed) return json(502, { error: 'The first batch all failed — check the template is approved.', sent, failed, sample_failures: failures });
      if (i + BATCH < toSend.length) await sleep(250);
    }
    console.log(`[new-title-alert] ${book.slug}: sent ${sent}, failed ${failed}`);
    return json(200, { sent, failed, sample_failures: failures, remaining: eligible.length - toSend.length, ...summary });
  } catch (e) {
    console.error('[new-title-alert]', e);
    return json(500, { error: e.message });
  }
};
