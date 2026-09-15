const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * The DO is an ES module in worker/, outside this directory; the same dynamic
 * import rate-limiter.test.js uses.
 */
let SpendGuard;
test.before(async () => {
  ({ SpendGuard } = await import('../../../worker/spend-guard.js'));
});

/** The slice of ctx.storage the class actually uses, backed by a Map. */
function fakeState(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    storage: {
      async get(k) { return map.get(k); },
      async put(k, v) { map.set(k, v); },
      async delete(keys) { for (const k of [].concat(keys)) map.delete(k); },
      async list({ prefix } = {}) {
        return new Map([...map].filter(([k]) => !prefix || k.startsWith(prefix)));
      },
    },
  };
}

const call = (guard, params) => guard
  .fetch(new Request(`https://g/?${new URLSearchParams(params)}`))
  .then((r) => r.json());

test('it refuses once the budget is gone', async () => {
  // The whole point. A guard that only counts is the bug we already shipped
  // once with the rate limiter.
  const g = new SpendGuard(fakeState());
  const p = { month: '2026-09', budget_micros: '1000' };

  assert.equal((await call(g, { ...p, micros: '400' })).over, false);
  assert.equal((await call(g, { ...p, micros: '400' })).over, false);
  const third = await call(g, { ...p, micros: '400' });
  assert.equal(third.spent_micros, 1200);
  assert.equal(third.over, true);
  assert.equal((await call(g, p)).over, true);   // and it stays refused
});

test('the total survives the instance being evicted', async () => {
  // A month is long enough that an eviction is certain. Keeping the total in
  // memory the way RateLimiter does would hand back the whole budget here.
  const state = fakeState();
  await call(new SpendGuard(state), { month: '2026-09', budget_micros: '1000', micros: '900' });

  const reborn = new SpendGuard(state);           // fresh instance, same storage
  const res = await call(reborn, { month: '2026-09', budget_micros: '1000', micros: '200' });
  assert.equal(res.spent_micros, 1100);
  assert.equal(res.over, true);
});

test('a new month starts from zero and drops the old one', async () => {
  const state = fakeState();
  const g = new SpendGuard(state);
  await call(g, { month: '2026-09', budget_micros: '1000', micros: '5000' });
  assert.equal((await call(g, { month: '2026-09', budget_micros: '1000' })).over, true);

  const oct = await call(g, { month: '2026-10', budget_micros: '1000', micros: '10' });
  assert.equal(oct.spent_micros, 10);
  assert.equal(oct.over, false);
  assert.deepEqual([...state.map.keys()], ['spend:2026-10']);
});

test('no budget configured never locks the bot out', async () => {
  // budget_micros 0 means "not set". Reading that as a ceiling of nothing would
  // take the assistant offline the moment the env var went missing.
  const g = new SpendGuard(fakeState());
  const res = await call(g, { month: '2026-09', budget_micros: '0', micros: '99999999' });
  assert.equal(res.over, false);
});

test('a checking call reports without spending', async () => {
  const g = new SpendGuard(fakeState());
  await call(g, { month: '2026-09', budget_micros: '1000', micros: '300' });
  const a = await call(g, { month: '2026-09', budget_micros: '1000' });
  const b = await call(g, { month: '2026-09', budget_micros: '1000' });
  assert.equal(a.spent_micros, 300);
  assert.equal(b.spent_micros, 300);
});

test('a malformed month is refused rather than billed somewhere arbitrary', async () => {
  const g = new SpendGuard(fakeState());
  const res = await g.fetch(new Request('https://g/?month=september&budget_micros=1000&micros=500'));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad month');
});

test('garbage in the numbers is ignored, not counted as spend', async () => {
  const g = new SpendGuard(fakeState());
  const res = await call(g, { month: '2026-09', budget_micros: 'abc', micros: '-40' });
  assert.equal(res.spent_micros, 0);
  assert.equal(res.budget_micros, 0);
  assert.equal(res.over, false);
});
