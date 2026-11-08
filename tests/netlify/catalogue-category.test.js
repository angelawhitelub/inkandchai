const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const { catalogueCategory, FIXES } = require('../../netlify/functions/utils/catalogue-category');
const slugify = (s) => s.toLowerCase().split('').map((c) => (/[\p{L}\p{N}]/u.test(c) ? c : '-')).join('').replace(/^-+|-+$/g, '').replace('--', '-');

test('every fixed category has a baked category page to link to', () => {
  for (const cat of new Set(Object.values(FIXES))) {
    assert.ok(fs.existsSync(path.join(root, 'public/category', slugify(cat), 'index.html')), `${cat} has no /category/ page`);
  }
});

test('a sale bucket is replaced by the genre; unlisted books keep theirs', () => {
  const books = require('../../data/ALL_BOOKS.json');
  const bow = books.find((b) => b.title === 'His Last Bow');
  assert.equal(bow.category, 'Self-help (On Sale)');
  assert.equal(catalogueCategory(bow), 'Classics');
  assert.equal(catalogueCategory({ shopify_id: 'nope', category: 'Fiction' }), 'Fiction');
});

test('no fixed book still points its category at a sale bucket', () => {
  for (const cat of Object.values(FIXES)) assert.doesNotMatch(cat, /On Sale|Combos|Boxsets|from Publishers|Sunday Sale/);
});
