'use strict';

/**
 * Shared definition of "this replacement exists because a book did not arrive".
 *
 * Replacements live in `orders` (source 'replacement', ~0, status
 * replacement_pending) with a `_replacement` blob on the first cart item naming
 * the original order and the reason. Two of the six reasons mean books are
 * missing from what the customer paid for:
 *
 *   missing_item    an item missing from the package
 *   incomplete_set  a combo arrived partial
 *
 * `missing_pages` is deliberately NOT one of them -- that is a printing defect
 * in a book the customer does hold, so cancelling its replacement is not a
 * "we owe you money for a book you never got" situation.
 *
 * This matters because when such a replacement is CANCELLED the customer has
 * paid for books they will now never receive, so a refund is owed. On a prepaid
 * order the gateway can send it back. On a COD order nobody paid us online, so
 * the money has to be pushed to a UPI handle the customer gives us -- which is
 * what the refund-UPI request flow is for.
 */

const MISSING_BOOK_REASONS = new Set(['missing_item', 'incomplete_set']);

/** The `_replacement` blob, wherever in the cart it was written. */
function replacementMeta(order) {
  const items = Array.isArray(order && order.cart_items) ? order.cart_items : [];
  for (const item of items) {
    if (item && item._replacement) return item._replacement;
  }
  return null;
}

function isReplacementOrder(order) {
  return String(order && order.source || '').toLowerCase() === 'replacement' || !!replacementMeta(order);
}

/**
 * Titles the customer reported as never having arrived, read off the ORIGINAL
 * order. `_missing` is stamped in exactly one place -- report-missing-books.js,
 * the customer's own report -- and replacement carts are built with the flag
 * stripped, so a stamp is always a first-hand claim about the original parcel
 * and never an artefact copied into a replacement.
 */
function reportedMissingTitles(original) {
  const items = Array.isArray(original && original.cart_items) ? original.cart_items : [];
  const titles = new Set();
  for (const item of items) {
    if (item && item._missing === true) {
      const key = itemTitleKey(item);
      if (key) titles.add(key);
    }
  }
  return titles;
}

/**
 * Is this replacement about books that never arrived?
 *
 * The reason alone used to decide this, which made the answer depend on a label
 * chosen in a dropdown. Raise the replacement for a reported-missing book but
 * tag it "damaged", "wrong_item" or "other" and it stopped being a missing-book
 * replacement -- so the refund flows below rejected it, and the admin panel
 * showed it nowhere while still counting it as covering the report. The book
 * fell out of both halves and the money owed for it stopped being tracked.
 *
 * So the customer's own report is the second, authoritative route in: if the
 * original order says a title never arrived and this replacement carries that
 * title, it qualifies whatever the dropdown said.
 *
 * This does NOT widen the reasons themselves. A damaged or missing_pages
 * replacement for a book the customer actually holds has no `_missing` stamp
 * behind it and still returns false, which is the distinction the reason set
 * was drawn to make. `original` is optional: called with one argument this
 * behaves exactly as it always did.
 */
function isMissingBookReplacement(order, original = null) {
  const meta = replacementMeta(order);
  if (!meta) return false;
  if (MISSING_BOOK_REASONS.has(String(meta.reason || '').toLowerCase())) return true;

  const reported = reportedMissingTitles(original);
  if (!reported.size) return false;
  const items = Array.isArray(order && order.cart_items) ? order.cart_items : [];
  return items.some(item => reported.has(itemTitleKey(item)));
}

/**
 * What the missing books were worth, in paise.
 *
 * A replacement's amount_paise is 0 -- it ships free -- so the sum that matters
 * is the per-line value the cart carried over from the original order.
 */
function missingValuePaise(order) {
  const items = Array.isArray(order && order.cart_items) ? order.cart_items : [];
  let rupees = 0;
  for (const item of items) {
    const price = Number(item && item.price);
    const qtyRaw = Number(item && item.qty);
    const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
    if (Number.isFinite(price) && price > 0) rupees += price * qty;
  }
  return Math.round(rupees * 100);
}

/**
 * How the money owed for the missing books can actually get back.
 *
 * A gateway can only return what it captured, so this splits the amount owed
 * into the part a refund API can send and the part that has to be pushed to a
 * UPI handle by hand. Pure COD captures nothing online, so the whole amount
 * falls to UPI; a partial-COD order captured only the 10% deposit, so anything
 * above that does too.
 *
 * This is an upper bound on what the gateway can do, not a promise: it does not
 * know about refunds already issued against the same payment. The admin panel
 * shows the split and the person sending the email confirms the number.
 */
