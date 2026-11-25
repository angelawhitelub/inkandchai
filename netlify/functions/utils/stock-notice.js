/**
 * "Your book is out of stock with us" -- the owner's bulk notice for one book
 * (admin Not Picked Up → 📦 Book delayed notice; admin-stock-notice.js).
 *
 * The owner picks a book and the date the publisher's stock is expected. Every
 * open order holding that book that the courier has not picked up yet is
 * listed: we know the order has not been picked up for N days, we are
 * arranging the book from the publisher, the stock should arrive on <day,
 * date>, and the customer may cancel any time from My Orders with the refund
 * issued automatically.
 *
 * That last promise is what this file makes true. An order told here is kept in
 * KV (catalog:stock-notice-orders), and quoteUnpickedCancel({ stockNotice })
 * then lets it be cancelled from My Orders at once: no 7-day wait, and a booked
 * COD order too (nothing to refund). The cancel itself is the usual one
 * (cancel-unpicked-order → handleOne): courier asked live, AWB voided, refund
 * through update-order-status. An order that path could not cancel is left out
 * of the list, so nobody is promised a cancel button they will not see.
 */
'use strict';

const { quoteUnpickedCancel } = require('./unpicked-cancel');

const KEY = 'stock-notice-orders';
const KEEP_DAYS = 120;
const SITE = 'https://inkandchai.in';
const MY_ORDERS = `${SITE}/?orders=1`;
const IST = 'Asia/Kolkata';

// ── Books in an order ─────────────────────────────────────────────────────
function cartOf(order) {
  let cart = order?.cart_items;
  if (typeof cart === 'string') { try { cart = JSON.parse(cart); } catch { cart = []; } }
  return Array.isArray(cart) ? cart : [];
}
function slugOf(item) {
  const s = String(item?.slug || '').trim();
  if (s) return s.toLowerCase();
  const m = String(item?.url || item?.id || '').match(/\/product\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]).toLowerCase() : '';
}
const norm = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9ऀ-ॿ؀-ۿ]+/g, ' ').trim();
const titleOf = (item) => String(item?.title || item?.name || '').replace(/\s+/g, ' ').trim();

/** The order's line for this book (slug match first, else the exact title), or null. */
function bookLine(order, book) {
  const slug = String(book?.slug || '').trim().toLowerCase();
  const title = norm(book?.title);
  for (const item of cartOf(order)) {
    if (slug && slugOf(item) === slug) return { title: titleOf(item), qty: Math.max(1, Number(item?.qty || item?.quantity) || 1) };
  }
  if (!title) return null;
  for (const item of cartOf(order)) {
    if (norm(titleOf(item)) === title) return { title: titleOf(item), qty: Math.max(1, Number(item?.qty || item?.quantity) || 1) };
  }
  return null;
}

