const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./free-delivery');

// from(table).select().or(filter) → rows whose slug matches.
function fakeDb(rows, { error } = {}) {
  return {
    from: (table) => ({
      select: () => ({
        or: async (filter) => {
          if (error) return { data: null, error };
          assert.equal(table, F.TABLE);
          const wanted = new Set(filter.split(',').map((f) => f.replace(/^slug\.ilike\./, '')));
          return { data: rows.filter((r) => wanted.has(r.slug.toLowerCase())), error: null };
        },
      }),
    }),
  };
}

test('one free-delivery book ships the whole order free, at any total', () => {
  assert.equal(F.orderShipping([{ price: 199 }], 199), 40);
  assert.equal(F.orderShipping([{ price: 199, _free_delivery: true }, { price: 150 }], 349), 0);
  assert.equal(F.orderShipping([{ price: 499 }], 499), 0, '₹499 is already free');
  assert.equal(F.orderShipping([{ price: 300, _free_delivery: 'true' }], 300), 40, 'only the server flag counts');
});

test('lookup is case-insensitive; before the migration nothing ships free and nothing throws', async () => {
  const set = await F.freeDeliveryFor(fakeDb([{ slug: 'Rare-Book' }]), ['rare-book', 'other']);
  assert.deepEqual([...set], ['rare-book']);
  const missing = fakeDb([], { error: { code: '42P01', message: 'relation "product_free_delivery" does not exist' } });
  assert.equal((await F.freeDeliveryFor(missing, ['rare-book'])).size, 0);
  assert.equal((await F.freeDeliveryFor(null, ['rare-book'])).size, 0);
});

test('free delivery depends on how the order is paid', () => {
  const { orderShipping, freeByAmount, shippingMode } = require('./free-delivery');
  // Prepaid: strictly above ₹399.
  assert.equal(orderShipping([], 399, 'prepaid'), 40);
  assert.equal(orderShipping([], 400, 'prepaid'), 0);
  // COD (and partial COD): from ₹499.
  assert.equal(orderShipping([], 498, 'cod'), 40);
  assert.equal(orderShipping([], 499, 'cod'), 0);
  assert.equal(orderShipping([], 450, 'partial_cod'), 40);
  // No mode = the dearer COD rule.
  assert.equal(orderShipping([], 450), 40);
  // A free-delivery book still ships the whole order free on either.
  assert.equal(orderShipping([{ _free_delivery: true }], 100, 'cod'), 0);
  assert.equal(shippingMode('online'), 'prepaid');
  assert.equal(shippingMode('partial_cod'), 'cod');
  assert.equal(freeByAmount(400, 'prepaid'), true);
});
