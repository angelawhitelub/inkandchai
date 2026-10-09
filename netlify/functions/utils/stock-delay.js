/**
 * "A book in your order is out of stock" -- the customer notice for an order
 * the courier has not picked up 3+ days after it was placed, and the
 * cancel / remove-a-book request it links to.
 *
 * Who gets it (owner's rules, 10 Oct 2026):
 *   - the order HAS an AWB but the courier has not picked it up (the Not
 *     Picked Up tab's awaiting_pickup rows), 72+ hours after ordering. Orders
 *     not booked yet get nothing.
 *   - the courier itself says it is still waiting (utils/pickup-live), because
 *     "no scan recorded" proves nothing: NimbusPost and iThink bookings send no
 *     scans, and 107 of 250 such rows once turned out delivered.
 *   - not replacements (free reships), not a voided AWB, not an order that
 *     already has a cancellation request, and once per order.
 *
 * Which book it names: any book in the order marked sold out in the catalogue
 * (stock_qty <= 0); a one-book order names that book; otherwise "one of the
 * books in your order".
 *
 * The request is a REQUEST: it records cancellation_requested_at + a note
 * (the admin's "Cancel Requests" filter) and alerts the owner. It never
 * changes the order, cancels a shipment or moves money.
 */
'use strict';

const crypto = require('crypto');

const MIN_HOURS = 72;
const SITE = () => String(process.env.URL || 'https://inkandchai.in').replace(/\/+$/, '');

// Still waiting to ship: an order in any other state is past the point where
// "cancel or drop a book" means anything.
const OPEN_STATUSES = new Set(['shipped', 'paid', 'confirmed', 'cod_pending', 'partial_cod_pending']);

// ── The link ──────────────────────────────────────────────────────────────
// Customers reach the page from WhatsApp or email, not signed in, so the link
// carries a signature of the order id. ORDER_LINK_SECRET if set; otherwise a
// key derived from the service key, which never leaves the server.
function linkSecret() {
  if (process.env.ORDER_LINK_SECRET) return process.env.ORDER_LINK_SECRET;
  const base = process.env.SUPABASE_SERVICE_KEY || process.env.ADMIN_SECRET || '';
  if (!base) throw new Error('no secret configured for order links');
  return crypto.createHmac('sha256', base).update('order-help-link:v1').digest('hex');
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function linkToken(orderId) {
  return b64url(crypto.createHmac('sha256', linkSecret()).update(String(orderId).toUpperCase()).digest()).slice(0, 24);
}

function verifyToken(orderId, token) {
  if (!orderId || !token) return false;
  const want = Buffer.from(linkToken(orderId));
  const got = Buffer.from(String(token));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** The query string the page reads: `?o=<order id>&k=<signature>`. */
const linkQuery = (orderId) => `?o=${encodeURIComponent(orderId)}&k=${linkToken(orderId)}`;
const linkFor = (orderId) => `${SITE()}/order-help/${linkQuery(orderId)}`;

// ── The books ─────────────────────────────────────────────────────────────
function slugOf(item) {
  const s = String(item?.slug || '').trim();
  if (s) return s.toLowerCase();
  const m = String(item?.url || item?.id || '').match(/\/product\/([^/?#]+)/);
  return m ? m[1].toLowerCase() : '';
}

/** The order's books: [{ index, title, qty, price, slug }]. */
function booksOf(order) {
  return (Array.isArray(order.cart_items) ? order.cart_items : [])
    .map((i, index) => ({
      index,
      title: String(i?.title || i?.name || '').replace(/\s+/g, ' ').trim(),
      qty: Math.max(1, Number(i?.qty || i?.quantity) || 1),
      price: Number(i?.price) || 0,
      slug: slugOf(i),
    }))
    .filter((b) => b.title);
}

/** Books in the order marked sold out (`sold`: Set of slugs, utils/sold-out). */
function outOfStockBooks(order, sold) {
  return booksOf(order).filter((b) => b.slug && sold && sold.has(b.slug));
}

/** The words the message uses for the book: a title, or "one of the books". */
function bookPhrase(order, sold) {
  const books = booksOf(order);
  const oos = outOfStockBooks(order, sold);
  if (oos.length === 1) return `"${oos[0].title}"`;
  if (oos.length > 1) return oos.map((b) => `"${b.title}"`).join(' and ');
  if (books.length === 1) return `"${books[0].title}"`;
  return 'one of the books in your order';
}

// ── Who gets it ───────────────────────────────────────────────────────────
/**
 * row: a Not Picked Up row (utils/not-picked-up classify); order: the raw
 * order. Returns null when eligible, else the reason it is not.
 */
function skipReason(row, order, now = Date.now()) {
  if (!row || row.bucket !== 'awaiting_pickup') return 'not booked or already moving';
  if (row.replacement) return 'replacement order';
  if (row.courier_cancelled) return 'courier voided the AWB';
  const age = (now - Date.parse(order.created_at)) / 3600e3;
  if (!(age >= MIN_HOURS)) return 'younger than 3 days';
  if (order.cancellation_requested_at) return 'cancellation already requested';
  if (!OPEN_STATUSES.has(String(order.status || '').toLowerCase())) return `status ${order.status}`;
  return null;
}

// ── The words ─────────────────────────────────────────────────────────────
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function messageFor(order, sold) {
  const id = order.razorpay_order_id || order.id;
  const books = booksOf(order);
  const phrase = bookPhrase(order, sold);
  const verb = outOfStockBooks(order, sold).length > 1 ? 'are' : 'is';
  const canRemove = books.length > 1;
  const link = linkFor(id);
  const choice = canRemove
    ? 'request to cancel the order, or to remove just that book and receive the rest'
    : 'request to cancel the order';
  const text = `Hi ${firstName(order.customer_name)}, an update on your Ink & Chai order ${id}: `
    + `${phrase} ${verb} out of stock with us and with our supplier. We are still trying to arrange it `
    + `and will ship as soon as we can. If you would rather not wait, you can ${choice} here: ${link}\n\n- Ink & Chai`;
  const subject = `Your order ${id}: a book is out of stock`;
  const html = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:24px;color:#2b2118;line-height:1.6;">
  <h2 style="font-weight:400;color:#8a6a1f;margin:0 0 12px;">Ink &amp; Chai</h2>
  <p>Hi ${esc(firstName(order.customer_name))},</p>
  <p>An update on your order <strong>${esc(id)}</strong>: ${esc(phrase)} ${verb} out of stock with us and with our supplier.
     We are still trying to arrange it and will ship your order as soon as we can.</p>
  <p>If you would rather not wait, you can ${esc(choice)}:</p>
  <p><a href="${esc(link)}" style="display:inline-block;padding:10px 18px;background:#c9a84c;color:#1a1408;text-decoration:none;font-weight:bold;">${canRemove ? 'Cancel the order or remove the book' : 'Request cancellation'}</a></p>
  <p style="font-size:13px;color:#6b5a48;">This sends us a request; we confirm it with you before anything is cancelled. If you are happy to wait, you don't need to do anything.</p>
  <p>Sorry for the wait,<br>Ink &amp; Chai</p>
</div>`;
  return { id, phrase, canRemove, link, text, subject, html, books, params: [firstName(order.customer_name), id, phrase] };
}

module.exports = {
  MIN_HOURS, OPEN_STATUSES,
  linkToken, verifyToken, linkFor, linkQuery,
  booksOf, outOfStockBooks, bookPhrase, skipReason, messageFor,
};
