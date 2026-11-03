/**
 * Fuzzy book lookup for the WhatsApp bot.
 *
 * Given a free-text title from a customer message ("Heartstopper Vol 6",
 * "atomic habits"), returns the best matching book from the catalogue with
 * its title, price, and source ("static" | "custom" | null).
 *
 * Match strategy (deterministic, no external deps):
 *   1. Case-fold + strip punctuation
 *   2. Token overlap score = |query ∩ title| / |query|
 *   3. Boost if all query tokens appear in title (contiguous or not)
 *   4. Prefer the shorter title on ties (more specific match)
 *
 * ALL_BOOKS.json is 6MB — loaded once per cold start into a compact index.
 */

const path = require('path');
const fs   = require('fs');
const { createClient } = require('@supabase/supabase-js');

const STOP_WORDS = new Set([
  'the','a','an','of','and','or','in','on','to','for','by','is','it','my',
  'i','me','with','book','books','novel','edition','vol','volume','part',
]);

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  return normalize(s).split(' ').filter(t => t && !STOP_WORDS.has(t));
}

// ── Static catalogue (ALL_BOOKS.json), loaded once ─────────────────────────
let _static = null;
function getStaticCatalogue() {
  if (_static) return _static;
  try {
    const filePath = path.join(__dirname, '../../../data/ALL_BOOKS.json');
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    _static = raw.map(b => ({
      title:  b.title || '',
      author: b.author || '',
      price:  parseFloat(b.price_inr || 0) || 0,
      slug:   (String(b.url || '').match(/\/product\/([^/?#]+)/) || [])[1] || '',
      source: 'static',
      _titleTokens: tokens(`${b.title} ${b.author}`),
    })).filter(b => b.title && b.price > 0);
    console.log(`[book-lookup] loaded ${_static.length} static books`);
  } catch (e) {
    console.error('[book-lookup] static load failed:', e.message);
    _static = [];
  }
  return _static;
}

// ── Custom products (Supabase), cached for 5 min ───────────────────────────
let _customCache = { rows: null, at: 0 };
async function getCustomProducts() {
  if (_customCache.rows && Date.now() - _customCache.at < 5 * 60_000) return _customCache.rows;
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data } = await supabase
      .from('custom_products')
      .select('slug,title,author,price_inr')
      .eq('is_active', true)
      .limit(2000);
    const rows = (data || []).map(b => ({
      title:  b.title || '',
      author: b.author || '',
      price:  parseFloat(b.price_inr || 0) || 0,
      slug:   b.slug || '',
      source: 'custom',
      _titleTokens: tokens(`${b.title} ${b.author}`),
    })).filter(b => b.title && b.price > 0);
    _customCache = { rows, at: Date.now() };
  } catch (e) {
    console.error('[book-lookup] custom load failed:', e.message);
    _customCache = { rows: _customCache.rows || [], at: Date.now() };
  }
  return _customCache.rows;
}

function scoreMatch(queryTokens, book) {
  if (!queryTokens.length) return 0;
  const titleTokens = new Set(book._titleTokens);
  let hits = 0;
  for (const q of queryTokens) if (titleTokens.has(q)) hits++;
  let score = hits / queryTokens.length;
  // Big boost if every query token is in the title — this is the "confident match" case
  if (hits === queryTokens.length) score += 1;
  // Small tiebreaker: prefer shorter titles (more specific match to what the customer typed)
  score += 1 / (book._titleTokens.length + 5);
  return score;
}

/**
 * Find the best matching book for a free-text title.
 * @returns {Promise<{title,price,slug,source}|null>}
 */
async function lookupBook(rawTitle) {
  const qTokens = tokens(rawTitle);
  if (!qTokens.length) return null;

  const staticBooks = getStaticCatalogue();
  const customBooks = await getCustomProducts();
  const all = [...staticBooks, ...customBooks];

  let best = null;
  let bestScore = 0;
  for (const b of all) {
    const s = scoreMatch(qTokens, b);
    if (s > bestScore) { bestScore = s; best = b; }
  }
  // Threshold: at least half the query tokens must have matched. Otherwise
  // "some random book" would grab a low-quality match and mislead pricing.
  const minAcceptable = 0.5;
  if (!best || bestScore < minAcceptable) return null;
  return { title: best.title, price: best.price, slug: best.slug, source: best.source };
}

// Split a books string into titles on STRUCTURAL separators only — commas,
// semicolons, newlines and bullets. Deliberately NOT " and "/"&"/"+"/"/",
// which occur inside real titles (Pride and Prejudice, wealth & happiness, C++),
// and not "|": customers paste Amazon titles ("System Design Interview Vol 1 &
// Vol 2 Combo Set by Alex Xu | An Insider's Guide … | Complete 2 Books
// Collection" became four cart lines, three priced at the ₹349 guess).
// Also strip a leading list marker ("1. ", "2) ", "- ", "• ") the LLM sometimes
// prepends when it enumerates many books.
function splitBookTitles(raw) {
  return String(raw || '')
    .split(/[,;\n•·]+/)
    .map(s => s.replace(/^\s*(?:\d{1,2}[.)]|[-*])\s+/, '').trim())
    .filter(Boolean);
}

// How many copies one title line asks for. 1 Nov 2026: "Who Moved My Cheese
// ×60" was priced, pushed and stored as ONE copy at ₹139. Only explicit
// markers count — "×2", "x 2", "2x", "* 2", "(2 copies)", "- 3 pcs",
// "qty 3", "2 x …", "3 copies of …" — never a bare number, which is part
// of titles ("Vol 2", "Catch-22", "1984").
const QTY_TAIL = /\s*(?:[x×*]\s*(\d{1,4})|(\d{1,4})\s*[x×]|\(\s*(?:qty\s*[:=]?\s*(\d{1,4})|(\d{1,4})\s*(?:copies|copy|pcs|pieces|nos?))\s*\)|[-–:]?\s*(\d{1,4})\s*(?:copies|copy|pcs|pieces|nos)\.?|[-–(]?\s*qty\s*[:=]?\s*(\d{1,4})\)?)\s*$/i;
const QTY_HEAD = /^\s*(\d{1,4})\s*(?:[x×*]|copies of|copy of|pcs of|nos?\.? of)\s+/i;
function parseQuantity(line) {
  const text = String(line || '').trim();
  let m = text.match(QTY_HEAD);
  if (m) return { title: text.slice(m[0].length).trim(), qty: Math.max(1, Number(m[1]) || 1) };
  m = text.match(QTY_TAIL);
  if (m && m.index > 0) {
    const n = Number(m.slice(1).find(Boolean));
    return { title: text.slice(0, m.index).trim(), qty: Math.max(1, n || 1) };
  }
  return { title: text, qty: 1 };
}

/**
 * Price a customer's comma-separated book list.
 * Missing matches use the fallback per-book price so a payment link can still
 * be generated — the owner sees an "unmatched book" note in their alert.
 * Items line up one-to-one with splitBookTitles(rawBooksList).
 *
 * @param {string} rawBooksList  e.g. "Heartstopper Vol 6, Atomic Habits ×2"
 * @param {number} [fallbackRs]  Per-book fallback price when no match. Default ₹349.
 * @returns {Promise<{
 *   items: Array<{query, title, qty, unitPrice, price, matchedTitle, slug?, matched}>,
 *   subtotalRs, shippingRs, totalRs, totalPaise, copies,
 *   unmatched: string[]
 * }>}  item.price is the line total (unitPrice × qty).
 */
async function priceBooksList(rawBooksList, fallbackRs = 349, deps = {}) {
  const lookup = deps.lookupBook || lookupBook;
  const items = [];
  const unmatched = [];
  for (const q of splitBookTitles(rawBooksList)) {
    const { title, qty } = parseQuantity(q);
    const hit = await lookup(title);
    const unitPrice = hit ? hit.price : fallbackRs;
    items.push(hit
      ? { query: q, title, qty, unitPrice, price: unitPrice * qty, matchedTitle: hit.title, slug: hit.slug, matched: true }
      : { query: q, title, qty, unitPrice, price: unitPrice * qty, matchedTitle: title, matched: false });
    if (!hit) unmatched.push(title);
  }
  const subtotalRs = items.reduce((s, i) => s + i.price, 0);
  // Free shipping from ₹499 — the website's COD rule; bot-order-request lifts
  // it for prepaid orders above ₹399 (utils/free-delivery).
  const shippingRs = subtotalRs >= 499 ? 0 : 40;
  const totalRs    = subtotalRs + shippingRs;
  return {
    items,
    subtotalRs,
    shippingRs,
    totalRs,
    totalPaise: Math.round(totalRs * 100),
    copies: items.reduce((s, i) => s + i.qty, 0),
    unmatched,
  };
}

module.exports = { lookupBook, priceBooksList, splitBookTitles, parseQuantity };
