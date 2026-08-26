'use strict';
const test = require('node:test');
const assert = require('node:assert');

const MOD = '../../netlify/functions/auto-push-replacements-background';

function fakeDb(rows, { pushOutcome = { pushed: true } } = {}) {
  const filters = {};
  const q = {
    select() { return q; },
    eq(col, val) { filters[col] = val; return q; },
    is(col, val) { filters[col] = val; return q; },
    lte(col, val) { filters['lte:' + col] = val; return q; },
    order() { return q; },
    limit() { return Promise.resolve({ data: rows, error: null }); },
    update() { return q; },
  };
  return { filters, from: () => q, _pushOutcome: pushOutcome };
}

// pushToNimbusOnce is stubbed so the sweep is tested without touching NimbusPost.
function loadWithPushStub(record) {
  const path = require.resolve('../../netlify/functions/utils/nimbus-push-once');
  require.cache[path] = {
    id: path, filename: path, loaded: true,
    exports: { pushToNimbusOnce: async (_db, order) => { record.push(order.razorpay_order_id); return record.outcome || { pushed: true }; } },
  };
  delete require.cache[require.resolve(MOD)];
  return require(MOD);
}

const repl = (over = {}) => ({
  razorpay_order_id: 'IC-R-20260825-AAAAA',
  status: 'replacement_pending',
  customer_address: '7/5 Valasaravakkam, Chennai 600087',
  cart_items: [{ title: 'Ikigai', qty: 1 }],
  ...over,
});

test('a replacement with an address and books is pushed', async () => {
  const seen = [];
  const { _runSweep } = loadWithPushStub(seen);
  const out = await _runSweep(fakeDb([repl()]));
  assert.deepStrictEqual(out.pushed, ['IC-R-20260825-AAAAA']);
  assert.deepStrictEqual(seen, ['IC-R-20260825-AAAAA']);
});

test('a replacement with no address is skipped, not pushed', async () => {
  const seen = [];
  const { _runSweep } = loadWithPushStub(seen);
  const out = await _runSweep(fakeDb([repl({ customer_address: '   ' })]));
  assert.strictEqual(out.pushed.length, 0);
  assert.strictEqual(seen.length, 0, 'must not reach NimbusPost');
  assert.match(out.skipped[0].reason, /no delivery address/);
});

test('an address without a pincode is skipped — the courier would reject it', () => {
  const { _shippable } = require(MOD);
  assert.match(_shippable(repl({ customer_address: 'Aundh, Pune' })), /pincode/);
  assert.strictEqual(_shippable(repl()), '');
});

test('an empty box is never shipped', () => {
  const { _shippable } = require(MOD);
  assert.match(_shippable(repl({ cart_items: [] })), /no books/);
});

test('a push failure is reported, not silently counted as sent', async () => {
  const seen = [];
  seen.outcome = { pushed: false, reason: 'push_failed', error: 'pincode not serviceable' };
  const { _runSweep } = loadWithPushStub(seen);
  const out = await _runSweep(fakeDb([repl()]));
  assert.strictEqual(out.pushed.length, 0);
  assert.match(out.failed[0].reason, /not serviceable/);
});

test('an order already in the panel is not pushed twice', async () => {
  const seen = [];
  seen.outcome = { pushed: false, reason: 'already_pushed' };
  const { _runSweep } = loadWithPushStub(seen);
  const out = await _runSweep(fakeDb([repl()]));
  assert.strictEqual(out.pushed.length, 0);
  assert.strictEqual(out.failed.length, 0);
  assert.match(out.skipped[0].reason, /already pushed/);
});

test('a dry run touches nothing', async () => {
  const seen = [];
  const { _runSweep } = loadWithPushStub(seen);
  const out = await _runSweep(fakeDb([repl()]), { dryRun: true });
  assert.deepStrictEqual(out.pushed, ['IC-R-20260825-AAAAA']);
  assert.strictEqual(seen.length, 0, 'dry run must not push');
});

test('the query only ever asks for unpushed, un-AWBed pending replacements', async () => {
  const seen = [];
  const { _runSweep } = loadWithPushStub(seen);
  const db = fakeDb([]);
  await _runSweep(db);
  assert.strictEqual(db.filters.status, 'replacement_pending');
  assert.strictEqual(db.filters.nimbus_pushed_at, null);
  assert.strictEqual(db.filters.tracking_id, null);
  // The grace window is no longer a SQL cutoff: it is applied per row, because
  // an owner-created replacement skips it entirely and a cutoff in the query
  // would have hidden those rows from the sweep for two hours.
  assert.strictEqual(db.filters['lte:created_at'], undefined);
});

const minutesAgo = m => new Date(Date.now() - m * 60 * 1000).toISOString();
const ownerMade = over => repl({
  cart_items: [{ title: 'Ikigai', qty: 1, _replacement: { created_by: 'admin' } }],
  ...over,
});

test('a customer-raised replacement inside the edit window is held, not pushed', async () => {
  const seen = [];
  const { _runSweep } = loadWithPushStub(seen);
  process.env.REPLACEMENT_PUSH_GRACE_MINUTES = '120';
  const out = await _runSweep(fakeDb([repl({ created_at: minutesAgo(10) })]));
  delete process.env.REPLACEMENT_PUSH_GRACE_MINUTES;
  assert.deepStrictEqual(out.pushed, []);
  assert.strictEqual(seen.length, 0);
  assert.match(out.skipped[0].reason, /edit window/);
});

test('a customer-raised replacement past the edit window is pushed', async () => {
  const seen = [];
  const { _runSweep } = loadWithPushStub(seen);
  process.env.REPLACEMENT_PUSH_GRACE_MINUTES = '120';
  const out = await _runSweep(fakeDb([repl({ created_at: minutesAgo(200) })]));
  delete process.env.REPLACEMENT_PUSH_GRACE_MINUTES;
  assert.deepStrictEqual(out.pushed, ['IC-R-20260825-AAAAA']);
});

test('an owner-created replacement skips the edit window — the owner picked the books', async () => {
  const seen = [];
  const { _runSweep } = loadWithPushStub(seen);
  process.env.REPLACEMENT_PUSH_GRACE_MINUTES = '120';
  const out = await _runSweep(fakeDb([ownerMade({ created_at: minutesAgo(1) })]));
  delete process.env.REPLACEMENT_PUSH_GRACE_MINUTES;
  assert.deepStrictEqual(out.pushed, ['IC-R-20260825-AAAAA']);
  assert.deepStrictEqual(seen, ['IC-R-20260825-AAAAA']);
});

test('grace 0 pushes a fresh customer-raised replacement immediately', async () => {
  const seen = [];
  const { _runSweep } = loadWithPushStub(seen);
  process.env.REPLACEMENT_PUSH_GRACE_MINUTES = '0';
  const out = await _runSweep(fakeDb([repl({ created_at: minutesAgo(0) })]));
  delete process.env.REPLACEMENT_PUSH_GRACE_MINUTES;
  assert.deepStrictEqual(out.pushed, ['IC-R-20260825-AAAAA']);
});
