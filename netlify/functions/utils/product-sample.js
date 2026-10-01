'use strict';

/**
 * "Read sample" PDFs for physical books.
 *
 * The admin panel cuts the PDF down to its first few pages IN THE BROWSER
 * before uploading, so the rest of the book never leaves the admin's machine --
 * the same reasoning as utils/ebook-watermark: a viewer told to stop at page
 * twenty is a suggestion, a file that only has twenty pages is not.
 *
 * Shared by admin-product-sample (upload/save/remove) and get-product-sample
 * (the storefront read), so the key shape and limits cannot drift apart.
 */

const MAX_PAGES = 60;
const MAX_BYTES = 25 * 1024 * 1024;
const TABLE = 'product_samples';

function cleanSlug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 160);
}

/** A fresh object key per upload, so a replaced sample is never served stale from a cache. */
function newSampleKey(slug, now = Date.now(), rand = Math.random().toString(36).slice(2, 8)) {
  return `samples/${cleanSlug(slug).slice(0, 80)}-${now}-${rand}.pdf`;
}

/** Only a key this module minted for THIS product may be saved against it. */
function isSampleKeyFor(key, slug) {
  const s = cleanSlug(slug).slice(0, 80);
  if (!s) return false;
  const esc = s.replace(/[-]/g, '\\-');
  return new RegExp(`^samples/${esc}-\\d{10,}-[a-z0-9]{1,12}\\.pdf$`).test(String(key || ''));
}

function cleanPages(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 && n <= MAX_PAGES ? n : null;
}

/** What the storefront is told. The file URL is versioned by save time. */
function publicSample(row) {
  if (!row || !row.r2_key || !row.slug) return null;
  const v = new Date(row.updated_at || 0).getTime() || 0;
  return {
    slug: row.slug,
    pages: Number(row.pages) || null,
    file_url: `/.netlify/functions/get-product-sample?slug=${encodeURIComponent(row.slug)}&file=pdf&v=${v}`,
    updated_at: row.updated_at || null,
  };
}

/** The table not existing yet reads as "no sample", never as a broken page. */
function isMissingTable(error) {
  const msg = String((error && error.message) || '');
  return /product_samples/.test(msg) && /(does not exist|schema cache|not find)/i.test(msg);
}

module.exports = { MAX_PAGES, MAX_BYTES, TABLE, cleanSlug, newSampleKey, isSampleKeyFor, cleanPages, publicSample, isMissingTable };
