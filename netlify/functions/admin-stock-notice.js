/**
 * Netlify Function: admin-stock-notice   (owner only; staff tokens refused)
 *
 * Bulk "this book is out of stock with us, expected on <date>" notice to every
 * customer whose order holds the book and has not been picked up yet (admin
 * Not Picked Up → 📦 Book delayed notice). Rules and words: utils/stock-notice.
 *
 * POST { action: 'books' }
 *   The books in not-picked-up orders, most orders first (for the picker).
 * POST { action: 'preview', book: { slug, title }, eta: 'YYYY-MM-DD' }
 *   Who would be told and the exact message each gets; who is left out and
 *   why. Sends nothing.
 * POST { action: 'send', book, eta, order_ids: [...], expect: <n> }
 *   Sends to the ticked orders, all of which must still be in the preview, and
 *   `expect` must equal their number. Email + WhatsApp template
 *   STOCK_ETA_TEMPLATE (default order_stock_eta); until Meta approves it the
 *   same words go as a plain message, which WhatsApp delivers only inside the
 *   24-hour window. An order is recorded only once a channel delivered, and
 *   from then on My Orders lets it be cancelled at once (refund automatic).
 *
 * WhatsApp template order_stock_eta (UTILITY, English), 5 body params:
 *   Hi {{1}}, about your Ink & Chai order {{2}}: we are aware that your order
 *   has not been picked up yet, {{3}} days after you placed it. "{{4}}" is out
 *   of stock with us, and we are actively arranging the stock from the
 *   publisher. We deeply apologise for the delay.
 *   The latest expected arrival of the stock is {{5}}, and we will ship your
 *   order as soon as it arrives.
 *   If you wish to cancel, you can cancel it anytime from the My Orders
 *   section on our website, and any amount you paid will be refunded
 *   automatically.
 *   Button: URL (static) "My Orders" → https://inkandchai.in/?orders=1
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { listNotPicked, REPORT_DAYS } = require('./utils/not-picked-up-list');
const { checkPickups } = require('./utils/pickup-live');
const { sendEmail } = require('./utils/email');
const { sendWhatsApp, sendText } = require('./utils/whatsapp');
const sn = require('./utils/stock-notice');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const MAX_SEND = 150;   // per press: email + WhatsApp each, under the Worker's subrequest cap

/** Who would be told for this book and date: { due:[{order,msg,route,told}], left:[{id,reason}] }. */
async function plan({ book, eta, now = Date.now() }, deps = {}) {
  const db = deps.db;
  const { orders, rows } = await (deps.listNotPicked || listNotPicked)(db, { minHours: 0, days: REPORT_DAYS, now });
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const withBook = orders.filter((o) => sn.bookLine(o, book));
  if (!withBook.length) return { due: [], left: [], title: book.title || '' };

  // Whole rows: the cancel rules read columns the list does not carry.
  const full = new Map();
  const ids = withBook.map((o) => o.id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.from('orders').select('*').in('id', ids.slice(i, i + 200));
    if (error) throw new Error(`order lookup failed: ${error.message}`);
    for (const o of data || []) full.set(o.id, o);
  }

  const ledger = deps.ledger || await sn.readLedger(deps);
  const left = [];
  let due = [];
  for (const o of withBook) {
    const order = full.get(o.id) || o;
    const id = sn.orderId(order);
    const route = sn.cancelRoute(order, rowById.get(o.id), now);
    if (!route.ok) { left.push({ id, reason: route.reason }); continue; }
    const prior = ledger[id];
    if (prior && prior.eta === eta) { left.push({ id, reason: `already told (arrival ${prior.eta})` }); continue; }
    due.push({ order, route, told: prior || null });
  }

  // "Not picked up" is the courier's word, never only ours: NimbusPost and
  // iThink bookings send no scans, and such parcels have turned out delivered.
  const booked = due.filter((d) => String(d.order.tracking_id || '').trim());
  if (booked.length) {
    const live = await (deps.checkPickups || checkPickups)(booked.map((d) => d.order));
    due = due.filter((d) => {
      if (!String(d.order.tracking_id || '').trim()) return true;
      const st = (live.get(d.order.id) || {}).state || 'unknown';
      if (st === 'waiting') return true;
      left.push({ id: sn.orderId(d.order), reason: st === 'unknown' ? 'courier did not answer' : `courier says ${st}` });
      return false;
    });
  }

  const title = (withBook.map((o) => sn.bookLine(o, book)).find(Boolean) || {}).title || book.title || '';
  due.sort((a, b) => Date.parse(a.order.created_at) - Date.parse(b.order.created_at));
  for (const d of due) d.msg = sn.messageFor(d.order, { title, eta, refundPaise: d.route.refundPaise, now });
  return { due, left, title };
}

