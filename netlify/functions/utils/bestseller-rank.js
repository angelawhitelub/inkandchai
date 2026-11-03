'use strict';

/**
 * Best Sellers Rank, Amazon-style (owner's request, 29 Oct 2026): every book
 * that has actually sold gets "#12 in Books" and "#3 in Romance", from real
 * orders only.
 *
 * Built hourly by lifetime-sales-scheduled alongside the lifetime counts and
 * published inside the same KV document (doc.bsr), so the Worker reads one key:
 *   - product pages: a "Best Sellers Rank" row in the Details table, and a
 *     "#1 Best Seller" badge on a book that tops its shelf;
 *   - /bestsellers/: the live Top 100, overall or per shelf (?shelf=romance).
 *
 * The order: units sold in the last WINDOW_DAYS days (recent sales move a
 * book, like Amazon's), then lifetime units, then slug so a tie is stable.
 * A book with no sale ever has no rank. Deleted listings are left out.
 *
 * Shelves group the catalogue's many raw categories ("Romance (On Sale)",
 * "All Romance Books", "Colleen Hoover Special"...) into the ones a reader
 * means. A category that is not a genre ("Preloved Books", "New Arrivals",
 * "Boxsets", combos of two genres) has no shelf: the book ranks in Books only.
 */

const crypto = require('crypto');

const WINDOW_DAYS = 30;
// Where the baked pages' catalogue covers live: generate_site.py
// public_image_url() names each one <sha256(source url)[:24]>-<width>.webp
// under IMAGE_CDN_BASE. Cart lines can carry the original Shopify URLs, which
// Shopify deleted in Oct 2026, so the ranked cards use these copies instead.
const CATALOGUE_COVER_BASE = 'https://pub-e82e9bd0c7bd4d1eb2de92eb40d0dc33.r2.dev';

/** The baked 400px R2 copy of a catalogue cover URL, or '' for a non-http value. */
function catalogueCover(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//.test(u)) return '';
  return `${CATALOGUE_COVER_BASE}/${crypto.createHash('sha256').update(u, 'utf8').digest('hex').slice(0, 24)}-400.webp`;
}
const TOP_N = 100;
const SHELF_TOP_N = 50;

// First match wins, so the specific shelves come before Fiction.
const SHELVES = [
  ['romance', 'Romance', /romance|colleen hoover|ana huang/],
  ['self-help', 'Self-Help', /self[\s-]?help/],
  ['business', 'Business & Finance', /business|finance|trading|invest/],
  ['hindi', 'Hindi Books', /hindi/],
  ['indian-languages', 'Indian Language Books', /bengali|tamil|marathi|gujarati|telugu|kannada|malayalam|urdu|other lang/],
  ['manga', 'Manga', /manga/],
  ['comics', 'Comics', /comic/],
  ['kids', "Children's Books", /kid|child|board book|age:/],
  ['mythology', 'Mythology & Spirituality', /myth|spiritual/],
  ['biography', 'Biographies', /biograph|memoir/],
  ['non-fiction', 'Non-Fiction', /non[\s-]?fiction/],
  ['fiction', 'Fiction', /fiction|novel|thriller|mystery|classic|fantasy/],
];
const SHELF_LABEL = Object.fromEntries(SHELVES.map(([k, l]) => [k, l]));

/** The shelf key for a raw category, or '' when it names no genre (combos span two). */
function shelfOf(category) {
  const c = String(category || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!c || /combo/.test(c)) return '';
  for (const [key, , re] of SHELVES) if (re.test(c)) return key;
  return '';
}

/**
 * Rank every book with a sale.
 * @param {{ lifetime: object, recent: object, shelfFor: (slug) => string, exclude?: Set<string> }} o
 *   lifetime / recent: { slug: units } (recent = the last WINDOW_DAYS days)
 * @returns {{ ranks: { slug: [rank, shelf, shelfRank] }, order: string[], shelves: { key: label } }}
 */
function computeRanks({ lifetime = {}, recent = {}, shelfFor = () => '', exclude = new Set() }) {
  const slugs = Object.keys(lifetime).filter((s) => Number(lifetime[s]) > 0 && !exclude.has(s));
  slugs.sort((a, b) => (Number(recent[b]) || 0) - (Number(recent[a]) || 0)
    || (Number(lifetime[b]) || 0) - (Number(lifetime[a]) || 0)
    || a.localeCompare(b));
  const ranks = {};
  const perShelf = {};
  const shelves = {};
  slugs.forEach((slug, i) => {
    const shelf = shelfFor(slug) || '';
    let shelfRank = 0;
    if (shelf && SHELF_LABEL[shelf]) {
      shelfRank = perShelf[shelf] = (perShelf[shelf] || 0) + 1;
      shelves[shelf] = SHELF_LABEL[shelf];
    }
    ranks[slug] = [i + 1, shelfRank ? shelf : '', shelfRank];
  });
  return { ranks, order: slugs, shelves };
}

