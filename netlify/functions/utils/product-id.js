'use strict';

/**
 * Ink & Chai product ID (11 Nov 2026) — a fixed 10-character code for every
 * product, like an Amazon ASIN: "IC" + 8 characters, e.g. IC4K7Q2M9X.
 *
 * It is worked out from the product's slug, so every book — the baked
 * catalogue and every admin-created listing — has one without a database
 * column, and the Worker, the functions and the admin page all agree. The
 * admin page carries a copy (icProductId in public/admin/index.html);
 * product-id.test.js runs both on the same slugs, so a drift fails the tests.
 *
 * Alphabet: Crockford base32 (no I, L, O, U), so it reads aloud and cannot be
 * mistaken for 1/0. 40 bits: among 30,000 products a clash is ~1 in 2,500
 * and lookups return every match, so a clash is visible, never silent.
 */

const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MASK = (1n << 64n) - 1n;

const normSlug = (s) => String(s || '').trim().toLowerCase()
  .replace(/[?#].*$/, '').replace(/^https?:\/\/[^/]+/, '').replace(/^\/?product\//, '')
  .replace(/^\/+|\/+$/g, '');

function productId(slug) {
  const s = normSlug(slug);
  if (!s) return '';
  let h = 0xcbf29ce484222325n;                     // FNV-1a 64
  for (const b of new TextEncoder().encode(s)) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & MASK;
  }
  h ^= h >> 33n; h = (h * 0xff51afd7ed558ccdn) & MASK;   // murmur3 finaliser
  h ^= h >> 33n; h = (h * 0xc4ceb9fe1a85ec53n) & MASK;
  h ^= h >> 33n;
  let out = 'IC';
  for (let i = 0; i < 8; i += 1) out += ALPHA[Number((h >> BigInt(5 * i)) & 31n)];
  return out;
}

/** "ic4k7q2m9x", " IC-4K7Q-2M9X " → "IC4K7Q2M9X"; '' when it is not an ID. */
function parseProductId(q) {
  const t = String(q || '').toUpperCase().replace(/[\s-]+/g, '');
  return /^IC[0-9A-HJKMNP-TV-Z]{8}$/.test(t) ? t : '';
}

/**
 * custom_products slugs whose ID is `pid`. The ID is not stored, so every slug
 * is read (slug column only, 1,000 a page, 6 pages at a time) and hashed.
 */
async function findCustomSlugsById(supabase, pid) {
  const { count, error } = await supabase.from('custom_products').select('slug', { count: 'exact', head: true });
  if (error) throw error;
  const pages = Math.ceil((count || 0) / 1000);
  const out = [];
  for (let start = 0; start < pages; start += 6) {
    const batch = [];
    for (let p = start; p < Math.min(pages, start + 6); p += 1) {
      batch.push(supabase.from('custom_products').select('slug').order('slug').range(p * 1000, p * 1000 + 999));
    }
    for (const { data, error: e } of await Promise.all(batch)) {
      if (e) throw e;
      for (const r of data || []) if (productId(r.slug) === pid) out.push(r.slug);
    }
  }
  return out;
}

module.exports = { productId, parseProductId, normSlug, findCustomSlugsById };
