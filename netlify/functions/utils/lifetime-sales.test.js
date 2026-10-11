'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { countLifetimeSales, newTally, addOrders, finishTally, soldLine } = require('./lifetime-sales');

const order = (id, items, over = {}) => ({ razorpay_order_id: id, cart_items: items, ...over });

test('lifetime units per book, across every order, most sold first', () => {
  const doc = countLifetimeSales([
    order('IC-1', [{ slug: 'Protocols', title: 'Protocols', qty: 2, price: 549, img: '/a.webp' }, { url: '/product/the-witch/', title: 'The Witch', qty: 1 }]),
    order('IC-2', JSON.stringify([{ slug: 'protocols', title: 'Protocols: An Operating Manual', qty: 1, price: 549 }])),
    order('IC-3', [{ title: 'Trust Fall', qty: 3 }]),   // no slug: matched by title
    order('IC-4', [{ title: 'Unknown Book', qty: 9 }]), // no slug, no match: not counted
  ], { slugByTitle: new Map([['trust fall', 'trust-fall-slug']]) });
  assert.deepEqual(doc.counts, { protocols: 3, 'the-witch': 1, 'trust-fall-slug': 3 });
  assert.deepEqual(doc.top.map((t) => [t.slug, t.qty]), [['protocols', 3], ['trust-fall-slug', 3], ['the-witch', 1]]);
  assert.equal(doc.top[0].title, 'Protocols: An Operating Manual', 'newest line describes the book');
  assert.equal(doc.top[0].url, '/product/protocols/');
});

test('free replacements are not sales', () => {
  const doc = countLifetimeSales([
    order('IC-R-20261001-AAAAA', [{ slug: 'x', qty: 1 }]),
    order('IC-5', [{ slug: 'x', qty: 1 }], { source: 'replacement' }),
    order('IC-6', [{ slug: 'x', qty: 1 }]),
  ]);
  assert.deepEqual(doc.counts, { x: 1 });
  assert.equal(doc.orders, 1);
});

test('counting page by page gives the same answer', () => {
  const pages = [[order('A', [{ slug: 'a', qty: 2 }])], [order('B', [{ slug: 'a', qty: 1 }, { slug: 'b', qty: 1 }])]];
  const t = newTally();
  for (const p of pages) addOrders(t, p);
  assert.deepEqual(finishTally(t).counts, countLifetimeSales(pages.flat()).counts);
});

test('the product page shows the count from 10 sold', () => {
  assert.equal(soldLine(9), '');
  assert.equal(soldLine(undefined), '');
  assert.match(soldLine(129), /🔥 129 sold/);
  assert.match(soldLine(1500), /1,500 sold/);
});

test('Reader Bestsellers keeps the month order but shows lifetime units', () => {
  const { withLifetimeCounts } = require('../homepage-merchandising')._test;
  const month = [{ slug: 'New-Hit', title: 'New Hit', qty: 40 }, { slug: 'classic', title: 'Classic', qty: 12 }, { slug: '', title: 'No Slug', qty: 5 }];
  const out = withLifetimeCounts(month, { counts: { 'new-hit': 55, classic: 515 } });
  assert.deepEqual(out.map((r) => [r.title, r.qty, r.month_qty]), [['New Hit', 55, 40], ['Classic', 515, 12], ['No Slug', 5, 5]]);
  assert.deepEqual(withLifetimeCounts(month, null).map((r) => r.qty), [40, 12, 5], 'before the first run: month numbers');
});
