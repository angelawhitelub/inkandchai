/**
 * How heavy is this parcel, judged from what is in the cart.
 *
 * WHY TITLES AND NOT A WEIGHT FIELD
 * ---------------------------------
 * There is no weight anywhere in the system. nimbuspost-ship.js `estimateDims`
 * returns a flat 400 g for every shipment "regardless of qty or product mix",
 * and that number is what gets sent to the courier. So the only evidence that a
 * parcel was heavier than a single paperback is the product itself: bundles are
 * sold as ONE cart line whose title says so -- "Atomic Habits + Ikigai",
 * "Set of 5 Books", "Combo of 3".
 *
 * A single book runs ~200-300 g and bills in the courier's base slab. Two or
 * more crosses ~500 g into the next slab, and both legs of an RTO are billed at
 * that heavier rate. Refunding a bundle as though it shipped in the base slab
 * hands back money we were actually charged.
 *
 * DELIBERATELY CONSERVATIVE
 * -------------------------
 * A wrong "heavy" verdict takes money off a real customer's refund, so every
 * rule here needs positive evidence of more than one book. Anything ambiguous
 * stays `standard`. The admin can override the final figure by hand on the row,
 * which is the backstop for whatever this gets wrong.
 */

'use strict';

// Word-boundary anchored so "Boxsetting" or a title merely containing "pack"
// cannot trip them. Each carries the count it implies, when it implies one.
const COUNT_PATTERNS = [
  /\bset\s+of\s+(\d{1,2})\b/i,
  /\bcombo\s+of\s+(\d{1,2})\b/i,
  /\bpack\s+of\s+(\d{1,2})\b/i,
  /\bcollection\s+of\s+(\d{1,2})\b/i,
  /\b(\d{1,2})\s*[-\s]?books?\s+(?:combo|set|collection|pack|boxset|box\s?set)\b/i,
  /\bcombo\s+(?:of\s+)?(\d{1,2})\s+books?\b/i,
];

// Phrases that prove a bundle without naming a number.
const BUNDLE_WORDS = [
  { re: /\bbox\s?set\b/i,        label: 'boxset' },
  { re: /\bcombo\b/i,            label: 'combo' },
  { re: /\bset\s+of\b/i,         label: 'set of' },
  { re: /\bpack\s+of\b/i,        label: 'pack of' },
  { re: /\bcomplete\s+(?:set|series|collection)\b/i, label: 'complete set' },
  { re: /\bbundle\b/i,           label: 'bundle' },
];

const qtyOf = (item) => Math.max(1, Math.round(Number(item?.qty ?? item?.quantity ?? 1)) || 1);

/**
 * How many books one cart line's title describes.
 * Returns { books, reason } — books is 1 when the title shows no evidence of more.
 */
function booksInTitle(rawTitle) {
  const title = String(rawTitle || '').trim();
  if (!title) return { books: 1, reason: '' };

  // An explicit count always wins: "Set of 5 Books" is 5, not "a bundle".
  for (const re of COUNT_PATTERNS) {
    const m = title.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 2 && n <= 20) return { books: n, reason: m[0].trim().toLowerCase() };
    }
  }

  // "A + B + C" is the owner's own convention for a multi-book listing. Count
  // the separators rather than trusting a bundle word that may not be present.
  // The separator must be SPACED on both sides. Accepting " +" or "+ " on its
  // own turned "A+ Certification Guide" into a two-book bundle, and a spaced
  // plus is what the owner actually types anyway. "C++" is left alone for free.
  const plusParts = title.split(/\s+\+\s+/).map(s => s.trim()).filter(Boolean);
  if (plusParts.length >= 2) {
    return { books: Math.min(plusParts.length, 20), reason: `${plusParts.length} titles joined by "+"` };
  }

  // A bundle word with no number: we know it is more than one, not how many.
  for (const { re, label } of BUNDLE_WORDS) {
    if (re.test(title)) return { books: 2, reason: label };
  }

  return { books: 1, reason: '' };
}

/**
 * Classify a whole order's parcel.
 *
 * @param {Array} cartItems  parsed cart_items
 * @param {object} opts      { heavyAtBooks = 2 }
 * @returns {{tier:'standard'|'heavy', books:number, reason:string}}
 */
function parcelTier(cartItems, opts = {}) {
  const heavyAtBooks = Math.max(2, Number(opts.heavyAtBooks) || 2);
  const items = Array.isArray(cartItems) ? cartItems : [];
  if (!items.length) return { tier: 'standard', books: 0, reason: 'no cart items recorded' };

  let books = 0;
  const reasons = [];
  for (const item of items) {
    const qty = qtyOf(item);
    const { books: per, reason } = booksInTitle(item?.title);
    books += per * qty;
    if (reason) reasons.push(qty > 1 ? `${reason} ×${qty}` : reason);
    else if (qty > 1) reasons.push(`${String(item?.title || 'item').slice(0, 40)} ×${qty}`);
  }

  // Several separate lines is its own evidence: three single books in one
  // parcel weigh the same as a three-book combo.
  if (!reasons.length && items.length > 1) reasons.push(`${items.length} separate items`);

  const tier = books >= heavyAtBooks ? 'heavy' : 'standard';
  return { tier, books, reason: reasons.join(', ') };
}

module.exports = { parcelTier, booksInTitle, COUNT_PATTERNS, BUNDLE_WORDS };
