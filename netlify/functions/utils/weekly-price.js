/**
 * Weekly price swing (owner, 15 Nov 2026: "price should get lesser
 * automatically either 10 or 20 rupees for books above 299. it should be server
 * side automatic").
 *
 * Every book whose selling price is ₹300 or more sells for ₹10 or ₹20 less than
 * that price. Which of the two is picked per book, from a hash of the slug and
 * the week, so roughly half the books are on each and every book can change
 * every Monday 00:00 IST -- and only then, so Merchant Center sees one change a
 * week, never a flicker.
 *
 * It is the LISTED price, not a coupon: the till (utils/pricing.js), the product
 * pages, the price the page fetches (get-product-overrides), feed.xml and the
 * custom feeds all apply this one rule (worker/index.js does everything but the
 * till). The BASE is always the stored price -- catalogue, admin override or
 * product_settings -- so the cut is never applied twice and an admin edit saves
 * the base. Anything cached keeps the base; the cut is applied on the way out.
 * The MRP is not touched.
 */

const MIN_BASE = 300;          // "books above 299"
const CUTS = [10, 20];
const IST_MS = 330 * 60_000;   // UTC+05:30
const DAY_MS = 86_400_000;

/** Monday (IST) that starts the week holding `now`, as YYYY-MM-DD. */
function weekKey(now = Date.now()) {
  const ist = new Date(Number(now) + IST_MS);
  const sinceMonday = (ist.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - sinceMonday));
  return monday.toISOString().slice(0, 10);
}

/** The next Monday 00:00 IST after `now`, as a UTC Date. */
function nextChangeAt(now = Date.now()) {
  const monday = Date.parse(`${weekKey(now)}T00:00:00Z`) - IST_MS;
  return new Date(monday + 7 * DAY_MS);
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Avalanche (murmur3 fmix32). FNV-1a's low bit is only the parity of the
  // characters' low bits, so on its own the pick never moved week to week.
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function normSlug(slug) {
  let s = String(slug || '').trim();
  try { s = decodeURIComponent(s); } catch { /* keep as is */ }
  return s.replace(/^\/?product\//i, '').replace(/\/+$/, '').toLowerCase();
}

/** ₹10 or ₹20 for this book this week (0 without a slug). */
function cutFor(slug, now = Date.now()) {
  const s = normSlug(slug);
  if (!s) return 0;
  return CUTS[(fnv1a(`${s}|${weekKey(now)}`) >>> 16) % CUTS.length];
}

/** The price a book sells for this week, from its stored (base) price. */
function weeklyPrice(slug, base, now = Date.now()) {
  const n = Number(base);
  if (!Number.isFinite(n) || n < MIN_BASE) return base;
  const cut = cutFor(slug, now);
  return cut ? n - cut : base;
}

// ── Response rewriters (pure; the Worker streams pages through them) ─────────

/** "499.0" -> "479.0", "499" -> "479": keeps the number's own spelling. */
function swapNumber(text, slug, now) {
  const n = Number(text);
  const p = weeklyPrice(slug, n, now);
  if (p === n) return text;
  const dec = /\.(\d+)$/.exec(text);
  return dec ? p.toFixed(dec[1].length) : String(p);
}

/** One product's JSON-LD: every Offer "price", and the FAQ's "… on inkandchai.in for ₹369". */
function patchJsonLdPrices(json, slug, now = Date.now()) {
  return String(json)
    .replace(/("price"\s*:\s*"?)(\d+(?:\.\d+)?)/g, (m, head, num) => head + swapNumber(num, slug, now))
    .replace(/(inkandchai\.in for ₹\s?)(\d+)/g, (m, head, num) => head + swapNumber(num, slug, now));
}

/** <title> / og:title: "Buy Online @ ₹369 |" and "| ₹369 |". Other ₹ amounts (₹499+ free delivery) stay. */
function patchTitlePrice(text, slug, now = Date.now()) {
  return String(text).replace(/(@\s*₹\s?|\|\s*₹\s?)(\d+)(?=\s*(?:\||$))/g, (m, head, num) => head + swapNumber(num, slug, now));
}

/** The inline `currentItem = {...}` script: its first "price" only. */
function patchCurrentItem(script, slug, now = Date.now()) {
  return String(script).replace(/(currentItem\s*=\s*\{[^\n]*?"price"\s*:\s*)(\d+(?:\.\d+)?)/, (m, head, num) => head + swapNumber(num, slug, now));
}

/** "₹ 499" / "₹499" -> same spelling at the weekly price. */
function priceText(n) {
  return `₹ ${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

/**
 * A Merchant Center feed (feed.xml, custom-feed.xml, custom-feed-bulk). The
 * selling price is <g:sale_price> when the item has one (the custom feeds put
 * the MRP in <g:price> then), else <g:price>. The slug is read from <g:link>.
 */
function patchFeedXml(xml, now = Date.now()) {
  let changed = 0;
  const out = String(xml).replace(/<item>[\s\S]*?<\/item>/g, (item) => {
    const link = /<g:link>[^<]*?\/product\/([^/<]+)\/?<\/g:link>/.exec(item);
    if (!link) return item;
    const slug = link[1];
    const tag = /<g:sale_price>/.test(item) ? 'g:sale_price' : 'g:price';
    const re = new RegExp(`(<${tag}>)(\\d+(?:\\.\\d+)?)(\\s*INR</${tag}>)`);
    return item.replace(re, (m, open, num, close) => {
      const next = swapNumber(num, slug, now);
      if (next !== num) changed++;
      return open + next + close;
    });
  });
  return { xml: out, changed };
}

/** get-product-overrides JSON: overrides[] and customProducts[] price_inr. */
function patchOverridesJson(doc, now = Date.now()) {
  if (!doc || typeof doc !== 'object') return doc;
  const fix = (row) => {
    if (!row || row.price_inr === null || row.price_inr === undefined || row.price_inr === '') return row;
    const base = Number(row.price_inr);
    const p = weeklyPrice(row.slug, base, now);
    return p === base ? row : { ...row, price_inr: p };
  };
  const out = { ...doc };
  if (Array.isArray(doc.overrides)) out.overrides = doc.overrides.map(fix);
  for (const k of ['customProducts', 'custom_products', 'products']) {
    if (Array.isArray(doc[k])) out[k] = doc[k].map(fix);
  }
  return out;
}

module.exports = {
  MIN_BASE, CUTS,
  weekKey, nextChangeAt, cutFor, weeklyPrice, normSlug,
  swapNumber, patchJsonLdPrices, patchTitlePrice, patchCurrentItem, priceText, patchFeedXml, patchOverridesJson,
};
