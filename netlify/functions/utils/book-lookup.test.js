'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lookupBook, parseQuantity, priceBooksList } = require('./book-lookup');
const { buildCartFromBooks, withCovers } = require('./push-bot-order');

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

test('a pasted Amazon title with " | " stays one cart line; unmatched titles share the total', async () => {
  const pasted = "System Design Interview Vol 1 & Vol 2 Combo Set by Alex Xu | An Insider's Guide to System Design Interviews | Complete 2 Books Collection";
  const priceBooksList = async () => ({ items: [{ unitPrice: 349, matched: false }] });
  assert.deepEqual(await buildCartFromBooks(pasted, 389, { priceBooksList }), [{ title: pasted, qty: 1, price: 389 }]);
  const two = async () => ({ items: [{ unitPrice: 450, matched: true }, { unitPrice: 349, matched: false }] });
  assert.deepEqual(await buildCartFromBooks('Designing Data-Intensive Applications, Database Internals', 698, { priceBooksList: two }),
    [{ title: 'Designing Data-Intensive Applications', qty: 1, price: 450 }, { title: 'Database Internals', qty: 1, price: 349 }]);
});

const WFF = { slug: 'without-fear-or-favour-by-sanjay-kishan-kaul', title: 'Without Fear or Favour by Sanjay Kishan Kaul', author: 'Sanjay Kishan Kaul, Jay Vinayak Ojha', price_inr: 549 };
const MIND = { slug: 'mind-without-fear', title: 'Mind Without Fear', author: 'Someone Else', price_inr: 199 };

test('the 4 Nov case: a listed custom book is found from the name the customer typed', async () => {
  const seen = [];
  const hit = await lookupBook('Without Fear or Favour by Sanjay Kaul', {
    staticBooks: [],
    findCustomProducts: async (t) => { seen.push(t); return [MIND, WFF]; },
  });
  assert.deepEqual(seen, ['Without Fear or Favour by Sanjay Kaul']);
  assert.equal(hit.slug, WFF.slug);
  assert.equal(hit.price, 549);
  assert.equal(hit.source, 'custom');
});

test('a catalogue row sharing a couple of words is not quoted as the book', async () => {
  const hit = await lookupBook('Without Fear or Favour', { staticBooks: [], findCustomProducts: async () => [MIND] });
  assert.equal(hit, null);
});

test('a catalogue row with an extra word in the request still matches; no price means no match', async () => {
  const deps = { staticBooks: [], findCustomProducts: async () => [WFF] };
  assert.equal((await lookupBook('Without Fear or Favour Sanjay Kaul hardcover', deps)).slug, WFF.slug);
  assert.equal(await lookupBook('Without Fear or Favour', { staticBooks: [], findCustomProducts: async () => [{ ...WFF, price_inr: 0 }] }), null);
});

test('bot order lines get the listed cover; an unmatched line or a failed lookup stays as it was', async () => {
  const cart = [{ title: 'Ikigai', qty: 1, price: 199 }, { title: 'Unlisted', qty: 1, price: 300 }, { title: 'Boom', qty: 1, price: 1 }];
  const lookupBook = async (t) => {
    if (t === 'Boom') throw new Error('db down');
    return t === 'Ikigai' ? { title: 'Ikigai', image: '/images/ikigai.webp' } : null;
  };
  assert.deepEqual(await withCovers(cart, { lookupBook }), [{ title: 'Ikigai', qty: 1, price: 199, img: '/images/ikigai.webp' }, cart[1], cart[2]]);
});

