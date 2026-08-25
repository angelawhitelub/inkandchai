/**
 * Recovering the books and address for orders whose details were lost.
 *
 * On 24 Aug 2026 Supabase was unreachable for eight hours. Twelve customers
 * paid, and the only trace was in PhonePe: a name, a phone and an email. What
 * they bought and where to send it existed nowhere. The orders were restored
 * with an empty cart and a placeholder address, and the missing halves have to
 * come back from the customers themselves.
 *
 * This module is the part that can be trusted to run unattended: it turns a
 * free-text reply into line items, and it only writes them when the arithmetic
 * proves the match is right.
 *
 * The proof is the payment. If the matched books plus shipping equal what the
 * customer actually paid, to the paisa, then the titles are almost certainly
 * the ones they bought — a wrong match would have to coincidentally cost the
 * same. When it does not add up, the address is still saved (it is what the
 * customer typed, there is nothing to get wrong) but the cart is left empty
 * and a human is asked to look. Shipping a wrong book is worse than waiting.
 */

const fs = require('fs');
const path = require('path');
const { lookupBook } = require('./book-lookup');

// Written into customer_address by the recovery script so the admin panel shows
// why the order looks half-finished. An order is identified as awaiting details
// by its EMPTY CART, not by this string — a real order always has line items,
// which makes that a structural test rather than a text match.
const AWAITING_MARKER = 'ADDRESS NOT CAPTURED';

const FREE_SHIPPING_FROM_RS = 499;   // same rule as the storefront
const SHIPPING_RS = 40;
const PARTIAL_COD_RATE = 0.10;

const LIVE_STATUSES = [
  'paid', 'confirmed', 'cod_pending', 'partial_cod_pending', 'pending_partial_phonepe',
];

function isAwaitingDetails(order) {
  if (!order) return false;
  if (!LIVE_STATUSES.includes(String(order.status || ''))) return false;
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  return items.length === 0;
}

async function findAwaitingOrders(supabase, { phone = null, limit = 50 } = {}) {
  let q = supabase
    .from('orders')
    .select('*')
    .in('status', LIVE_STATUSES)
    .order('created_at', { ascending: false })
    .limit(500);
  if (phone) {
    const last10 = String(phone).replace(/\D/g, '').slice(-10);
    if (!last10) return [];
    q = q.or([last10, `91${last10}`, `+91${last10}`].map(p => `customer_phone.eq.${p}`).join(','));
  }
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).filter(isAwaitingDetails).slice(0, limit);
}

