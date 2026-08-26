'use strict';

/**
 * Turn a book's ISBN into something Google will actually accept.
 *
 * `g:isbn` is not a Google Merchant attribute — it does not exist in the
 * product spec and is silently ignored. Emitting it alongside
 * `identifier_exists=yes` therefore tells Google "this product has a unique
 * identifier" while supplying none, which is an error (missing GTIN) and gets
 * the item disapproved rather than listed.
 *
 * The right attribute is `g:gtin`, and a book's GTIN is its ISBN-13 (the 978/
 * 979 EAN range). So:
 *   • a valid ISBN-13 passes through
 *   • a valid ISBN-10 is converted to its ISBN-13 form
 *   • anything else — wrong length, bad check digit, an internal SKU that
 *     happened to land in the isbn column — yields '' and the caller must fall
 *     back to identifier_exists=no. Claiming an identifier we cannot supply is
 *     worse than admitting we have none.
 */

function digitsOf(raw) {
  return String(raw == null ? '' : raw).toUpperCase().replace(/[^0-9X]/g, '');
}

function isbn10Valid(s) {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const c = s[i];
    sum += (i + 1) * (c === 'X' ? 10 : Number(c));
  }
  return sum % 11 === 0;
}

function ean13CheckDigit(twelve) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

function isbn13Valid(s) {
  if (!/^\d{13}$/.test(s)) return false;
  if (!/^97[89]/.test(s)) return false;   // books live in the 978/979 EAN range
  return ean13CheckDigit(s.slice(0, 12)) === s[12];
}

/**
 * @param {string} raw  whatever is in the isbn column
 * @returns {string} a valid 13-digit GTIN, or '' when there isn't one
 */
function isbnToGtin(raw) {
  const s = digitsOf(raw);
  if (isbn13Valid(s)) return s;
  if (isbn10Valid(s)) {
    const body = '978' + s.slice(0, 9);
    return body + ean13CheckDigit(body);
  }
  return '';
}

/**
 * The two Merchant attributes that must always agree with each other.
 * @returns {string} XML fragment
 */
function identifierXml(raw) {
  const gtin = isbnToGtin(raw);
  return gtin
    ? `<g:identifier_exists>yes</g:identifier_exists><g:gtin>${gtin}</g:gtin>`
    : '<g:identifier_exists>no</g:identifier_exists>';
}

module.exports = { isbnToGtin, identifierXml, isbn10Valid, isbn13Valid };