function refundSplitPaise(replacement, original) {
  const owed = missingValuePaise(replacement);
  const payId = String((original && original.razorpay_payment_id) || '').trim();
  const captured = Number(original && original.amount_paise) || 0;
  const gateway = payId ? Math.max(0, Math.min(captured, owed)) : 0;
  return { owedPaise: owed, gatewayPaise: gateway, upiPaise: Math.max(0, owed - gateway) };
}

/**
 * Title is the only thing an order line and a replacement cart line share. The
 * replacement is rebuilt from the original's item, so slug and price survive,
 * but nothing carries an id to join on.
 */
function itemTitleKey(item) {
  return String((item && (item.title || item.name)) || '').trim().toLowerCase();
}

/**
 * Does this replacement actually carry every one of `items`?
 *
 * Only one replacement is allowed per order. That rule says nothing about WHAT
 * is in it, so the replacement on file may be for a damaged book, or for the
 * one title reported last month -- and a book reported missing today may be in
 * no parcel at all. Anywhere we are about to tell a customer "a replacement is
 * on its way", this is the question that has to be true first.
 *
 * An empty `items` list is vacuously covered; a replacement with no cart covers
 * nothing.
 */
function replacementCovers(replacement, items) {
  const inCart = new Set(
    (Array.isArray(replacement && replacement.cart_items) ? replacement.cart_items : [])
      .map(itemTitleKey)
      .filter(Boolean)
  );
  return (Array.isArray(items) ? items : []).every(it => {
    const key = itemTitleKey(it);
    return !!key && inCart.has(key);
  });
}

// Original-order states a gateway refund can be sent against -- the same list
// razorpay-refund.js and phonepe-refund.js enforce, minus the ones that mean a
// refund is already in flight or done (handled separately below).
const GATEWAY_REFUNDABLE = new Set(['paid', 'confirmed', 'shipped', 'out_for_delivery', 'delivered',
  'cancelled', 'rto', 'undelivered', 'lost']);
const PRIOR_REFUND_STATUSES = new Set(['refunded', 'partially_refunded', 'refund_pending', 'refund_failed']);

function isPartialCodOrder(order) {
  const items = Array.isArray(order && order.cart_items) ? order.cart_items : [];
  const status = String(order && order.status || '').toLowerCase();
  return items.some(i => i && i._payment && i._payment.mode === 'partial_cod') || status === 'partial_cod_pending';
}

/**
 * The UPI ID a COD customer typed into the missing-book form. It is stamped on
 * the ORIGINAL order's reported lines (`_refund_upi_id`), and reaches the
 * replacement only when the form created it; one raised from the panel starts
 * without it. Read from both so nobody is asked for a UPI ID they already gave.
 */
function reportedUpiId(original) {
  const items = Array.isArray(original && original.cart_items) ? original.cart_items : [];
  const hit = items.find((i) => i && String(i._refund_upi_id || '').trim());
  return hit ? String(hit._refund_upi_id).trim() : '';
}

/** "How to Win Friends ×1" lines for the refund notification, amounts in rupees. */
function refundItemsFor(replacement) {
  return (Array.isArray(replacement && replacement.cart_items) ? replacement.cart_items : [])
    .map((item) => {
      const qtyRaw = Number(item && item.qty);
      const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
      const price = Number(item && item.price);
      return {
        title: String((item && (item.title || item.name)) || '').trim(),
        qty,
        amount: Number.isFinite(price) && price > 0 ? Math.round(price * qty) : 0,
      };
    })
    .filter(i => i.title);
}

/**
 * What cancelling this replacement should do about money. Pure: every input is
 * a row already read, so the whole decision is testable and the endpoint only
 * carries it out.
 *
 *   gateway  refund `amountPaise` on the ORIGINAL order via `gateway`
 *   upi      nothing was paid online (COD); the customer needs asking for a UPI id
 *   manual   a refund is owed but something makes an automatic one unsafe --
 *            `reason` says what, and a person decides
 *   none     nothing is owed (not a missing-book replacement, or already settled)
 *
 * It refuses to automate whenever a second refund is possible. The one that
 * matters: the original already has ANY refund on record. That refund may well
 * have been for these very books (an admin refunding by hand from the original
 * order, then cancelling the replacement), and nothing on the row says which
 * books it covered reliably enough to subtract. PhonePe would also refuse a
 * second partial on the same order.
 */
