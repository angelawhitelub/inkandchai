/**
 * Shared rules for the eBook shop. Pure functions, so the parts that decide who
 * may read a paid PDF are testable without a network.
 *
 * THE ONE INVARIANT
 * -----------------
 * A PDF is worth money and is infinitely copyable, so unlike a cover image it
 * must never be reachable by URL alone. Everything here exists to keep that
 * true: keys are unguessable, the bucket is private, and reads go through a
 * signed URL that expires in minutes and is only ever issued to a signed-in
 * customer who has paid for that exact slug.
 */

/** Slugs are the catalogue's own identifier format: lowercase, dashed. */
function normaliseSlug(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 120);
}

const MAX_PRICE = 50000;

/**
 * A price in whole rupees. Razorpay's floor is ₹1; a zero or negative price
 * would create an order it refuses, and a fractional one would round somewhere
 * the customer cannot see.
 */
function validatePrice(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: 'Price must be a whole number of rupees.' };
  if (n < 1) return { ok: false, error: 'Price must be at least ₹1.' };
  if (n > MAX_PRICE) return { ok: false, error: `Price must be ₹${MAX_PRICE} or less.` };
  return { ok: true, price: n };
}

const MAX_PDF_BYTES = 200 * 1024 * 1024;

/**
 * Only real PDFs, and only up to a size R2 and a phone browser can both handle.
 * The type is checked again on the server at save time -- this runs before the
 * upload, where the only thing available is what the browser claims.
 */
function validatePdfUpload({ contentType, sizeBytes }) {
  if (String(contentType || '').toLowerCase() !== 'application/pdf') {
    return { ok: false, error: 'Only PDF files can be sold as eBooks.' };
  }
  const size = Number(sizeBytes);
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: 'Could not read the file size.' };
  if (size > MAX_PDF_BYTES) {
    return { ok: false, error: `That PDF is ${(size / 1048576).toFixed(0)} MB. The limit is ${MAX_PDF_BYTES / 1048576} MB.` };
  }
  return { ok: true };
}

/**
 * Where the PDF lives in the private bucket.
 *
 * The random segment is deliberate. The bucket has no public origin, so a key
 * is not a URL today -- but if one were ever attached by mistake, a guessable
 * key like ebooks/atomic-habits.pdf would put every paid title one URL away
 * from being free. This makes the key itself a secret, so a misconfiguration
 * costs nothing on its own.
 */
function ebookKey(slug, randomHex) {
  const s = normaliseSlug(slug);
  if (!s) throw new Error('ebookKey needs a slug');
  const rand = String(randomHex || '').replace(/[^a-f0-9]/gi, '').slice(0, 32) || 'x';
  return `ebooks/${s}/${rand}.pdf`;
}

/**
 * What the storefront is allowed to see. The r2_key never leaves the server --
 * it is the one field that turns a listing into a download.
 */
function publicEbook(row) {
  if (!row) return null;
  return {
    slug: row.slug,
    title: row.title || '',
    author: row.author || '',
    cover: row.cover || '',
    price: row.price,
    mrp: row.mrp || null,
    pages: row.pages || null,
    size_mb: row.size_bytes ? Math.round((row.size_bytes / 1048576) * 10) / 10 : null,
  };
}

/**
 * How long a download link lives.
 *
 * Short, because the URL is bearer proof: anyone holding it can read the book.
 * Not so short that a slow connection on mobile data loses the file halfway --
 * R2 authorises at request time, so a download that has already started is not
 * cut off when the window closes.
 */
const DOWNLOAD_TTL_SEC = 300;

module.exports = {
  normaliseSlug,
  validatePrice,
  validatePdfUpload,
  ebookKey,
  publicEbook,
  DOWNLOAD_TTL_SEC,
  MAX_PRICE,
  MAX_PDF_BYTES,
};