/** Books across a set of orders, most orders first: [{ slug, title, orders }]. */
function booksIn(orders) {
  const by = new Map();
  for (const o of orders || []) {
    const seen = new Set();
    for (const item of cartOf(o)) {
      const title = titleOf(item);
      if (!title) continue;
      const k = slugOf(item) || `t:${norm(title)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const b = by.get(k) || { slug: slugOf(item), title, orders: 0 };
      b.orders++;
      by.set(k, b);
    }
  }
  return [...by.values()].sort((a, b) => b.orders - a.orders || a.title.localeCompare(b.title));
}

// ── Dates ─────────────────────────────────────────────────────────────────
/** 'YYYY-MM-DD' → "Monday, 1 December 2026"; null when it is not a real date. */
function etaWords(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 6, 30));   // noon IST
  if (d.getUTCDate() !== +m[3]) return null;
  return d.toLocaleDateString('en-IN', { timeZone: IST, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
const todayIst = (now = Date.now()) => new Date(now).toLocaleDateString('en-CA', { timeZone: IST });
/** The ETA must be today or later (IST). */
const etaOk = (iso, now = Date.now()) => !!etaWords(iso) && String(iso) >= todayIst(now);

/** Whole days since the order was placed (at least 1). */
function daysSince(order, now = Date.now()) {
  const t = Date.parse(order?.created_at || '');
  return Number.isFinite(t) ? Math.max(1, Math.floor((now - t) / 86400e3)) : null;
}

// ── Who may be told ───────────────────────────────────────────────────────
const COD_OPEN = ['cod_pending', 'confirmed'];
const orderId = (o) => String(o?.razorpay_order_id || o?.id || '').toUpperCase();

/**
 * How the customer would cancel it from My Orders, or why this notice must not
 * go: { ok:true, how:'unpicked'|'cod', refundPaise } | { ok:false, reason }.
 * row: the Not Picked Up row (utils/not-picked-up classify) for this order.
 */
function cancelRoute(order, row, now = Date.now()) {
  if (!row) return { ok: false, reason: 'courier has it (picked up / moving)' };
  if (row.replacement) return { ok: false, reason: 'replacement order' };
  if (row.courier_cancelled) return { ok: false, reason: 'courier voided the AWB' };
  if (order.cancellation_requested_at || order.late_cancel_at) return { ok: false, reason: 'cancellation already requested' };
  const q = quoteUnpickedCancel(order, now, { stockNotice: true });
  if (q.eligible) return { ok: true, how: 'unpicked', refundPaise: q.refundPaise, partialCod: q.partialCod };
  // Plain COD, not booked: My Orders' own "Cancel Order" (cancel-order.js).
  const status = String(order.status || '').toLowerCase();
  if (COD_OPEN.includes(status) && !String(order.tracking_id || '').trim() && !String(order.razorpay_payment_id || '').trim()) {
    return { ok: true, how: 'cod', refundPaise: 0 };
  }
  const why = { nothing_paid: 'unpaid, not booked', closed: `status ${order.status}`, split: 'split order', wrong_cod: 'wrong COD amount on it', moved: 'courier has it' };
  return { ok: false, reason: why[q.reason] || q.reason };
}

// ── The words ─────────────────────────────────────────────────────────────
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const rs = (paise) => `₹${Math.round(Number(paise || 0) / 100).toLocaleString('en-IN')}`;

/**
 * The message for one order. WhatsApp template STOCK_ETA_TEMPLATE takes
 * params [name, order id, days, book, eta] in that order (see the endpoint).
 */
function messageFor(order, { title, eta, refundPaise = 0, now = Date.now() }) {
  const id = orderId(order);
  const days = daysSince(order, now);
  const dayWord = `${days} day${days === 1 ? '' : 's'}`;
  const when = etaWords(eta);
  const name = firstName(order.customer_name);
  const refund = refundPaise > 0
    ? `your refund of ${rs(refundPaise)} will be issued automatically`
    : 'as it is Cash on Delivery, there is nothing to pay or refund';
  const text = `Hi ${name}, about your Ink & Chai order ${id}: we are aware that your order has not been picked up yet, ${dayWord} after you placed it. `
    + `"${title}" is out of stock with us, and we are actively arranging the stock from the publisher. We deeply apologise for the delay.\n\n`
    + `The latest expected arrival of the stock is ${when}, and we will ship your order as soon as it arrives.\n\n`
    + `If you wish to cancel, you can cancel it anytime from the My Orders section on our website (${MY_ORDERS}), and ${refund}.\n\n- Ink & Chai`;
  const subject = `Your order ${id}: "${title}" is on its way to us from the publisher`;
  const html = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:24px;color:#2b2118;line-height:1.6;">
  <h2 style="font-weight:400;color:#8a6a1f;margin:0 0 12px;">Ink &amp; Chai</h2>
  <p>Hi ${esc(name)},</p>
  <p>We are aware that your order <strong>${esc(id)}</strong> has not been picked up yet, <strong>${esc(dayWord)}</strong> after you placed it.
     <strong>${esc(title)}</strong> is out of stock with us, and we are actively arranging the stock from the publisher.
     We deeply apologise for the delay.</p>
  <p style="padding:12px 16px;background:#f6efe0;border-left:3px solid #c9a84c;">Latest expected arrival of the stock: <strong>${esc(when)}</strong>.<br>
     We will ship your order as soon as it arrives.</p>
  <p>If you wish to cancel, you can cancel it anytime from <strong>My Orders</strong> on our website, and ${esc(refund)}.</p>
  <p><a href="${MY_ORDERS}" style="display:inline-block;padding:10px 18px;background:#c9a84c;color:#1a1408;text-decoration:none;font-weight:bold;">Open My Orders</a></p>
  <p style="font-size:13px;color:#6b5a48;">If you are happy to wait, you don't need to do anything.</p>
  <p>With apologies,<br>Ink &amp; Chai</p>
</div>`;
  return { id, days, eta: when, text, subject, html, params: [name, id, String(days), title, when] };
}

// ── The ledger (KV catalog:stock-notice-orders) ───────────────────────────
// { "<ORDER ID>": { at, eta, slug, title } }. Read by get-my-orders and
// cancel-unpicked-order to open the cancel; by the endpoint to show "told".
function store(deps = {}) {
  if (deps.store) return deps.store;
  const { getStore } = require('@netlify/blobs');
  return getStore('catalog');
}
async function readLedger(deps = {}, now = Date.now()) {
  const all = (await store(deps).get(KEY, { type: 'json' })) || {};
  const cutoff = now - KEEP_DAYS * 86400e3;
  return Object.fromEntries(Object.entries(all).filter(([, v]) => Date.parse(v?.at || '') > cutoff));
}
async function markTold(ids, info, deps = {}, now = Date.now()) {
  if (!ids.length) return;
  const all = await readLedger(deps, now);
  const at = new Date(now).toISOString();
  for (const id of ids) all[String(id).toUpperCase()] = { at, eta: info.eta, slug: info.slug || '', title: info.title || '' };
  await store(deps).setJSON(KEY, all);
}
/** Was this order told (so it may be cancelled from My Orders at once)? */
const told = (ledger, order) => !!(ledger && ledger[orderId(order)]);

/** The ledger for a page load; an unreadable ledger only means "nobody told". */
async function ledgerOrEmpty(deps = {}) {
  try { return await readLedger(deps); } catch (e) { console.warn('[stock-notice] ledger unreadable:', e.message); return {}; }
}

module.exports = {
  KEY, MY_ORDERS,
  cartOf, bookLine, booksIn, etaWords, etaOk, daysSince, cancelRoute, messageFor,
  readLedger, markTold, told, ledgerOrEmpty, orderId,
};
