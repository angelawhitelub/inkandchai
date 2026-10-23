const test = require('node:test');
const assert = require('node:assert/strict');

const { cancelNimbusOrder } = require('./nimbuspost-cancel');

process.env.NIMBUSPOST_API_KEY = 'test-key';

// The panel list comes back empty: the order is not in NimbusPost.
function stubEmptyPanel() {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: true, data: [] }) };
  };
  return calls;
}

test('a never-pushed order missing from the panel is not a failure', async () => {
  stubEmptyPanel();
  const r = await cancelNimbusOrder('IC-20260927-FNJ90', { pushed: false });
  assert.equal(r.ok, true);
  assert.equal(r.notPushed, true);
});

test('a pushed order missing from the panel is still reported', async () => {
  stubEmptyPanel();
  const r = await cancelNimbusOrder('IC-20260927-FNJ90', { pushed: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /panel order not found/);
});

test('without the pushed flag a miss is still reported', async () => {
  stubEmptyPanel();
  const r = await cancelNimbusOrder('IC-20260927-FNJ90');
  assert.equal(r.ok, false);
});
