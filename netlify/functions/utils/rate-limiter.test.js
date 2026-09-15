const test = require('node:test');
const assert = require('node:assert/strict');

// The class is ESM (the Worker entry exports it), so it loads dynamically.
const load = async () => (await import('../../../worker/rate-limiter.js')).RateLimiter;

const ask = async (limiter, { key = 'ip', limit = 3, window = 60 } = {}) => {
  const res = await limiter.fetch(
    new Request(`https://x/?key=${key}&limit=${limit}&window=${window}`));
  return res.json();
};

test('allows exactly the limit, then refuses', async () => {
  // The bug this replaces: two earlier limiters counted and then allowed
  // everything anyway. This asserts the refusal, not just the counting.
  const RateLimiter = await load();
  const l = new RateLimiter();
  const verdicts = [];
  for (let i = 0; i < 5; i++) verdicts.push((await ask(l)).allowed);
  assert.deepEqual(verdicts, [true, true, true, false, false]);
});

test('separate keys do not share a budget', async () => {
  const RateLimiter = await load();
  const l = new RateLimiter();
  for (let i = 0; i < 4; i++) await ask(l, { key: 'a' });
  assert.equal((await ask(l, { key: 'a' })).allowed, false);
  assert.equal((await ask(l, { key: 'b' })).allowed, true);
});

test('the window reopens once it has passed', async () => {
  const RateLimiter = await load();
  const l = new RateLimiter();
  for (let i = 0; i < 4; i++) await ask(l, { window: 1 });
  assert.equal((await ask(l, { window: 1 })).allowed, false);
  await new Promise(r => setTimeout(r, 1100));
  assert.equal((await ask(l, { window: 1 })).allowed, true);
});

test('retry_after tells the caller when to come back', async () => {
  const RateLimiter = await load();
  const l = new RateLimiter();
  const r = await ask(l, { window: 30 });
  assert.ok(r.retry_after > 0 && r.retry_after <= 30, `got ${r.retry_after}`);
});

test('garbage limits fall back to something sane rather than zero', async () => {
  // A limit of 0 would lock out every customer; it must never be reachable
  // through a malformed query string.
  const RateLimiter = await load();
  const l = new RateLimiter();
  const res = await l.fetch(new Request('https://x/?key=k&limit=0&window=0'));
  const r = await res.json();
  assert.equal(r.allowed, true);
  assert.ok(r.limit >= 1);
});

test('expired buckets are dropped rather than accumulating', async () => {
  const RateLimiter = await load();
  const l = new RateLimiter();
  for (let i = 0; i < 70; i++) await ask(l, { key: 'k' + i, window: 1 });
  await new Promise(r => setTimeout(r, 1100));
  await ask(l, { key: 'trigger', window: 1 });
  assert.ok(l.buckets.size < 70, `held ${l.buckets.size} buckets`);
});
