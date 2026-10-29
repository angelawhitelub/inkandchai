'use strict';

// The hourly job end to end against a fake database: lifetime counts as
// before, plus the Best Sellers Rank document (utils/bestseller-rank).

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const line = (slug, qty = 1, extra = {}) => ({ slug, title: slug.toUpperCase(), qty, price: 300, ...extra });

function fakeDb(tables) {
  const query = (rows) => {
    const q = {
      select: () => q, order: () => q, in: () => q, eq: () => q, ilike: () => q, not: () => q,
      range: async (a, b) => ({ data: rows.slice(a, b + 1), error: null }),
      then: (res) => res({ data: rows, error: null }),
    };
    return q;
  };
  return { from: (t) => query(tables[t] || []) };
}

test('ranks by the last 30 days, shelves by category, skips deleted listings', async () => {
  const published = {};
  const orders = [
    // "old" sold most in total, but all of it long ago.
    { razorpay_order_id: 'IC-1', status: 'delivered', created_at: ago(200), cart_items: [line('old', 9)] },
    { razorpay_order_id: 'IC-2', status: 'delivered', created_at: ago(5), cart_items: [line('hot', 2), line('gone', 5)] },
    { razorpay_order_id: 'IC-3', status: 'paid', created_at: ago(1), cart_items: JSON.stringify([line('hot'), line('warm')]) },
    { razorpay_order_id: 'IC-R-4', status: 'shipped', created_at: ago(1), cart_items: [line('warm', 50)] },   // a replacement is no sale
  ];
  const tables = {
    orders,
    custom_products: [
      { slug: 'hot', title: 'Hot Book', author: 'H', category: 'Romance (On Sale)', image_url: 'https://x/hot.webp' },
      { slug: 'warm', title: 'Warm Book', author: '', category: 'Fiction', image_url: '' },
      { slug: 'old', title: 'Old Book', author: 'O', category: 'All Romance Books', image_url: '' },
    ],
    product_overrides: [{ slug: 'warm', title: '', author: 'W Author', category: '', image_url: '' }],
    deleted_products: [{ slug: 'gone', title: 'Gone', kind: 'custom', deleted_at: ago(2) }],
  };
  const real = Module._load;
  Module._load = function (req, parent, ...rest) {
    if (req === '@supabase/supabase-js') return { createClient: () => fakeDb(tables) };
    if (req === '@netlify/blobs') return { getStore: () => ({ setJSON: async (k, v) => { published[k] = v; }, get: async () => null }) };
    return real.call(this, req, parent, ...rest);
  };
  try {
    delete require.cache[require.resolve('../lifetime-sales-scheduled')];
    const { handler } = require('../lifetime-sales-scheduled');
    const res = await handler({});
    assert.equal(res.statusCode, 200, res.body);
  } finally {
    Module._load = real;
  }
  const doc = published['lifetime-sales'];
  assert.equal(doc.counts.hot, 3);
  assert.equal(doc.counts.warm, 1, 'the replacement order is not counted');
  const b = doc.bsr;
  assert.deepEqual(b.order, ['hot', 'warm', 'old']);
  assert.deepEqual(b.ranks.hot, [1, 'romance', 1]);
  assert.deepEqual(b.ranks.warm, [2, 'fiction', 1]);
  assert.deepEqual(b.ranks.old, [3, 'romance', 2], 'lifetime sales still earn a rank, after the recent sellers');
  assert.equal(b.ranks.gone, undefined, 'deleted listings are left out');
  assert.equal(b.info.hot.title, 'Hot Book');
  assert.equal(b.info.warm.author, 'W Author', 'an admin override wins');
  assert.equal(b.window_days, 30);
});
