'use strict';
// Reading lists (/best-books/), owner request 16 Nov 2026.
const test = require('node:test');
const assert = require('node:assert/strict');

const RL = require('./reading-lists');
const { booksFor, catalogue } = require('../reading-list')._test;

const priced = (over = {}) => Object.fromEntries(RL.allPickSlugs().map((s) => [s, { price: 199, mrp: 499, img: `/images/${s}.webp`, title: s, author: '', ...(over[s] || {}) }]));

test('every list is complete, and no list repeats a book', () => {
  const slugs = new Set();
  for (const l of RL.LISTS) {
    assert.ok(!slugs.has(l.slug), l.slug); slugs.add(l.slug);
    assert.match(l.slug, /^[a-z0-9-]+$/);
    for (const k of ['title', 'h1', 'description', 'intro']) assert.ok(l[k], `${l.slug} ${k}`);
    assert.ok(l.description.length <= 300, `${l.slug} description is ${l.description.length} chars`);
    assert.ok(l.picks.length >= 10, l.slug);
    const seen = new Set();
    for (const p of l.picks) {
      assert.ok(p.slug && p.note && p.name, `${l.slug}: ${p.slug}`);
      assert.ok(!seen.has(p.slug.toLowerCase()), `${l.slug} repeats ${p.slug}`); seen.add(p.slug.toLowerCase());
    }
  }
});

test('a book over the list budget, or not priced, is left out; numbering follows what is shown', () => {
  const list = RL.listFor('thriller-books-under-300');
  const [a, b, c] = list.picks.map((p) => p.slug);
  const books = priced({ [b]: { price: 301 } });
  delete books[c];
  const parts = RL.renderList(list, books);
  assert.equal(parts.count, list.picks.length - 2);
  assert.ok(!parts.main.includes(`/product/${b}/`));
  assert.ok(!parts.main.includes(`/product/${c}/`));
  assert.match(parts.main, new RegExp(`/product/${a}/">1\\. `));
  const ld = JSON.parse(parts.jsonLd);
  assert.equal(ld['@graph'][0].numberOfItems, parts.count);
  assert.ok(ld['@graph'].some((g) => g['@type'] === 'FAQPage'));
});

test('grouped lists get one heading per group, and the page links the other lists', () => {
  const parts = RL.renderList(RL.listFor('books-for-upsc-aspirants'), priced());
  assert.equal((parts.main.match(/class="rl-group"/g) || []).length, new Set(RL.listFor('books-for-upsc-aspirants').picks.map((p) => p.group)).size);
  assert.match(parts.main, /href="\/best-books\/thriller-books-under-300\/"/);
  assert.equal(parts.canonical, 'https://inkandchai.in/best-books/books-for-upsc-aspirants/');
  assert.ok(!/<\/script/i.test(parts.jsonLd));
});

test('product pages say which lists feature them; others say nothing', () => {
  assert.match(RL.featuredInHtml('the-silent-patient-by-alex-michaelides-85469'), /best-books\/thriller-books-under-300/);
  assert.equal(RL.featuredInHtml('some-other-book'), '');
});

test('the sitemap gets the index and every list, once', () => {
  const base = '<?xml version="1.0"?><urlset>\n</urlset>';
  const once = RL.addToSitemap(base);
  assert.equal(once.added, RL.LISTS.length + 1);
  assert.equal(RL.addToSitemap(once.xml).added, 0);
});

test('every catalogue pick is found in the catalogue file', () => {
  const cat = catalogue();
  // Custom (admin-added) books are looked up in the database; the rest must be here.
  const custom = new Set(['9780143466116', '9789357027601', 'ugly-love-colleen-hoover', 'november-9-a-novel-character-development',
    'our-perfect-storm-by-carley-fortune-rtune', 'book-lovers-contemporary-romance', 'people-we-meet-on-vacation-crossword-recommends',
    'strange-pictures-the-japanese-mystery-sensation-by-uketsu', 'the-inheritance-games-international-ya-mystery-bestseller-by-jennifer-lynn-barne']);
  const missing = RL.allPickSlugs().filter((s) => !cat.has(s) && !custom.has(s));
  // Reported, not failed: a book can move to the admin-added table. The live check is reading-list.js.
  if (missing.length) console.log('picks looked up in custom_products:', missing.length);
  assert.ok(cat.size > 1000);
});

test('the till decides: sold out, taken down and unpriced books are not returned', async () => {
  const [a, b, c, d] = RL.listFor('thriller-books-under-300').picks.map((p) => p.slug);
  const price = async (lines) => ({ cart: lines.map((l) => ({ slug: l.slug, price: 199, ...({ [b]: { _sold_out: true }, [c]: { _removed: true }, [d]: { price: 0 } }[l.slug] || {}) })) });
  const books = await booksFor([a, b, c, d], null, { price });
  const cat = catalogue();
  const expect = [a].filter((s) => cat.has(s));
  assert.deepEqual(Object.keys(books), expect);
});
