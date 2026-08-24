const test = require('node:test');
const assert = require('node:assert');
const { toOrderRow, reconcileFromNeon, isEnabled } = require('../../netlify/functions/utils/neon-mirror');

function fakeSupabase({ existing = [], insert = () => ({ error: null }) } = {}) {
  const calls = { inserts: [] };
  return {
    calls,
    from() {
      return {
        insert(row) { calls.inserts.push(row); return Promise.resolve(insert(row)); },
        select: () => ({
          eq: (_c, v) => ({ maybeSingle: async () => ({ data: existing.includes(v) ? { id: 1 } : null, error: null }) }),
        }),
      };
    },
  };
}

// A standby row as Postgres hands it back: bigint as a string, timestamp as a Date.
const STANDBY = {
  razorpay_order_id: 'IC-20260824-ABCDE',
  razorpay_payment_id: 'OM123W',
  amount_paise: '21900',
  status: 'paid',
  customer_name: 'Test Buyer',
  customer_email: 'buyer@example.com',
  customer_phone: '9876543210',
  customer_address: 'Somewhere',
  cart_items: [{ qty: 1, title: 'A Book', price: 179 }],
  user_id: null,
  order_created_at: new Date('2026-08-24T04:58:05.159Z'),
};

test('a standby row converts back into an insertable order', () => {
  const row = toOrderRow(STANDBY);
  // bigint arrives as a string; inserting that into amount_paise skews every
  // total that is computed from it.
  assert.strictEqual(row.amount_paise, 21900);
  assert.strictEqual(typeof row.amount_paise, 'number');
  assert.strictEqual(row.created_at, '2026-08-24T04:58:05.159Z');
  assert.deepStrictEqual(row.cart_items, STANDBY.cart_items);
  assert.strictEqual(row.razorpay_order_id, 'IC-20260824-ABCDE');
  assert.ok(!('order_created_at' in row), 'the standby-only column must not be inserted');
});

test('a row with no timestamp does not invent one', () => {
  const row = toOrderRow({ ...STANDBY, order_created_at: null });
  assert.ok(!('created_at' in row));
});

test('a null amount stays null rather than becoming zero', () => {
  assert.strictEqual(toOrderRow({ ...STANDBY, amount_paise: null }).amount_paise, null);
});

test('the standby is inert until it is configured', async () => {
  const before = process.env.NEON_DATABASE_URL;
  delete process.env.NEON_DATABASE_URL;
  delete process.env.NEON_POSTGRES_URL;

  assert.strictEqual(isEnabled(), false);
  const supabase = fakeSupabase();
  const out = await reconcileFromNeon(supabase);
  assert.strictEqual(out.enabled, false);
  assert.strictEqual(out.checked, 0);
  // Nothing touched — deploying this before the Neon project exists is a no-op.
  assert.strictEqual(supabase.calls.inserts.length, 0);

  if (before !== undefined) process.env.NEON_DATABASE_URL = before;
});
