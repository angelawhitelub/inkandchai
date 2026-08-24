const test = require('node:test');
const assert = require('node:assert');
const { stashWithStore, replayWithStore, mirrorWithStore, tombstoneWithStore,
  reconcileWithStore, keyFor, MAX_REPLAY_ATTEMPTS } =
  require('../../netlify/functions/utils/order-fallback');

// In-memory stand-in for a Netlify Blobs store. Only the four methods the
// module uses; the real store is never reached from a test.
function fakeStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(key) { return data.has(key) ? JSON.parse(data.get(key)) : null; },
    async setJSON(key, value) { data.set(key, JSON.stringify(value)); },
    async delete(key) { data.delete(key); },
    async list() { return { blobs: [...data.keys()].map(key => ({ key })) }; },
  };
}

// Minimal supabase.from('orders') double. `insert` returns whatever the script
// says; `select(...).eq(...).maybeSingle()` answers the existence pre-check.
function fakeSupabase({ insert = () => ({ error: null }), existing = [] } = {}) {
  const calls = { inserts: [] };
  return {
    calls,
    from() {
      return {
        insert(row) { calls.inserts.push(row); return Promise.resolve(insert(row)); },
        select() {
          return {
            eq(_col, val) {
              return { maybeSingle: async () => ({ data: existing.includes(val) ? { id: 1 } : null, error: null }) };
            },
          };
        },
      };
    },
  };
}

const ROW = {
  razorpay_order_id: 'IC-20260824-ABCDE',
  razorpay_payment_id: null,
  amount_paise: 72200,
  status: 'cod_pending',
  customer_name: 'Test Buyer',
  customer_phone: '9876543210',
  cart_items: [{ slug: 'a-book', qty: 1 }],
};

test('stash writes the order row back verbatim', async () => {
  const store = fakeStore();
  const res = await stashWithStore(store, ROW, { source: 'cod-order', reason: 'connection refused' });
  assert.strictEqual(res.stashed, true);
  const entry = await store.get(keyFor(ROW));
  assert.deepStrictEqual(entry.row, ROW);
  assert.strictEqual(entry.source, 'cod-order');
  assert.strictEqual(entry.reason, 'connection refused');
});

test('the blob key is the order id, so a retry overwrites instead of duplicating', async () => {
  const store = fakeStore();
  await stashWithStore(store, ROW, { source: 'cod-order', reason: 'first' });
  const first = await store.get(keyFor(ROW));
  await stashWithStore(store, ROW, { source: 'cod-order', reason: 'second' });
  assert.strictEqual(store.data.size, 1);
  const second = await store.get(keyFor(ROW));
  // stashed_at is when the order was first lost — a retry must not reset it.
  assert.strictEqual(second.stashed_at, first.stashed_at);
  assert.strictEqual(second.reason, 'second');
});

test('a stash failure never throws into the checkout it is protecting', async () => {
  const broken = { ...fakeStore(), setJSON: async () => { throw new Error('blobs down'); } };
  const res = await stashWithStore(broken, ROW, { source: 'cod-order', reason: 'x' });
  assert.strictEqual(res.stashed, false);
});

test('replay inserts the parked order and empties the pen', async () => {
  const store = fakeStore();
  await stashWithStore(store, ROW, { source: 'cod-order', reason: 'paused project' });
  const supabase = fakeSupabase();
  const out = await replayWithStore(store, supabase);
  assert.strictEqual(out.restored, 1);
  assert.strictEqual(out.failed, 0);
  assert.deepStrictEqual(supabase.calls.inserts[0], ROW);
  assert.strictEqual(store.data.size, 0);
});

test('an order that arrived by another route is dropped, not inserted twice', async () => {
  const store = fakeStore();
  await stashWithStore(store, ROW, { source: 'verify-payment', reason: 'timeout' });
  // The pre-check finds it. COD rows have a NULL payment id, so there is no
  // unique index to raise 23505 — this check is the only thing standing between
  // a replay and a duplicate order.
  const supabase = fakeSupabase({ existing: [ROW.razorpay_order_id] });
  const out = await replayWithStore(store, supabase);
  assert.strictEqual(out.deduped, 1);
  assert.strictEqual(supabase.calls.inserts.length, 0);
  assert.strictEqual(store.data.size, 0);
});

test('a unique violation on insert also counts as already-there', async () => {
  const store = fakeStore();
  await stashWithStore(store, ROW, { source: 'verify-payment', reason: 'timeout' });
  const supabase = fakeSupabase({ insert: () => ({ error: { code: '23505', message: 'duplicate key' } }) });
  const out = await replayWithStore(store, supabase);
  assert.strictEqual(out.deduped, 1);
  assert.strictEqual(store.data.size, 0);
});

test('a failed replay keeps the order and counts the attempt', async () => {
  const store = fakeStore();
  await stashWithStore(store, ROW, { source: 'cod-order', reason: 'paused project' });
  const supabase = fakeSupabase({ insert: () => ({ error: { code: '08006', message: 'connection failure' } }) });

  const out = await replayWithStore(store, supabase);
  assert.strictEqual(out.failed, 1);
  assert.strictEqual(out.restored, 0);
  // Losing the row is the exact bug being fixed here.
  assert.strictEqual(store.data.size, 1);
  const entry = await store.get(keyFor(ROW));
  assert.strictEqual(entry.attempts, 1);
  assert.strictEqual(entry.last_error, 'connection failure');
  assert.deepStrictEqual(entry.row, ROW);
});

