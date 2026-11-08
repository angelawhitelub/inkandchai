'use strict';

/**
 * Splitting one order into several shipments (admin-split-order.js).
 *
 * The owner ships the books that are in stock now and the rest later. The
 * original order keeps its id, its payment and the books that stay; every new
 * shipment is a child order with its own id (<parent>-S2, -S3 ...) that ships
 * like any other order.
 *
 * MONEY: the original order keeps ALL of the money. A child is a fulfilment
 * shipment of something already sold, exactly like a replacement: amount_paise
 * 0, source 'split', prepaid at the courier (utils/replacement-order.js treats
 * source 'split' as not-a-sale). So:
 *   - prepaid: nothing changes, nothing is collected anywhere;
 *   - COD / partial COD: the original's parcel still collects the whole amount.
 *     This has to be so once an AWB exists (the collectable is fixed on the
 *     booking), and keeping one rule means a courier-panel row pushed before
 *     the split can never collect twice.
 * Revenue, units sold and refunds stay on the original; the child only moves
 * books (and their counted stock) from one parcel to another.
 */

const UNSHIPPED = ['paid', 'confirmed', 'cod_pending', 'partial_cod_pending'];
// AWB assigned, parcel not yet picked up.
const BOOKED = ['shipped', 'pickup_scheduled', 'processing'];
const MAX_ID = 20; // XpressBees' order_number limit

const qtyOf = (i) => Math.max(1, Math.floor(Number(i && (i.qty || i.quantity)) || 1));
// Line flags that describe the BOOK (pre-order release etc.) travel with it;
// order-level metadata (_payment, _split, claims) stays with the order.
const ORDER_META = new Set(['_payment', '_split', '_replacement', '_missing', '_missing_at', '_missing_qty', '_missing_photos']);

