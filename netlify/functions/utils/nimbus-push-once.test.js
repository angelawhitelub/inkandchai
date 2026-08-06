const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the network push before requiring the module under test.
const importPath = require.resolve('./nimbuspost-import');
const pushed = [];
let pushBehaviour = async () => {};
require.cache[importPath] = {
  id: importPath,
  filename: importPath,
  loaded: true,
  exports: {
    pushOrderToNimbusPost: async (order) => { pushed.push(order); return pushBehaviour(order); },
  },
};

const { pushToNimbusOnce } = require('./nimbus-push-once');

/**
 * Minimal Supabase double modelling the one thing that matters: an UPDATE
 * with `.is('nimbus_pushed_at', null)` matches a row only while the stamp is
 * still null, which is what makes the claim exclusive.
 */
function fakeSupabase(initialStamp = null) {
  const state = { stamp: initialStamp, updates: [] };
  const client = {
    from() {
      const q = { _patch: null, _requireNull: false };
      q.update = (patch) => { q._patch = patch; return q; };
      q.eq = () => q;
      q.is = (col, val) => { if (col === 'nimbus_pushed_at' && val === null) q._requireNull = true; return q; };
      q.select = () => {
        state.updates.push(q._patch);
        if (q._requireNull && state.stamp !== null) return Promise.resolve({ data: [], error: null });
        state.stamp = q._patch.nimbus_pushed_at;
        return Promise.resolve({ data: [{ id: 'row-1' }], error: null });
      };
      // A release (`update({nimbus_pushed_at:null})`) has no .select(); it is
      // awaited directly, so the builder must be thenable.
      q.then = (res, rej) => {
        state.updates.push(q._patch);
        state.stamp = q._patch.nimbus_pushed_at;
        return Promise.resolve({ data: null, error: null }).then(res, rej);
      };
      q.catch = () => q;
      return q;
    },
  };
  return { client, state };
}

test.beforeEach(() => { pushed.length = 0; pushBehaviour = async () => {}; });

test('pushes once and stamps the order', async () => {
  const { client, state } = fakeSupabase();
  const r = await pushToNimbusOnce(client, { id: 'row-1', razorpay_order_id: 'IC-1' });
  assert.deepEqual(r, { pushed: true });
  assert.equal(pushed.length, 1);
  assert.notEqual(state.stamp, null);
});

test('stands down when the other path already claimed it', async () => {
  const { client } = fakeSupabase('2026-08-07T00:00:00.000Z');
  const r = await pushToNimbusOnce(client, { id: 'row-1', razorpay_order_id: 'IC-1' });
  assert.equal(r.pushed, false);
  assert.equal(r.reason, 'already_pushed');
  assert.equal(pushed.length, 0, 'must not create a second panel order');
});

test('two simultaneous callers produce exactly one push', async () => {
  const { client } = fakeSupabase();
  const order = { id: 'row-1', razorpay_order_id: 'IC-1' };
  const [a, b] = await Promise.all([pushToNimbusOnce(client, order), pushToNimbusOnce(client, order)]);
  assert.equal(pushed.length, 1);
  assert.equal([a, b].filter((r) => r.pushed).length, 1);
});

test('a failed push releases the claim so it can be retried', async () => {
  const { client, state } = fakeSupabase();
  pushBehaviour = async () => { throw new Error('NimbusPost 500'); };
  const r = await pushToNimbusOnce(client, { id: 'row-1', razorpay_order_id: 'IC-1' });
  assert.equal(r.pushed, false);
  assert.equal(r.reason, 'push_failed');
  assert.equal(state.stamp, null, 'stamp must be cleared or the order strands forever');

  // ...and the retry now succeeds.
  pushBehaviour = async () => {};
  const again = await pushToNimbusOnce(client, { id: 'row-1', razorpay_order_id: 'IC-1' });
  assert.equal(again.pushed, true);
  assert.equal(pushed.length, 2);
});

test('never throws — every caller treats the push as non-fatal', async () => {
  const exploding = { from() { throw new Error('supabase down'); } };
  const r = await pushToNimbusOnce(exploding, { id: 'row-1' });
  assert.equal(r.pushed, false);
  assert.equal(r.reason, 'claim_failed');
});

test('falls back to the IC- id when no uuid is present', async () => {
  const { client } = fakeSupabase();
  const r = await pushToNimbusOnce(client, { razorpay_order_id: 'IC-1' });
  assert.equal(r.pushed, true);
});

test('refuses an order with no key at all', async () => {
  const { client } = fakeSupabase();
  const r = await pushToNimbusOnce(client, {});
  assert.equal(r.pushed, false);
  assert.equal(r.reason, 'no_order_key');
  assert.equal(pushed.length, 0);
});
