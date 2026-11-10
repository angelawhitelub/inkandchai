const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

function loadWithStore() {
  const data = {};
  const fake = { getStore: () => ({ get: async (k) => (data[k] ? JSON.parse(data[k]) : null), setJSON: async (k, v) => { data[k] = JSON.stringify(v); } }) };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === '@netlify/blobs' ? fake : orig.call(this, req, ...rest); };
  delete require.cache[require.resolve('./qty-limits')];
  try { return { L: require('./qty-limits'), data }; } finally { Module._load = orig; }
}

test('limits are set, replaced, cleared and validated', async () => {
  const { L } = loadWithStore();
  await L.setLimit('/product/Belonging/', 2, { title: 'Belonging' });
  assert.deepEqual(await L.limitMap(), { belonging: 2 });
  await L.setLimit('belonging', '5');
  assert.equal((await L.readLimits()).length, 1);
  assert.equal((await L.limitMap()).belonging, 5);
  await L.setLimit('belonging', '');
  assert.deepEqual(await L.limitMap(), {});
  await assert.rejects(L.setLimit('belonging', 1.5 * 1000), /1 to 999/);
  await assert.rejects(L.setLimit('', 2), /slug/);
  delete require.cache[require.resolve('./qty-limits')];
});
