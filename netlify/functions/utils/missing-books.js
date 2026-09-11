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

function isMissingBookReplacement(order) {
  const meta = replacementMeta(order);
  if (!meta) return false;
  return MISSING_BOOK_REASONS.has(String(meta.reason || '').toLowerCase());
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

module.exports = {
  MISSING_BOOK_REASONS,
  itemTitleKey,
  replacementCovers,
  refundSplitPaise,
  replacementMeta,
  isReplacementOrder,
  isMissingBookReplacement,
  missingValuePaise,
};