function parseCart(cart) {
  if (Array.isArray(cart)) return cart;
  try { const p = JSON.parse(cart || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
}

/** Stock slug of a cart line, exactly as the orders_stock_sync trigger reads it. */
function lineSlug(item) {
  const s = String((item && item.slug) || '').trim();
  if (s) return s.toLowerCase();
  const m = String((item && item.url) || '').match(/\/product\/([^/?#]+)/);
  return m ? m[1].toLowerCase() : '';
}

const splitMeta = (order) => parseCart(order && order.cart_items)[0]?._split || null;
const isSplitChild = (order) => String(order && order.source || '').toLowerCase() === 'split' || !!splitMeta(order)?.of;
const splitChildren = (order) => (splitMeta(order)?.children || []).map(String);

/** Can this order be split at all? Returns a reason string, or '' when it can. */
function splitRefusal(order) {
  if (!order) return 'Order not found';
  const status = String(order.status || '').toLowerCase();
  if (String(order.source || '').toLowerCase() === 'replacement' || status === 'replacement_pending') return 'Replacement orders cannot be split.';
  if (isSplitChild(order)) return `This is already a split shipment of ${splitMeta(order)?.of || 'another order'} — split the original order instead.`;
  const units = parseCart(order.cart_items).reduce((n, i) => n + qtyOf(i), 0);
  if (units < 2) return 'Only an order with two or more books can be split.';
  if (UNSHIPPED.includes(status)) return '';
  if (BOOKED.includes(status) && String(order.tracking_id || '').trim()) {
    if (order.shipment_moved_at || order.delivered_at) return 'The parcel has already been picked up, so its books cannot be moved to another shipment.';
    return '';
  }
  return `An order that is "${status || 'unknown'}" cannot be split.`;
}

/**
 * shipments: [[{ index, qty }, ...], ...] -- one array per NEW shipment, index
 * into the order's current cart. Returns { parentCart, childCarts } or throws.
 */
function planSplit(order, shipments) {
  const cart = parseCart(order.cart_items);
  if (!Array.isArray(shipments) || !shipments.length) throw new Error('Choose the books for at least one new shipment.');
  if (shipments.length > 5) throw new Error('At most 5 new shipments at a time.');
  const left = cart.map(qtyOf);
  const childCarts = shipments.map((lines, s) => {
    const out = [];
    for (const sel of Array.isArray(lines) ? lines : []) {
      const idx = Number(sel && sel.index);
      const qty = Math.floor(Number(sel && sel.qty) || 0);
      if (!Number.isInteger(idx) || !cart[idx]) throw new Error(`Book ${idx + 1} is not in this order.`);
      if (qty <= 0) continue;
      if (qty > left[idx]) throw new Error(`"${cart[idx].title || 'Book'}" has only ${qtyOf(cart[idx])} in the order.`);
      left[idx] -= qty;
      const line = {};
      for (const [k, v] of Object.entries(cart[idx])) if (!ORDER_META.has(k)) line[k] = v;
      line.qty = qty;
      if ('quantity' in line) line.quantity = qty;
      out.push(line);
    }
    if (!out.length) throw new Error(`New shipment ${s + 1} has no books.`);
    return out;
  });
  if (left.every((q) => q === 0)) throw new Error('At least one book must stay in the original order.');

  // The original keeps its lines (reduced), and its order-level metadata rides
  // on whatever line is now first -- _payment holds the partial-COD balance.
  const meta = {};
  for (const [k, v] of Object.entries(cart[0] || {})) if (ORDER_META.has(k)) meta[k] = v;
  const parentCart = [];
  cart.forEach((line, i) => {
    if (left[i] <= 0) return;
    const keep = {};
    for (const [k, v] of Object.entries(line)) if (!ORDER_META.has(k)) keep[k] = v;
    keep.qty = left[i];
    if ('quantity' in keep) keep.quantity = left[i];
    parentCart.push(keep);
  });
  Object.assign(parentCart[0], meta);
  return { parentCart, childCarts };
}

/** <parent>-S<n>, kept within 20 characters by dropping the -CW marker if needed. */
function childIdFor(parentId, n) {
  const id = `${parentId}-S${n}`;
  if (id.length <= MAX_ID) return id;
  const short = `${String(parentId).replace(/^IC-CW-/i, 'IC-')}-S${n}`;
  return short.length <= MAX_ID ? short : `${String(parentId).slice(0, MAX_ID - 3 - String(n).length)}-S${n}`;
}

/**
 * Move counted-stock bookkeeping with the books. moves = the parent's
 * order_stock_moves rows. Returns { parent: [{slug, qty}], children: [[{slug, qty}]] }:
 * what each order now "took", so cancelling either one gives back only its own.
 */
function splitStockMoves(moves, childCarts) {
  const took = new Map();
  for (const m of moves || []) {
    if (!m || m.slug === '*' || m.returned_at) continue;
    took.set(m.slug, (took.get(m.slug) || 0) + Math.max(0, Number(m.qty) || 0));
  }
  const children = childCarts.map((cart) => {
    const mine = new Map();
    for (const line of cart) {
      const slug = lineSlug(line);
      if (!slug || !took.has(slug)) continue;
      const give = Math.min(took.get(slug), qtyOf(line));
      if (give <= 0) continue;
      took.set(slug, took.get(slug) - give);
      mine.set(slug, (mine.get(slug) || 0) + give);
    }
    return [...mine].map(([slug, qty]) => ({ slug, qty }));
  });
  return { parent: [...took].map(([slug, qty]) => ({ slug, qty })), children };
}

/**
 * Customer self-cancel is off for split orders: the original carries the whole
 * payment, so cancelling it would refund books another parcel is still
 * bringing, and a split shipment holds no money of its own to refund.
 */
function splitCancelBlock(order) {
  if (isSplitChild(order)) return `This parcel is part of order ${splitMeta(order)?.of || 'your original order'}, which we are sending in separate parcels. To cancel, please message us on WhatsApp and we'll sort it out.`;
  if (splitChildren(order).length) return `We are sending this order in separate parcels (${splitChildren(order).join(', ')}), so it can't be cancelled here. Please message us on WhatsApp and we'll sort it out.`;
  return '';
}

module.exports = {
  splitCancelBlock,
  UNSHIPPED, BOOKED, parseCart, qtyOf, lineSlug, splitMeta, isSplitChild, splitChildren,
  splitRefusal, planSplit, childIdFor, splitStockMoves,
};