test('a row past the retry cap is flagged but still not deleted', async () => {
  const store = fakeStore();
  await stashWithStore(store, ROW, { source: 'cod-order', reason: 'bad column' });
  const key = keyFor(ROW);
  await store.setJSON(key, { ...(await store.get(key)), attempts: MAX_REPLAY_ATTEMPTS - 1 });

  const supabase = fakeSupabase({ insert: () => ({ error: { code: '42703', message: 'column does not exist' } }) });
  const out = await replayWithStore(store, supabase);
  assert.strictEqual(out.abandoned, 1);
  assert.strictEqual(store.data.size, 1);
});

test('a lookup failure leaves the order parked and does not insert', async () => {
  const store = fakeStore();
  await stashWithStore(store, ROW, { source: 'cod-order', reason: 'outage' });
  const supabase = {
    calls: { inserts: [] },
    from() {
      return {
        insert(row) { this.calls?.inserts.push(row); return Promise.resolve({ error: null }); },
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'still down' } }) }) }),
      };
    },
  };
  const out = await replayWithStore(store, supabase);
  assert.strictEqual(out.failed, 1);
  assert.strictEqual(out.restored, 0);
  assert.strictEqual(store.data.size, 1);
});

test('replay of an empty pen is a no-op', async () => {
  const out = await replayWithStore(fakeStore(), fakeSupabase());
  assert.strictEqual(out.found, 0);
  assert.strictEqual(out.restored, 0);
  assert.deepStrictEqual(out.errors, []);
});

test('a missing blob store degrades quietly instead of throwing', async () => {
  assert.strictEqual((await stashWithStore(null, ROW, {})).stashed, false);
  const out = await replayWithStore(null, fakeSupabase());
  assert.strictEqual(out.found, 0);
  assert.strictEqual(out.errors.length, 1);
});

test('a slug-hostile order id still makes a safe blob key', () => {
  assert.strictEqual(keyFor({ razorpay_order_id: 'IC/2026 08:24' }), 'IC_2026_08_24.json');
  assert.strictEqual(keyFor({}), 'unknown.json');
});

// ── mirror: the backup copy of every order, not just the failed ones ────────

test('every order is mirrored, and re-mirroring keeps the first timestamp', async () => {
  const store = fakeStore();
  await mirrorWithStore(store, ROW, { source: 'cod-order' });
  const first = await store.get(keyFor(ROW));
  assert.deepStrictEqual(first.row, ROW);
  assert.strictEqual(first.source, 'cod-order');

  await mirrorWithStore(store, { ...ROW, status: 'paid' }, { source: 'cod-order' });
  const second = await store.get(keyFor(ROW));
  assert.strictEqual(second.mirrored_at, first.mirrored_at);
  assert.strictEqual(second.row.status, 'paid');
  assert.strictEqual(store.data.size, 1);
});

test('reconcile restores an order the database no longer has', async () => {
  const store = fakeStore();
  await mirrorWithStore(store, ROW, { source: 'cod-order' });
  const supabase = fakeSupabase();               // nothing in the DB
  const out = await reconcileWithStore(store, supabase);
  assert.strictEqual(out.restored, 1);
  assert.deepStrictEqual(out.missing, [ROW.razorpay_order_id]);
  assert.deepStrictEqual(supabase.calls.inserts[0], ROW);
  // The mirror keeps its copy — it is a backup, not a queue.
  assert.strictEqual(store.data.size, 1);
});

test('reconcile leaves an order that is already in the database alone', async () => {
  const store = fakeStore();
  await mirrorWithStore(store, ROW, { source: 'cod-order' });
  const supabase = fakeSupabase({ existing: [ROW.razorpay_order_id] });
  const out = await reconcileWithStore(store, supabase);
  assert.strictEqual(out.present, 1);
  assert.strictEqual(out.restored, 0);
  assert.strictEqual(supabase.calls.inserts.length, 0);
});

test('a deliberately deleted order is never resurrected', async () => {
  const store = fakeStore();
  await mirrorWithStore(store, ROW, { source: 'cod-order' });
  await tombstoneWithStore(store, ROW.razorpay_order_id, 'deleted from admin');

  const supabase = fakeSupabase();               // gone from the DB, as intended
  const out = await reconcileWithStore(store, supabase);
  assert.strictEqual(out.tombstoned, 1);
  assert.strictEqual(out.restored, 0);
  assert.strictEqual(supabase.calls.inserts.length, 0);

  // And a later checkout writing the same id must not clear the tombstone.
  const again = await mirrorWithStore(store, ROW, { source: 'cod-order' });
  assert.strictEqual(again.mirrored, false);
  assert.ok((await store.get(keyFor(ROW))).deleted_at);
});

test('reconcile ignores entries older than the window', async () => {
  const store = fakeStore();
  await mirrorWithStore(store, ROW, { source: 'cod-order' });
  const key = keyFor(ROW);
  const old = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
  await store.setJSON(key, { ...(await store.get(key)), mirrored_at: old });

  const out = await reconcileWithStore(store, fakeSupabase());
  assert.strictEqual(out.stale, 1);
  assert.strictEqual(out.restored, 0);
});

test('reconcile dry run reports what is missing without writing', async () => {
  const store = fakeStore();
  await mirrorWithStore(store, ROW, { source: 'cod-order' });
  const supabase = fakeSupabase();
  const out = await reconcileWithStore(store, supabase, { dryRun: true });
  assert.deepStrictEqual(out.missing, [ROW.razorpay_order_id]);
  assert.strictEqual(out.restored, 0);
  assert.strictEqual(supabase.calls.inserts.length, 0);
});

test('a mirror write failure never throws into checkout', async () => {
  const broken = { ...fakeStore(), setJSON: async () => { throw new Error('blobs down'); } };
  assert.strictEqual((await mirrorWithStore(broken, ROW, {})).mirrored, false);
  assert.strictEqual((await mirrorWithStore(null, ROW, {})).mirrored, false);
});
