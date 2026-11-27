/**
 * Warehouse pick (owner, 27 Nov 2026): the books physically on the shelf,
 * entered from photos in the /admin/pick/ app, matched against orders the
 * courier has not picked up yet. An order whose every book is on the shelf is
 * "ready" and its label can be printed; an order with some books on the shelf
 * and others missing is "flagged" with the missing titles, and the owner
 * decides whether to print it anyway.
 *
 * Pure functions only; admin-warehouse.js does the KV and HTTP.
 */

// Languages that make it a different book: "(Hindi) Alchemist" is not "The
// Alchemist". "Roman Urdu" / "Roman English" (Urdu in Latin letters) is one
// edition, folded to "roman" before this list applies, so "urdu" alone means
// the Urdu-script book.
const HARD = ['hindi', 'urdu', 'bengali', 'bangla', 'marathi', 'gujarati', 'tamil', 'telugu', 'kannada', 'malayalam', 'punjabi', 'odia', 'assamese', 'nepali'];
// Words that usually mark an edition but are often left off a spine.
const SOFT = ['roman', 'combo', 'set', 'boxset', 'vol', 'volume', 'part'];
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'for', 'by', 'with', 'from', 'paperback', 'hardcover', 'edition', 'book', 'books', 'novel', 'new', 'latest', 'writer', 'author', 'trending', 'bestseller', 'best', 'seller', 'english', 'box', 'version', 'language']);

