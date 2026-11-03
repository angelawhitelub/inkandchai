'use strict';

// Best Sellers Rank: who ranks, in what order, on which shelf, and what the
// product page and /bestsellers/ show.

const test = require('node:test');
const assert = require('node:assert/strict');
const bsr = require('./bestseller-rank');

test('raw catalogue categories land on reader shelves; non-genres and combos on none', () => {
  assert.equal(bsr.shelfOf('Romance (On Sale)'), 'romance');
  assert.equal(bsr.shelfOf('All Romance Books'), 'romance');
  assert.equal(bsr.shelfOf('Colleen Hoover Special'), 'romance');
  assert.equal(bsr.shelfOf('Self-help (On Sale)'), 'self-help');
  assert.equal(bsr.shelfOf('All Self Help'), 'self-help');
  assert.equal(bsr.shelfOf('KIDS BOOK Age: 3-5'), 'kids');
  assert.equal(bsr.shelfOf('Non Fictions'), 'non-fiction');
  assert.equal(bsr.shelfOf('Fiction'), 'fiction');
  assert.equal(bsr.shelfOf('OTHER LANGUAGES'), 'indian-languages');
  assert.equal(bsr.shelfOf('Fiction & Romance Combos🔥'), '');
  assert.equal(bsr.shelfOf('Preloved Books'), '');
  assert.equal(bsr.shelfOf('New Arrivals'), '');
  assert.equal(bsr.shelfOf(''), '');
});

test('the last 30 days decide the order, lifetime breaks ties, unsold books have no rank', () => {
  const shelf = { a: 'romance', b: 'romance', c: 'fiction', d: 'romance', e: '' };
  const { ranks, order, shelves } = bsr.computeRanks({
    lifetime: { a: 500, b: 20, c: 20, d: 3, e: 9, gone: 50, zero: 0 },
    recent: { b: 9, c: 9, d: 1 },
    shelfFor: (s) => shelf[s] || '',
    exclude: new Set(['gone']),
  });
  // b and c tie on recent and lifetime → slug order; a sold most ever but not lately.
  assert.deepEqual(order, ['b', 'c', 'd', 'a', 'e']);
  assert.deepEqual(ranks.b, [1, 'romance', 1]);
  assert.deepEqual(ranks.c, [2, 'fiction', 1]);
  assert.deepEqual(ranks.d, [3, 'romance', 2]);
  assert.deepEqual(ranks.a, [4, 'romance', 3]);
  assert.deepEqual(ranks.e, [5, '', 0]);
  assert.equal(ranks.gone, undefined, 'a deleted listing is not ranked');
  assert.equal(ranks.zero, undefined, 'a book with no sale has no rank');
  assert.deepEqual(shelves, { romance: 'Romance', fiction: 'Fiction' });
});

test('the product page row and badge', () => {
  const doc = { ranks: { top: [1, 'romance', 1], mid: [1234, 'self-help', 7], plain: [40, '', 0] } };
  const top = bsr.rankOf(doc, 'TOP');
  assert.match(bsr.rankRowHtml(top), /<dt>Best Sellers Rank<\/dt><dd class="bsr">#1 in Books .*<br\/>#1 in <a href="\/bestsellers\/\?shelf=romance"[^>]*>Romance<\/a><\/dd>/);
  assert.match(bsr.badgeHtml(top), /#1 Best Seller<\/span><span[^>]*>in Romance/);
  const mid = bsr.rankOf(doc, 'mid');
  assert.match(bsr.rankRowHtml(mid), /#1,234 in Books/);
  assert.match(bsr.rankRowHtml(mid), /#7 in <a[^>]*>Self-Help/);
  assert.equal(bsr.badgeHtml(mid), '', 'only a shelf\'s #1 gets the badge');
  assert.doesNotMatch(bsr.rankRowHtml(bsr.rankOf(doc, 'plain')), /<br\/>/, 'no shelf line without a shelf');
  assert.equal(bsr.rankOf(doc, 'unsold'), null);
  assert.equal(bsr.rankRowHtml(null), '');
});

test('/bestsellers/ lists the Top 100 overall, or a shelf\'s own order', () => {
  const doc = {
    ranks: { x: [1, 'romance', 1], y: [2, 'fiction', 1], z: [3, 'romance', 2] },
    order: ['x', 'y', 'z'],
    shelves: { romance: 'Romance', fiction: 'Fiction' },
    info: { x: { title: 'X <b>', author: 'A', img: 'https://i/x.webp' }, y: { title: 'Y' }, z: { title: 'Z' } },
  };
  const all = bsr.pageParts(doc, '');
  assert.equal(all.count, 3);
  assert.equal(all.heading, 'Best Sellers in Books');
  assert.match(all.cards, /#1<\/b>[\s\S]*X &lt;b&gt;[\s\S]*#2<\/b>[\s\S]*#3<\/b>/);
  const romance = bsr.pageParts(doc, 'romance');
  assert.equal(romance.count, 2);
  assert.equal(romance.heading, 'Best Sellers in Romance');
  assert.match(romance.cards, /\/product\/x\/[\s\S]*#1<\/b>[\s\S]*\/product\/z\/[\s\S]*#2<\/b>/, 'shelf rank, not store rank');
  assert.equal(bsr.pageParts(doc, 'nope').shelf, '', 'an unknown shelf shows everything');
  assert.match(all.chips, /All books[\s\S]*Romance[\s\S]*Fiction/);
});

test('catalogue covers point at the baked R2 copies', () => {
  assert.equal(
    bsr.catalogueCover('https://cdn.shopify.com/s/files/1/0777/8100/8701/files/91rcGxdclIL._SL1500.jpg?v=1737795337'),
    'https://pub-e82e9bd0c7bd4d1eb2de92eb40d0dc33.r2.dev/9e08b9b744e27718001e2f63-400.webp',
  );
  assert.equal(bsr.catalogueCover(''), '');
});