async function deliver({ order, msg }, deps = {}) {
  const out = { order: msg.id, email: null, whatsapp: null };
  const email = String(order.customer_email || '').trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    try {
      const r = await (deps.sendEmail || sendEmail)({ to: email, subject: msg.subject, html: msg.html });
      out.email = r && r.ok === false ? 'failed' : 'sent';
    } catch (e) { out.email = `failed: ${e.message}`; }
  }
  if (order.customer_phone) {
    const t = await (deps.sendWhatsApp || sendWhatsApp)({
      to: order.customer_phone,
      template: process.env.STOCK_ETA_TEMPLATE || 'order_stock_eta',
      params: msg.params,
    }).catch((e) => ({ ok: false, error: e.message }));
    if (t && t.ok) out.whatsapp = 'template';
    else {
      const p = await (deps.sendText || sendText)(order.customer_phone, msg.text).catch((e) => ({ ok: false, error: e.message }));
      out.whatsapp = p && p.ok ? 'text (24 h window)' : 'failed';
    }
  }
  out.ok = out.email === 'sent' || /^(template|text)/.test(out.whatsapp || '');
  return out;
}

const view = (d) => ({
  id: d.msg.id, created_at: d.order.created_at, days: d.msg.days,
  customer: d.order.customer_name || '', phone: !!d.order.customer_phone, email: !!d.order.customer_email,
  awb: d.order.tracking_id || '', courier: d.order.courier_name || '',
  cancel: d.route.how === 'cod' ? 'COD cancel (not booked)' : d.route.refundPaise > 0 ? `refund ₹${Math.round(d.route.refundPaise / 100)}` : 'COD cancel (booked)',
  told_before: d.told ? d.told.eta : null,
  text: d.msg.text,
});

async function handle(event = {}, deps = {}) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  // Staff tokens are refused by requireAdmin: this endpoint is not in STAFF_ENDPOINT_PERMISSIONS.
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;

  let body;
  try { body = JSON.parse(event.body || '{}') || {}; } catch { return json(400, { error: 'Invalid JSON' }); }
  const db = deps.db || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const d = { ...deps, db };

  try {
    if (body.action === 'books') {
      const { orders } = await (d.listNotPicked || listNotPicked)(db, { minHours: 0, days: REPORT_DAYS });
      return json(200, { books: sn.booksIn(orders).slice(0, 400) });
    }

    const book = { slug: String(body.book?.slug || '').trim().toLowerCase(), title: String(body.book?.title || '').trim() };
    if (!book.slug && !book.title) return json(400, { error: 'Pick a book.' });
    const eta = String(body.eta || '').trim();
    if (!sn.etaOk(eta)) return json(400, { error: 'Pick the expected arrival date (today or later).' });

    if (body.action === 'preview') {
      const p = await plan({ book, eta }, d);
      return json(200, { title: p.title, eta_words: sn.etaWords(eta), due: p.due.map(view), left: p.left, template: process.env.STOCK_ETA_TEMPLATE || 'order_stock_eta' });
    }

    if (body.action === 'send') {
      const want = new Set((Array.isArray(body.order_ids) ? body.order_ids : []).map((s) => String(s).toUpperCase()));
      if (!want.size) return json(400, { error: 'Tick at least one order.' });
      if (want.size > MAX_SEND) return json(400, { error: `At most ${MAX_SEND} orders per send; send the rest in a second batch.` });
      if (Number(body.expect) !== want.size) return json(409, { error: 'The ticked count changed; preview again.' });
      const p = await plan({ book, eta }, d);
      const items = p.due.filter((x) => want.has(x.msg.id));
      const gone = [...want].filter((id) => !items.some((x) => x.msg.id === id));
      if (gone.length) return json(409, { error: `No longer due (picked up, cancelled or told): ${gone.join(', ')}. Preview again.` });

      const results = [];
      for (const it of items) results.push(await deliver(it, d));
      const okIds = results.filter((r) => r.ok).map((r) => r.order);
      try { await sn.markTold(okIds, { eta, slug: book.slug, title: p.title }, d); }
      catch (e) { console.error('[admin-stock-notice] ledger write failed', e.message); }
      console.log('[admin-stock-notice]', JSON.stringify({ book: book.slug || book.title, eta, sent: okIds.length, of: items.length }));
      return json(200, { sent: okIds.length, of: items.length, results });
    }

    return json(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('[admin-stock-notice]', e);
    return json(500, { error: e.message });
  }
}

exports.handler = (event) => handle(event);
exports._test = { handle, plan, deliver, view };