/** The slugs a page lists: the overall Top 100 and each shelf's top 50. */
function listedSlugs({ ranks, order }) {
  const out = new Set(order.slice(0, TOP_N));
  for (const slug of order) {
    const r = ranks[slug];
    if (r && r[1] && r[2] <= SHELF_TOP_N) out.add(slug);
  }
  return out;
}

/** { rank, shelf, shelfLabel, shelfRank } for a slug, or null. */
function rankOf(bsr, slug) {
  const r = bsr && bsr.ranks && bsr.ranks[String(slug || '').toLowerCase()];
  if (!r) return null;
  return { rank: r[0], shelf: r[1] || '', shelfLabel: SHELF_LABEL[r[1]] || '', shelfRank: r[2] || 0 };
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n).toLocaleString('en-IN');

/** The Details-table row: "#12 in Books (See Top 100) / #3 in Romance". */
function rankRowHtml(r) {
  if (!r) return '';
  const lines = [`#${num(r.rank)} in Books (<a href="/bestsellers/" style="color:inherit;text-decoration:underline;">See Top 100 in Books</a>)`];
  if (r.shelf) lines.push(`#${num(r.shelfRank)} in <a href="/bestsellers/?shelf=${encodeURIComponent(r.shelf)}" style="color:inherit;text-decoration:underline;">${esc(r.shelfLabel)}</a>`);
  return `<dt>Best Sellers Rank</dt><dd class="bsr">${lines.join('<br/>')}</dd>`;
}

/** "#1 Best Seller in Romance" under the stock line, for a shelf's (or the store's) top book. */
function badgeHtml(r) {
  if (!r) return '';
  let where = '';
  let href = '/bestsellers/';
  if (r.shelf && r.shelfRank === 1) { where = r.shelfLabel; href += `?shelf=${encodeURIComponent(r.shelf)}`; }
  else if (r.rank === 1) where = 'Books';
  if (!where) return '';
  return `<a class="bsr-badge" href="${href}" style="display:inline-flex;align-items:center;gap:.4rem;margin:.35rem .4rem .2rem 0;text-decoration:none;font-size:.82rem;line-height:1.2;">`
    + `<span style="background:#c45500;color:#fff;font-weight:700;padding:.22rem .55rem;border-radius:3px 0 0 3px;">#1 Best Seller</span>`
    + `<span style="color:inherit;">in ${esc(where)}</span></a>`;
}

/** The /bestsellers/ grid: ranked cards, plus the shelf chips that go above it. */
function pageParts(bsr, shelf) {
  const info = (bsr && bsr.info) || {};
  const order = (bsr && bsr.order) || [];
  const shelves = (bsr && bsr.shelves) || {};
  const wanted = shelf && shelves[shelf] ? shelf : '';
  const rows = [];
  for (const slug of order) {
    const r = bsr.ranks[slug];
    if (!r || !info[slug]) continue;
    if (wanted ? r[1] !== wanted : r[0] > TOP_N) continue;
    rows.push({ slug, rank: wanted ? r[2] : r[0], ...info[slug] });
    if (rows.length >= (wanted ? SHELF_TOP_N : TOP_N)) break;
  }
  const cards = rows.map((b) => `
      <a class="card bsr-card" href="/product/${encodeURIComponent(b.slug)}/">
        <span class="cover" style="position:relative;">${b.img ? `<img src="${esc(b.img)}" alt="${esc(b.title)} cover" loading="lazy"/>` : ''}<b class="bsr-num" style="position:absolute;top:.4rem;left:.4rem;background:#c45500;color:#fff;font:700 .8rem/1 Arial,sans-serif;padding:.3rem .45rem;border-radius:3px;">#${b.rank}</b></span>
        <strong>${esc(b.title)}</strong>
        ${b.author ? `<small>${esc(b.author)}</small>` : ''}
      </a>`).join('');
  const chip = (key, label) => `<a href="/bestsellers/${key ? `?shelf=${encodeURIComponent(key)}` : ''}" style="display:inline-block;padding:.45rem .9rem;border:1px solid ${key === wanted ? 'var(--gold)' : 'var(--border)'};color:${key === wanted ? 'var(--gold)' : 'var(--muted)'};font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;">${esc(label)}</a>`;
  const chips = `<nav class="bsr-shelves" aria-label="Best sellers by shelf" style="display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1.6rem;">`
    + chip('', 'All books')
    + SHELVES.filter(([k]) => shelves[k]).map(([k, l]) => chip(k, l)).join('')
    + `</nav>`;
  const heading = wanted ? `Best Sellers in ${shelves[wanted]}` : 'Best Sellers in Books';
  const intro = `Our most popular books, ranked by real orders on Ink &amp; Chai — what readers bought in the last ${WINDOW_DAYS} days counts most. Updated every hour.`;
  return { cards, chips, heading, intro, count: rows.length, shelf: wanted };
}

module.exports = {
  shelfOf, computeRanks, listedSlugs, catalogueCover, rankOf, rankRowHtml, badgeHtml, pageParts,
  SHELVES, SHELF_LABEL, WINDOW_DAYS, TOP_N, SHELF_TOP_N,
};
