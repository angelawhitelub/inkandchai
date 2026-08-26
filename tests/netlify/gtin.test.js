'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isbnToGtin, identifierXml } = require('../../netlify/functions/utils/gtin');

test('a valid ISBN-13 is already a GTIN', () => {
  assert.strictEqual(isbnToGtin('9780140449112'), '9780140449112');
  assert.strictEqual(isbnToGtin('978-1-4449-7488-1'), '9781444974881');
});

test('an ISBN-10 is converted to its ISBN-13 form', () => {
  // System Design Interview Vol 1 — the product that started this.
  assert.strictEqual(isbnToGtin('1736049119'), '9781736049112');
  assert.strictEqual(isbnToGtin('0224099795'), '9780224099790');
});

test('an ISBN-10 ending in X converts correctly', () => {
  assert.strictEqual(isbnToGtin('043942089X'), '9780439420891');
});

test('a bad check digit is refused rather than guessed at', () => {
  assert.strictEqual(isbnToGtin('1736049110'), '');
  assert.strictEqual(isbnToGtin('9780140449113'), '');
});

test('junk in the isbn column yields no identifier at all', () => {
  // 12 digits, a real value found in the live feed — neither ISBN-10 nor -13.
  assert.strictEqual(isbnToGtin('947326771717'), '');
  for (const v of ['', null, undefined, 'N/A', '123', 'SKU-4471']) {
    assert.strictEqual(isbnToGtin(v), '', `${v} should yield no GTIN`);
  }
});

test('a 13-digit number outside the book EAN range is not a book GTIN', () => {
  assert.strictEqual(isbnToGtin('1234567890128'), '');
});

test('identifier_exists never claims an identifier we cannot supply', () => {
  assert.strictEqual(identifierXml('1736049119'),
    '<g:identifier_exists>yes</g:identifier_exists><g:gtin>9781736049112</g:gtin>');
  assert.strictEqual(identifierXml('947326771717'), '<g:identifier_exists>no</g:identifier_exists>');
  assert.strictEqual(identifierXml(''), '<g:identifier_exists>no</g:identifier_exists>');
});

test('g:isbn is never emitted — it is not a Merchant attribute', () => {
  for (const v of ['9780140449112', '1736049119', 'nonsense']) {
    assert.ok(!identifierXml(v).includes('<g:isbn>'), `g:isbn leaked for ${v}`);
  }
});