/** Lower-case, punctuation-free, "[Paperback] [2020] Author" tails removed. */
function norm(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\[(paperback|hardcover)[^\]]*\]/g, ' ')
    .replace(/\[\d{4}\]/g, ' ')
    .replace(/[|#…]+/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u0900-\u097f\u0600-\u06ff\u0980-\u09ff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The words that identify a book, with language and edition words kept apart. */
function tokens(title) {
  const words = norm(title).replace(/\broman (urdu|english|hindi)\b/g, 'roman').replace(/\b(urdu|english|hindi) roman\b/g, 'roman')
    .split(' ').filter(Boolean);
  const core = words.filter((w) => !STOP.has(w) && !HARD.includes(w) && !SOFT.includes(w) && !/^\d{4}$/.test(w));
  const hard = [...new Set(words.filter((w) => HARD.includes(w)))].map((w) => (w === 'bangla' ? 'bengali' : w)).sort();
  const soft = [...new Set(words.filter((w) => SOFT.includes(w)))].sort();
  return { core: [...new Set(core)], hard, soft };
}

/**
 * 0..1: how sure we are that two titles are the same book. Languages must
 * agree; then the shorter title's words must mostly appear in the longer one,
 * so "Peer e Kamil" matches the full listing name with author and subtitle.
 */
function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.core.length || !B.core.length) return 0;
  if (A.hard.join(' ') !== B.hard.join(' ')) return 0;
  const setB = new Set(B.core);
  const common = A.core.filter((w) => setB.has(w)).length;
  if (!common) return 0;
  const shorter = Math.min(A.core.length, B.core.length);
  const longer = Math.max(A.core.length, B.core.length);
  const cover = common / shorter;          // the short title is inside the long one
  const jac = common / (A.core.length + B.core.length - common);
  // A one-word title ("Rich") must not swallow every long title containing it.
  // It may still be the whole main title: "Ikigai" for "Ikigai: The Japanese…".
  const oneWord = shorter === 1 && longer > 2;
  const main = (t) => tokens(String(t).split(/:| by | - |\(|\[|\|/i)[0]).core;
  const longMain = main(A.core.length >= B.core.length ? a : b);
  const shortPenalty = !oneWord ? 1 : longMain.length === 1 && A.core.includes(longMain[0]) && B.core.includes(longMain[0]) ? 1 : 0.6;
  const softPenalty = A.soft.join(' ') === B.soft.join(' ') ? 1 : 0.92;
  return Math.round(Math.min(1, (0.8 * cover + 0.2 * jac) * shortPenalty * softPenalty) * 1000) / 1000;
}

const MATCH_AT = 0.78;

/** Best known title for a read/typed one, or null below MATCH_AT. */
function bestMatch(title, known) {
  let best = null;
  for (const k of known) {
    const s = similarity(title, k);
    if (s >= MATCH_AT && (!best || s > best.score || (s === best.score && k.length < best.title.length))) best = { title: k, score: s };
  }
  return best;
}

/** Inventory key: the normalised title. */
const keyOf = (title) => norm(title);

/**
 * Add (or set) books. items: [{ title, qty }]. Titles that match a book already
 * on the shelf are merged into it.
 */
function applyToInventory(inventory, items, { mode = 'add', now = new Date().toISOString() } = {}) {
  const inv = { ...(inventory || {}) };
  const changed = [];
  for (const it of items || []) {
    const title = String(it.title || '').replace(/\s+/g, ' ').trim();
    const qty = Math.max(0, Math.round(Number(it.qty) || 0));
    if (!title) continue;
    let key = keyOf(title);
    if (!inv[key]) {
      const near = bestMatch(title, Object.values(inv).map((r) => r.title));
      if (near && near.score >= 0.9) key = keyOf(near.title);
    }
    const prev = inv[key] || { title, qty: 0 };
    const next = mode === 'set' ? qty : prev.qty + qty;
    if (next <= 0) { if (inv[key]) { delete inv[key]; changed.push({ title: prev.title, qty: 0 }); } continue; }
    inv[key] = { title: prev.title || title, qty: next, updated_at: now };
    changed.push({ title: inv[key].title, qty: next });
  }
  return { inventory: inv, changed };
}

/** Which shelf entry, if any, holds this order's book. */
function shelfKeyFor(title, inventory, cache = new Map()) {
  if (cache.has(title)) return cache.get(title);
  let key = null;
  const k = keyOf(title);
  if (inventory[k]) key = k;
  else {
    const near = bestMatch(title, Object.values(inventory).map((r) => r.title));
    if (near) key = keyOf(near.title);
  }
  cache.set(title, key);
  return key;
}

const isDtdc = (c) => /dtdc/i.test(String(c || ''));

/**
 * Hand the shelf out to the waiting orders, oldest first. An order takes its
 * books only when every one is there ("ready"); otherwise nothing is taken
 * and it is "flagged" with what is missing — but only if at least one of its
 * books IS on the shelf, so the 900 other waiting orders stay out of the way.
 *
 * rows: Not Picked Up rows ({ order_id, created_at, items, tracking_id,
 * courier, bucket }). Orders without an AWB have no label to print and are
 * returned apart as "not_booked".
 */
function allocate(rows, inventory, { extracted = {}, skipDtdc = true } = {}) {
  const left = Object.fromEntries(Object.entries(inventory || {}).map(([k, v]) => [k, v.qty]));
  const cache = new Map();
  const ready = [], flagged = [], notBooked = [], skipped = { extracted: 0, dtdc: 0 };
  const sorted = [...(rows || [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  for (const r of sorted) {
    const items = (r.items || []).filter((i) => i.title);
    if (!items.length) continue;
    const need = {};
    const lines = items.map((i) => {
      const key = shelfKeyFor(i.title, inventory || {}, cache);
      if (key) need[key] = (need[key] || 0) + i.qty;
      return { title: i.title, qty: i.qty, key, shelf_title: key ? inventory[key].title : null };
    });
    if (!Object.keys(need).length) continue; // none of its books on the shelf
    if (extracted[r.order_id]) { skipped.extracted++; continue; }
    if (skipDtdc && isDtdc(r.courier)) { skipped.dtdc++; continue; }
    const all = lines.every((l) => l.key) && Object.entries(need).every(([k, q]) => left[k] >= q);
    const out = {
      order_id: r.order_id, created_at: r.created_at, courier: r.courier || '', awb: r.tracking_id || '',
      customer: r.customer_name || '', payment: r.payment || '', age_hours: r.age_hours,
      units: items.reduce((n, i) => n + i.qty, 0), lines,
    };
    if (r.bucket !== 'awaiting_pickup' || !r.tracking_id) {
      out.missing = lines.filter((l) => !l.key || left[l.key] < l.qty).map((l) => ({ title: l.title, qty: l.qty }));
      notBooked.push(out);
      continue;
    }
    if (all) {
      for (const [k, q] of Object.entries(need)) left[k] -= q;
      ready.push(out);
    } else {
      // What is short: not on the shelf at all, or already taken by older orders.
      const pool = { ...left };
      out.missing = [];
      for (const l of lines) {
        if (l.key && pool[l.key] >= l.qty) { pool[l.key] -= l.qty; continue; }
        out.missing.push({ title: l.title, qty: l.qty, reason: l.key ? 'not enough copies' : 'not in the warehouse' });
      }
      flagged.push(out);
    }
  }
  const shelf = Object.entries(inventory || {}).map(([k, v]) => ({
    key: k, title: v.title, qty: v.qty, used: v.qty - (left[k] || 0), left: left[k] || 0, updated_at: v.updated_at,
  })).sort((a, b) => a.title.localeCompare(b.title));
  return { ready, flagged, not_booked: notBooked, shelf, skipped };
}

/** Take printed orders' books off the shelf. Returns the new inventory and what was taken. */
function deduct(inventory, orders) {
  const inv = JSON.parse(JSON.stringify(inventory || {}));
  const taken = {};
  const cache = new Map();
  for (const o of orders || []) {
    for (const l of o.lines || o.items || []) {
      const key = l.key || shelfKeyFor(l.title, inv, cache);
      if (!key || !inv[key]) continue;
      const q = Math.min(inv[key].qty, l.qty || 1);
      if (!q) continue;
      inv[key].qty -= q;
      taken[key] = { title: inv[key].title, qty: ((taken[key] && taken[key].qty) || 0) + q };
      if (inv[key].qty <= 0) delete inv[key];
    }
  }
  return { inventory: inv, taken: Object.values(taken) };
}

module.exports = { norm, tokens, similarity, bestMatch, keyOf, applyToInventory, allocate, deduct, MATCH_AT };
