/**
 * Rebuild an order's cart_items from an admin-typed "Title ×qty" list.
 *
 * Unit prices come from the CATALOGUE — the same lookup the WhatsApp bot
 * prices with. An earlier version divided the order total by the unit count
 * instead, so marking a ₹201 order as "×3" invented a ₹67 book and left the
 * courier collecting ₹201 for three of them. Splitting the total survives
 * only as a last resort, for a title the catalogue cannot match at all.
 *
 * Repricing the basket changes what the courier must collect, so the order
 * total follows — but ONLY where no money has moved yet. On a prepaid or
 * part-paid order the amount is what the customer actually paid and is not
 * ours to rewrite; the caller gets a warning to settle by hand instead.
 *
 * The edit form always sends the books field, prefilled, so an address-only
 * edit arrives here too. A list identical to the saved one is left alone, and
 * a rebuilt line keeps the fields of the line it replaces. Rebuilding from
 * title/qty/price alone once dropped cart_items[0]._payment from a partial-COD
 * order (IC-CW-20261001-Y830C): its ₹395 balance became 0 and the panel push
 * was refused with "amount must be greater than 0".
 */

const SHIPPING_RS = 40;
const FREE_SHIPPING_OVER_RS = 499;

/** Statuses and markers that mean money has already changed hands. */
function isSettled(order) {
  return Boolean(order.razorpay_payment_id)
    || Number(order.advance_paid_paise || 0) > 0
    || ['paid', 'partial_cod_pending', 'refunded', 'partially_refunded']
      .includes(String(order.status || ''));
}

/** cart_items → the "Title ×qty" list the edit form prefills. */
function booksListOf(items) {
  return (Array.isArray(items) ? items : [])
    .map((i) => { const t = String(i?.title || '').trim(); return t && Number(i.qty) > 1 ? `${t} ×${i.qty}` : t; })
    .filter(Boolean)
    .join(', ');
}

const sameList = (a, b) => String(a || '').replace(/\s+/g, ' ').trim().toLowerCase()
  === String(b || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** `"Ikigai ×2, Sapiens"` → `[{title, qty, explicitQty}]` */
function parseBooksList(raw) {
  return String(raw || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^(.*?)\s*[x×✕✖]\s*(\d{1,3})$/i);   // "Title ×3"
      if (m && Number(m[2]) > 0) return { title: m[1].trim(), qty: Number(m[2]), explicitQty: true };
      return { title: part, qty: 1, explicitQty: false };
    })
    .filter((l) => l.title);
}

/**
 * @param {string} raw          the admin's comma-separated list
 * @param {object} order        the order row (cart_items, amount_paise, status, …)
 * @param {Function} lookupBook async (title) => {title, price} | null
 * @returns {Promise<{cartItems, amountPaise: number|null, repriced, warning, unpriced, unchanged}>}
 *   `amountPaise` is null when the total must not be touched. `unchanged`
 *   means the list matches the saved one and cart_items must not be written.
 */
async function rebuildOrderBooks(raw, order, lookupBook) {
  const existing = Array.isArray(order.cart_items) ? order.cart_items : [];
  if (existing.length && sameList(raw, booksListOf(existing))) {
    return { cartItems: existing, amountPaise: null, repriced: null, warning: '', unpriced: [], unchanged: true };
  }
  const parsed = parseBooksList(raw);
  const totalRs = Math.round(Number(order.amount_paise || 0) / 100);
  const totalUnits = parsed.reduce((s, l) => s + l.qty, 0) || 1;
  const perUnit = Math.round(totalRs / totalUnits);

  const unpriced = [];
  const cartItems = [];
  for (const line of parsed) {
    const match = existing.find(
      (i) => String(i.title || '').trim().toLowerCase() === line.title.toLowerCase(),
    );
    const hit = await Promise.resolve(lookupBook(line.title)).catch(() => null);

    // Catalogue first, then the price already on a matching line (a typo fix
    // keeps what the customer was actually charged), then the split.
    let price = Number(hit?.price) > 0 ? Number(hit.price) : 0;
    if (!price && !line.explicitQty && Number(match?.price) > 0) price = Number(match.price);
    if (!price) { price = perUnit; unpriced.push(line.title); }

    // Keep the replaced line's own fields (slug, img, _offer_id, …).
    cartItems.push({
      ...(match || {}),
      title: hit?.title || line.title,
      qty: line.explicitQty ? line.qty : (Number(match?.qty) || 1),
      price,
    });
  }
  // The order's payment terms ride on the first line, whichever book that is.
  const payment = existing[0]?._payment;
  if (payment && cartItems[0] && !cartItems[0]._payment) cartItems[0]._payment = payment;

  const subtotalRs = cartItems.reduce((s, i) => s + i.price * i.qty, 0);
  const newTotalRs = subtotalRs + (subtotalRs >= FREE_SHIPPING_OVER_RS ? 0 : SHIPPING_RS);

  let amountPaise = null;
  let repriced = null;
  let warning = '';

  if (!isSettled(order) && newTotalRs > 0 && newTotalRs !== totalRs) {
    amountPaise = Math.round(newTotalRs * 100);
    repriced = { from: totalRs, to: newTotalRs };
  } else if (isSettled(order) && newTotalRs !== totalRs) {
    warning = `Books repriced to ₹${newTotalRs} from the catalogue, but this order is already paid `
            + `(₹${totalRs}) so the total was left alone. Refund or collect the difference manually.`;
  }
  if (unpriced.length) {
    warning = `${warning ? `${warning} ` : ''}Not found in the catalogue, priced at ₹${perUnit} each: `
            + `${unpriced.join(', ')}.`;
  }

  return { cartItems, amountPaise, repriced, warning, unpriced, unchanged: false };
}

module.exports = { rebuildOrderBooks, parseBooksList, booksListOf, isSettled, SHIPPING_RS, FREE_SHIPPING_OVER_RS };
