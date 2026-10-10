'use strict';

/**
 * Admin "Fill from Amazon URL" (Create Listing tab): an Amazon.in product link
 * in, the Create Listing form's fields out. Used by admin-amazon-listing.js.
 *
 * Same sources and rules as the bestseller agent (utils/bestseller-agent):
 *   - facts (ISBN, publisher, pages, weight, M.R.P. ...) from the product page
 *   - price = M.R.P. − 40%
 *   - description, author bio, tags and SEO copy are drafted fresh by the
 *     model, with Amazon's blurb given as facts only; the blurb itself is
 *     never returned
 *   - NO image. Amazon's cover is never used; the admin adds the cover.
 */

const { isbn10Valid } = require('./gtin');

const SHORT_HOSTS = /^(?:www\.)?(?:amzn\.in|amzn\.to|amzn\.eu|a\.co)$/i;
const AMAZON_HOST = /^(?:www\.|m\.|smile\.)?amazon\.(?:in|com|co\.uk)$/i;

/** ISBN-10 for a 978- ISBN-13: Amazon's ASIN for that print book. */
function isbn10From13(isbn13) {
  const d = String(isbn13 || '').replace(/[^0-9]/g, '');
  if (d.length !== 13 || !d.startsWith('978')) return '';
  const core = d.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += (10 - i) * Number(core[i]);
  const check = (11 - (sum % 11)) % 11;
  return core + (check === 10 ? 'X' : String(check));
}

/**
 * What the admin pasted, reduced to { asin } or { shortUrl } (an amzn.in link
 * whose redirect has to be followed first) or { error }.
 * Accepts a full product URL, a bare ASIN, or an ISBN-10/13.
 */
function parseAmazonInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return { error: 'Paste an Amazon product link.' };

  const bare = raw.replace(/[\s-]/g, '').toUpperCase();
  if (/^97[89]\d{10}$/.test(bare)) {
    const asin = isbn10From13(bare);
    return asin ? { asin } : { error: 'That ISBN-13 has no ISBN-10, so its Amazon page cannot be found from it. Paste the Amazon link instead.' };
  }
  if (/^[A-Z0-9]{10}$/.test(bare) && (isbn10Valid(bare) || /^B0/.test(bare))) return { asin: bare };

  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return { error: 'That is not a link.' }; }
  if (SHORT_HOSTS.test(url.hostname)) return { shortUrl: `https://${url.hostname}${url.pathname}` };
  if (!AMAZON_HOST.test(url.hostname)) return { error: 'Only amazon.in product links are supported.' };

  const m = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/ASIN|o\/ASIN)\/([A-Z0-9]{10})(?:[/?]|$)/i);
  if (!m) return { error: 'No product ID (/dp/…) in that link. Open the book on Amazon and copy the address from there.' };
  return { asin: m[1].toUpperCase() };
}

/** The ASIN in a URL Amazon redirected to, or ''. */
function asinFromLocation(loc) {
  const r = parseAmazonInput(loc);
  return r.asin || '';
}

/** Amazon's "1 May 2025" / "May 2025" are fine as typed; just tidy spacing. */
function tidy(v, max) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : '';
}

/**
 * The Create Listing form fields from a parsed product page. Pure.
 * @param page      utils/bestseller-agent parseProductPage(...) with ok:true
 * @param extras    { title, category, money: decideMrp(...), price, copy: draftCopy(...) }
 */
function formFields(page, { title, category, money, price, copy } = {}) {
  const c = copy && !copy.error && !copy.skipped ? copy : {};
  return {
    title: tidy(title, 200),
    author: tidy(page.author, 160),
    category: tidy(category, 80),
    price_inr: price || '',
    original_price_inr: (money && money.mrp) || '',
    publisher: tidy(page.publisher, 120),
    isbn: page.isbn13 || '',
    format: tidy(page.format, 60),
    language: tidy(page.language, 60),
    pages: page.pages || '',
    dimensions: tidy(page.dimensions, 80),
    weight_grams: page.weight_grams || '',
    published_on: tidy(page.published_on, 40),
    reading_age: tidy(page.reading_age, 40),
    description: c.description || '',
    author_bio: c.author_bio || '',
    tags: c.tags || '',
    seo_title: c.seo_title || '',
    meta_description: c.meta_description || '',
  };
}

module.exports = { parseAmazonInput, asinFromLocation, isbn10From13, formFields };
