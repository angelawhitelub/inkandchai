'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fbt = require('./fbt-signals');

const NOW = Date.parse('2026-11-08T00:00:00Z');
const day = (n) => new Date(NOW - n * 86400000).toISOString();
const line = (slug, qty = 1) => ({ url: `/product/${slug}/`, title: slug, qty });
const order = (id, items, ago = 1) => ({ razorpay_order_id: id, created_at: day(ago), cart_items: items });

test('books bought in the same order by 2+ customers become partners, strongest first', () => {
  const t = fbt.newPairTally(NOW);
  fbt.addBaskets(t, [
    order('IC-1', [line('vol-1'), line('vol-2')]),
    order('IC-2', [line('vol-1'), line('vol-2'), line('ikigai')]),
    order('IC-3', [line('vol-2'), line('vol-1')]),
    order('IC-4', [line('vol-1'), line('ikigai')]),
    order('IC-5', [line('vol-1'), line('atomic')]),   // once: noise
  ]);
  const doc = fbt.finishPairs(t);
  assert.deepEqual(doc.pairs['vol-1'], [['vol-2', 3], ['ikigai', 2]]);
  assert.deepEqual(doc.pairs['vol-2'], [['vol-1', 3]]);
  assert.equal(doc.pairs.atomic, undefined);
  assert.equal(doc.bestsellers[0][0], 'vol-1');
  assert.equal(doc.baskets, 5);
});

test('replacements, old orders and bulk orders do not make pairs; a line without a link is matched by title', () => {
  const t = fbt.newPairTally(NOW);
  const bulk = Array.from({ length: 7 }, (_, i) => line(`b${i}`));
  fbt.addBaskets(t, [
    order('IC-R-1', [line('a'), line('b')]),
    order('IC-R-2', [line('a'), line('b')]),
    order('IC-OLD1', [line('a'), line('b')], 400),
    order('IC-OLD2', [line('a'), line('b')], 400),
    order('IC-BULK1', bulk), order('IC-BULK2', bulk),
    order('IC-T1', [{ title: 'Book A', qty: 1 }, line('c')]),
    order('IC-T2', [{ title: 'Book A', qty: 2 }, line('c')]),
  ], { slugByTitle: new Map([['book a', 'a']]) });
  const doc = fbt.finishPairs(t);
  assert.deepEqual(Object.keys(doc.pairs).sort(), ['a', 'c']);
  assert.deepEqual(doc.pairs.a, [['c', 2]]);
  assert.ok(doc.bestsellers.some(([s, n]) => s === 'b0' && n === 2), 'bulk orders still count as sales');
});
