'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQuantity, priceBooksList } = require('./book-lookup');
const { buildCartFromBooks } = require('./push-bot-order');

test('explicit copy markers are read; numbers inside titles are not', () => {
  const cases = {
    'Who Moved My Cheese ×60': ['Who Moved My Cheese', 60],
    'Ikigai x2': ['Ikigai', 2], 'Ikigai 2x': ['Ikigai', 2], 'Ikigai * 3': ['Ikigai', 3],
    '2 x Ikigai': ['Ikigai', 2], '3 copies of Ikigai': ['Ikigai', 3],
    'Ikigai (2 copies)': ['Ikigai', 2], 'Ikigai - 3 pcs': ['Ikigai', 3], 'Ikigai qty 4': ['Ikigai', 4],
    'Harry Potter Vol 2': ['Harry Potter Vol 2', 1], 'Catch-22': ['Catch-22', 1], '1984': ['1984', 1],
    'Malcolm X': ['Malcolm X', 1], 'The 5 AM Club': ['The 5 AM Club', 1], 'Harry Potter (2)': ['Harry Potter (2)', 1],
  };
  for (const [line, [title, qty]] of Object.entries(cases)) assert.deepEqual(parseQuantity(line), { title, qty }, line);
});

test('the 1 Nov case: 60 copies are priced as 60, with free shipping', async () => {
  const lookupBook = async (t) => (/cheese/i.test(t) ? { title: 'Who Moved My Cheese?', price: 99, slug: 'who-moved-my-cheese' } : null);
  const p = await priceBooksList('Who Moved My Cheese ×60', 349, { lookupBook });
  assert.equal(p.subtotalRs, 5940);
  assert.equal(p.shippingRs, 0);
  assert.equal(p.copies, 60);
  assert.equal(p.items[0].unitPrice, 99);
  assert.equal(p.items[0].qty, 60);
});

test('the Orders cart carries the copies', async () => {
  assert.deepEqual(await buildCartFromBooks('Who Moved My Cheese ×60', 5940), [{ title: 'Who Moved My Cheese', qty: 60, price: 99 }]);
  const priceBooksList = async () => ({ items: [{ unitPrice: 250 }, { unitPrice: 400 }] });
  assert.deepEqual(await buildCartFromBooks('Ikigai ×2, Atomic Habits', 900, { priceBooksList }),
    [{ title: 'Ikigai', qty: 2, price: 250 }, { title: 'Atomic Habits', qty: 1, price: 400 }]);
  assert.deepEqual(await buildCartFromBooks('Ikigai', 299), [{ title: 'Ikigai', qty: 1, price: 299 }]);
});
