const test = require('node:test');
const assert = require('node:assert/strict');
const { grantEbook } = require('./ebook-grant');

/** Just enough of the Supabase builder for the two calls grantEbook makes. */
function fakeDb({ existing = null, insertError = null } = {}) {
  const inserts = [];
  return {
    inserts,
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: existing }),
        insert: async (row) => { inserts.push(row); return { error: insertError }; },
      };
    },
  };
}

const args = {
  slug: 'atomic-habits-abc12', userId: 'user-1', email: 'a@b.com',
  paymentId: 'pay_123', orderId: 'order_123', amountPaise: 19900,
};

test('a first payment grants the book', async () => {
  const db = fakeDb();
  const res = await grantEbook(db, args);
  assert.equal(res.ok, true);
  assert.equal(db.inserts.length, 1);
  assert.equal(db.inserts[0].slug, 'atomic-habits-abc12');
  assert.equal(db.inserts[0].payment_id, 'pay_123');
});

test('the second path for the same payment writes nothing', async () => {
  // The browser and the webhook both call this. Two rows for one payment would
  // double-count sales and make a refund ambiguous.
  const db = fakeDb({ existing: { id: 'ent-1' } });
  const res = await grantEbook(db, args);
  assert.equal(res.ok, true);
  assert.equal(res.already, true);
  assert.equal(db.inserts.length, 0);
});

test('losing the insert race still counts as granted', async () => {
  // Both paths can pass the existence check within the same millisecond; the
  // loser gets a unique violation. The customer has the book, so that is a
  // success — reporting it as a failure would make the webhook retry forever.
  const db = fakeDb({ insertError: { message: 'duplicate key value violates unique constraint' } });
  const res = await grantEbook(db, args);
  assert.equal(res.ok, true);
  assert.equal(res.already, true);
});

test('a real database failure is reported, not swallowed', async () => {
  // This is the case where someone paid and has nothing. It has to surface so
  // the webhook returns non-2xx and Razorpay retries.
  const db = fakeDb({ insertError: { message: 'connection terminated' } });
  const res = await grantEbook(db, args);
  assert.equal(res.ok, false);
  assert.match(res.error, /connection terminated/);
});

test('an incomplete grant is refused rather than written half-formed', async () => {
  // A row with no user_id belongs to nobody and can never be downloaded.
  for (const missing of [{ userId: '' }, { slug: '' }, { paymentId: '' }]) {
    const res = await grantEbook(fakeDb(), { ...args, ...missing });
    assert.equal(res.ok, false);
  }
});