// ── image lookup, so a recovered order looks like any other in admin ────────
let _imgBySlug = null;
function staticImages() {
  if (_imgBySlug) return _imgBySlug;
  _imgBySlug = new Map();
  try {
    const candidates = [
      path.join(process.cwd(), 'data', 'ALL_BOOKS.json'),
      path.join(__dirname, '..', '..', '..', 'data', 'ALL_BOOKS.json'),
      path.join('/var/task', 'data', 'ALL_BOOKS.json'),
    ];
    const file = candidates.find(p => fs.existsSync(p));
    if (file) {
      for (const b of JSON.parse(fs.readFileSync(file, 'utf8'))) {
        const slug = (String(b.url || '').match(/\/product\/([^/?#]+)/) || [])[1];
        if (slug && b.image_url && !_imgBySlug.has(slug)) _imgBySlug.set(slug, b.image_url);
      }
    }
  } catch (err) {
    console.error('[detail-recovery] image index failed:', err.message);
  }
  return _imgBySlug;
}

function toCartItem(hit, qty = 1) {
  const slug = hit.slug || '';
  return {
    id: slug ? `/product/${slug}/` : '',
    img: staticImages().get(slug) || '',
    qty,
    sku: '',
    url: slug ? `/product/${slug}/` : '',
    slug,
    price: Number(hit.price),
    title: hit.title,
    author: hit.author || '',
  };
}

/** "2x Atomic Habits" / "Atomic Habits (2)" / "Atomic Habits" → {qty, title} */
function splitQty(raw) {
  const s = String(raw || '').trim();
  let m = s.match(/^(\d{1,2})\s*[x×*]\s*(.+)$/i);
  if (m) return { qty: Math.min(20, Number(m[1])), title: m[2].trim() };
  m = s.match(/^(.+?)\s*[x×*]\s*(\d{1,2})$/i);
  if (m) return { qty: Math.min(20, Number(m[2])), title: m[1].trim() };
  return { qty: 1, title: s };
}

function splitTitles(booksText) {
  return String(booksText || '')
    // customers write lists as "1. Foo 2. Bar", on separate lines, or comma-separated
    .split(/[,;\n]+|\s+\d+[.)]\s+/)
    .map(s => s.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean);
}

/**
 * Match a free-text book list and check it against what was actually paid.
 * Returns the proposed cart plus a verdict; it never writes anything.
 */
async function priceAgainstPayment(booksText, order) {
  const paidRs = Number(order?.amount_paise || 0) / 100;
  const isPartial = String(order?.status) === 'partial_cod_pending'
    || String(order?.status) === 'pending_partial_phonepe';

  const titles = splitTitles(booksText);
  const items = [];
  const unmatched = [];
  for (const raw of titles) {
    const { qty, title } = splitQty(raw);
    const hit = await lookupBook(title);
    if (!hit) { unmatched.push(title); continue; }
    items.push(toCartItem(hit, qty));
  }

  const goodsRs = items.reduce((s, i) => s + i.price * i.qty, 0);
  const shippingRs = goodsRs >= FREE_SHIPPING_FROM_RS ? 0 : SHIPPING_RS;
  const fullTotalRs = goodsRs + shippingRs;
  // A partial-COD customer paid a tenth of the order, so that is what the
  // arithmetic has to land on. Same rounding the checkout uses.
  const expectedRs = isPartial ? Math.round(fullTotalRs * PARTIAL_COD_RATE) : fullTotalRs;
  const reconciles = items.length > 0 && !unmatched.length
    && Math.abs(expectedRs - paidRs) < 0.01;

  let reason = '';
  if (!items.length) reason = 'none of the titles matched the catalogue';
  else if (unmatched.length) reason = `no catalogue match for: ${unmatched.join(', ')}`;
  else if (!reconciles) reason = `books come to ₹${expectedRs.toFixed(2)} but ₹${paidRs.toFixed(2)} was paid`;

  const cart = items.map((it, ix) => (ix === 0 && isPartial)
    ? { ...it, _payment: {
        mode: 'partial_cod', rate: PARTIAL_COD_RATE,
        balance: fullTotalRs - expectedRs, deposit: expectedRs, full_total: fullTotalRs,
      } }
    : it);

  return { cart, items, unmatched, goodsRs, shippingRs, fullTotalRs, expectedRs, paidRs, isPartial, reconciles, reason };
}

function looksLikeAddress(address) {
  const s = String(address || '').trim();
  if (s.length < 15) return { ok: false, reason: 'too short to be a delivery address' };
  if (!/\b\d{6}\b/.test(s)) return { ok: false, reason: 'no 6-digit pincode' };
  return { ok: true, reason: '' };
}

/**
 * Write back whatever has been established.
 *  - address valid            → saved (nothing to get wrong; it is verbatim)
 *  - books reconcile to money → cart saved, order becomes shippable
 *  - otherwise                → cart untouched, needs_review returned
 */
async function applyRecoveredDetails(supabase, order, { address = '', books = '' } = {}) {
  const out = {
    order_id: order.razorpay_order_id,
    address_saved: false, books_saved: false, needs_review: false,
    reason: '', cart: [], address: '',
  };

  const update = {};
  const addrCheck = looksLikeAddress(address);
  if (address && addrCheck.ok) {
    update.customer_address = String(address).replace(/\s+/g, ' ').trim().slice(0, 500);
    out.address_saved = true;
    out.address = update.customer_address;
  } else if (address) {
    out.reason = `address ${addrCheck.reason}`;
  }

  if (books) {
    const priced = await priceAgainstPayment(books, order);
    out.cart = priced.cart;
    out.pricing = {
      goods: priced.goodsRs, shipping: priced.shippingRs,
      expected: priced.expectedRs, paid: priced.paidRs, partial: priced.isPartial,
    };
    if (priced.reconciles) {
      update.cart_items = priced.cart;
      out.books_saved = true;
    } else {
      out.needs_review = true;
      out.reason = [out.reason, priced.reason].filter(Boolean).join('; ');
    }
  }

  if (!Object.keys(update).length) return out;

  // `.select()` so the caller gets the row as it now stands. Anything that acts
  // on the recovered order — a NimbusPost push above all — must use this and not
  // the stale copy passed in, which still has the empty address and cart.
  const { data: saved, error } = await supabase
    .from('orders').update(update).eq('razorpay_order_id', order.razorpay_order_id)
    .select('*').maybeSingle();
  if (error) {
    out.address_saved = false;
    out.books_saved = false;
    out.reason = `database write failed: ${error.message}`;
    return out;
  }
  out.order = saved || { ...order, ...update };
  return out;
}

module.exports = {
  AWAITING_MARKER, LIVE_STATUSES,
  isAwaitingDetails, findAwaitingOrders,
  priceAgainstPayment, applyRecoveredDetails,
  looksLikeAddress, splitTitles, splitQty, toCartItem,
};
