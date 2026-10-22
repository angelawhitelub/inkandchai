'use strict';

/**
 * Admin-created books on the New Arrivals pages.
 *
 * /new-arrivals/ and /new-arrivals-2026/ are baked by generate_site.py from
 * ALL_BOOKS.json ("n": 1), so a book created in the admin (custom_products)
 * never appeared there -- the newest books were missing from the page named
 * after them. The Worker now puts the newest admin-created books first
 * (worker/index.js → new-arrivals-custom), in each page's own card markup.
 */

const { displayTitle } = require('./listing-title');
const { proxifySupabaseImage } = require('./supabase-img');

const LIMIT = 24;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const rupees = (n) => `₹ ${Math.round(Number(n)).toLocaleString('en-IN')}`;

/** Newest active curated custom products, as cards need them. Sold out and hidden ones left out. */
async function latestCustomBooks(db, { limit = LIMIT, soldOut = new Set() } = {}) {
  const { data, error } = await db.from('custom_products')
    .select('slug,title,author,price_inr,image_url,created_at')
    .eq('is_active', true)
    .not('tags', 'ilike', '%crossword-catalog%')
    .not('tags', 'ilike', '%99bookstores-catalog%')
    .not('tags', 'ilike', '%imported-bookstohome%')
    .order('created_at', { ascending: false })
    .limit(limit * 2);
  if (error) throw new Error(error.message);
  const rows = (data || []).filter((p) => p.slug && p.title && p.image_url && Number(p.price_inr) > 0);
  const slugs = rows.map((p) => p.slug);
  const overrides = new Map();
  if (slugs.length) {
    const { data: ov, error: ovErr } = await db.from('product_overrides')
      .select('slug,title,author,price_inr,is_active').in('slug', slugs);
    if (ovErr) throw new Error(ovErr.message);
    for (const o of ov || []) overrides.set(String(o.slug).toLowerCase(), o);
  }
  const out = [];
  for (const p of rows) {
    const key = String(p.slug).toLowerCase();
    if (soldOut.has(key)) continue;
    const o = overrides.get(key);
    const live = o && o.is_active !== false ? o : null;
    const author = (live && live.author) || p.author || '';
    out.push({
      slug: p.slug,
      title: displayTitle((live && live.title) || p.title, author),
      author,
      price: live && live.price_inr != null ? live.price_inr : p.price_inr,
      image: proxifySupabaseImage(p.image_url),
    });
    if (out.length >= limit) break;
  }
  return out;
}

const CARD = {
  // /new-arrivals/ -- generate_site.py landing_html
  landing: (b) => `
      <a class="card" href="/product/${encodeURIComponent(b.slug)}/">
        <span class="cover"><img src="${esc(b.image)}" alt="${esc(b.title)} cover" loading="lazy"/></span>
        <strong>${esc(b.title)}</strong>
        <small>${esc(b.author || 'Ink & Chai')}</small>
        <span class="price">${esc(rupees(b.price))}</span>
      </a>`,
  // /new-arrivals-2026/ -- the category page's .ah-card
  category: (b) => `<a href="/product/${encodeURIComponent(b.slug)}/" class="ah-card"><div class="ah-cover"><img src="${esc(b.image)}" alt="${esc(b.title)}" loading="lazy" onerror="this.style.display='none'"/></div><div class="ah-title">${esc(b.title)}</div><div class="ah-price">${esc(rupees(b.price))}</div></a>`,
};
const GRID = { landing: '<section class="grid">', category: '<div class="lp-grid">' };

/**
 * The baked page with these books first in its grid. Books the page already
 * lists, and deleted slugs, are skipped. Pure.
 * @returns {{ html: string, added: number }}
 */
function injectNewArrivals(html, books, { deleted = new Set() } = {}) {
  const s = String(html || '');
  const kind = s.includes(GRID.landing) ? 'landing' : s.includes(GRID.category) ? 'category' : null;
  if (!kind || !Array.isArray(books) || !books.length) return { html: s, added: 0 };
  const cards = books
    .filter((b) => b && b.slug && !deleted.has(String(b.slug).toLowerCase()))
    .filter((b) => !s.includes(`href="/product/${encodeURIComponent(b.slug)}/"`))
    .map(CARD[kind]);
  if (!cards.length) return { html: s, added: 0 };
  const at = s.indexOf(GRID[kind]) + GRID[kind].length;
  return { html: `${s.slice(0, at)}${cards.join(kind === 'landing' ? '\n' : '')}${s.slice(at)}`, added: cards.length };
}

module.exports = { latestCustomBooks, injectNewArrivals, LIMIT };