function replacementRefundPlan(replacement, original) {
  const meta = replacementMeta(replacement);
  if (!meta || !isMissingBookReplacement(replacement, original)) {
    return { action: 'none', reason: 'Not a missing-book replacement, so no money is owed when it is cancelled.' };
  }
  if (meta.refund_issued_at) {
    return { action: 'none', reason: `Already refunded ₹${(Number(meta.refund_amount_paise || 0) / 100).toFixed(2)} on ${String(meta.refund_issued_at).slice(0, 10)}${meta.refund_ref ? ` (ref ${meta.refund_ref})` : ''}.` };
  }
  if (meta.refund_paid_at) {
    return { action: 'none', reason: 'Already paid out by UPI.' };
  }

  const amountPaise = missingValuePaise(replacement);
  const items = refundItemsFor(replacement);
  const base = { amountPaise, items, originalId: String(meta.original_order_id || '') };
  if (!(amountPaise > 0)) {
    return { ...base, action: 'manual', reason: 'The replacement has no book prices recorded, so the refund amount cannot be worked out.' };
  }
  if (meta.refund_claimed_at) {
    return { ...base, action: 'manual', reason: `An automatic refund was started on ${String(meta.refund_claimed_at).slice(0, 16).replace('T', ' ')} and did not confirm. Check the gateway before refunding again.` };
  }
  if (!original) {
    return { ...base, action: 'manual', reason: `Original order ${base.originalId || '(unknown)'} was not found.` };
  }

  const payId = String(original.razorpay_payment_id || '').trim();
  if (!payId) return { ...base, action: 'upi', reason: 'The original order was cash on delivery, so there is no online payment to refund.' };
  if (isPartialCodOrder(original)) {
    return { ...base, action: 'manual', reason: 'The original was partial COD — the gateway only holds the deposit, so part of this must go by UPI.' };
  }

  const status = String(original.status || '').toLowerCase();
  const priorRef = original.refund_utr || original.phonepe_refund_id || original.refund_id || '';
  if (PRIOR_REFUND_STATUSES.has(status) || priorRef || original.refund_state) {
    return { ...base, action: 'manual', reason: `Order ${base.originalId} already has a refund on record (${status}${priorRef ? `, ref ${priorRef}` : ''}). Check whether it already covered these books before sending another.` };
  }
  if (!GATEWAY_REFUNDABLE.has(status)) {
    return { ...base, action: 'manual', reason: `Order ${base.originalId} is "${status}", which the gateway refund does not accept.` };
  }
  const captured = Number(original.amount_paise) || 0;
  if (amountPaise > captured) {
    return { ...base, action: 'manual', reason: `The books (₹${(amountPaise / 100).toFixed(2)}) are worth more than was paid on ${base.originalId} (₹${(captured / 100).toFixed(2)}).` };
  }
  return { ...base, action: 'gateway', gateway: payId.startsWith('pay_') ? 'razorpay' : 'phonepe', paymentId: payId };
}

/**
 * Has the replacement's parcel been stopped? Refunding a book that is still on
 * its way pays the customer for something they are about to receive.
 *
 *   courier  what cancelCourierShipment said about its AWB (null if it had none)
 *   nimbus   what cancelNimbusOrder / cancelNimbusShipment said (null if not tried)
 *
 * → { stopped: true } | { stopped: false, reason } (definitely still live) |
 *   { stopped: 'unknown', reason } (sitting in a courier panel we cannot
 *   check -- a person has to confirm it is cancelled there)
 */
function shipmentStopState(replacement, { courier = null, nimbus = null } = {}) {
  const awb = String(replacement && replacement.tracking_id || '').trim();
  const nimbusOk = !!(nimbus && nimbus.ok);
  if (awb) {
    const action = courier && courier.action;
    if (action === 'cancelled' || action === 'already_cancelled' || nimbusOk) return { stopped: true };
    if (action === 'moving') return { stopped: false, reason: courier.message || `Shipment ${awb} is already moving.` };
    return { stopped: false, reason: (courier && courier.message) || (nimbus && nimbus.error) || `Shipment ${awb} could not be cancelled.` };
  }
  if (replacement && replacement.nimbus_pushed_at) {
    return nimbusOk ? { stopped: true }
      : { stopped: 'unknown', reason: `It was pushed to NimbusPost and could not be cancelled there (${(nimbus && nimbus.error) || 'no answer'}).` };
  }
  if (replacement && replacement.ithink_pushed_at) {
    return { stopped: 'unknown', reason: 'It was pushed to the iThink panel, which cannot be checked from here.' };
  }
  if (replacement && replacement.xpressbees_feed_at) {
    return { stopped: 'unknown', reason: 'It was sent to the XpressBees panel, which cannot be checked from here.' };
  }
  return { stopped: true };
}

module.exports = {
  MISSING_BOOK_REASONS,
  itemTitleKey,
  replacementCovers,
  refundSplitPaise,
  replacementMeta,
  isReplacementOrder,
  isMissingBookReplacement,
  reportedMissingTitles,
  missingValuePaise,
  replacementRefundPlan,
  shipmentStopState,
  refundItemsFor,
  isPartialCodOrder,
  reportedUpiId,
};
