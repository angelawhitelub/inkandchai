import test from 'node:test';
import assert from 'node:assert';
import Module, { createRequire } from 'node:module';

// The Worker build aliases @netlify/blobs to its KV shim (wrangler.toml); do the same here.
const shim = createRequire(import.meta.url).resolve('../../worker/shims/netlify-blobs.js');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return resolve.call(this, req === '@netlify/blobs' ? shim : req, ...rest); };
const { default: routeTable } = await import('../../worker/routes.generated.js');
const { XbBookingJob } = await import('../../worker/xb-booking-job.js');

// Durable Object storage and alarms, in memory. Alarms are run by hand.
function fakeCtx() {
  const m = new Map();
  const ctx = {
    alarmAt: null,
    blockConcurrencyWhile: (fn) => fn(),
    storage: {
      get: async (k) => structuredClone(m.get(k)),
      put: async (k, v) => { m.set(k, structuredClone(v)); },
      list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix))),
      deleteAll: async () => { m.clear(); ctx.alarmAt = null; },
      setAlarm: async (t) => { ctx.alarmAt = t; },
    },
  };
  return ctx;
}
const call = async (obj, body) => (await obj.fetch(new Request('https://x/', { method: 'POST', body: JSON.stringify(body) }))).json();
async function drain(obj, ctx) {
  for (let i = 0; i < 50 && ctx.alarmAt != null; i++) { ctx.alarmAt = null; await obj.alarm(); }
}

function stubShip(t, processOrders) {
  const mod = routeTable.routes['xpressbees-ship'];
  const mails = [];
  t.mock.method(mod, 'processOrders', processOrders);
  t.mock.method(mod, 'jobFinished', async (job) => { mails.push(job); return { sent: true }; });
  return mails;
}
const ids = (n) => Array.from({ length: n }, (_, i) => 'order_' + i);

test('a booking runs to the end in chunks without the tab, then emails the result', async (t) => {
  const seen = [];
  const mails = stubShip(t, async (chunk, opts) => {
    seen.push({ n: chunk.length, dry: opts.dry_run });
    return { booked: chunk.map(id => ({ order_id: id, awb: 'A' + id })), failed: [], skipped: [] };
  });
  const ctx = fakeCtx();
  const obj = new XbBookingJob(ctx, {});
  const started = await call(obj, { action: 'start', job: { mode: 'book', order_ids: ids(30) } });
  assert.equal(started.job.state, 'running');
  await drain(obj, ctx);

  assert.deepEqual(seen.map(s => s.n), [12, 12, 6]);
  assert.ok(seen.every(s => s.dry === false));
  const { job } = await call(obj, { action: 'status' });
  assert.equal(job.state, 'done');
  assert.equal(job.booked.length, 30);
  assert.deepEqual(job.not_attempted, []);
  assert.equal(mails.length, 1);
  assert.deepEqual(job.email, { sent: true });
});

test('a second run cannot start while one is going, and a running one cannot be cleared', async (t) => {
  stubShip(t, async (chunk) => ({ booked: chunk.map(id => ({ order_id: id })), failed: [], skipped: [] }));
  const ctx = fakeCtx();
  const obj = new XbBookingJob(ctx, {});
  await call(obj, { action: 'start', job: { mode: 'preview', order_ids: ids(40) } });
  const again = await obj.fetch(new Request('https://x/', { method: 'POST', body: JSON.stringify({ action: 'start', job: { mode: 'book', order_ids: ids(2) } }) }));
  assert.equal(again.status, 409);
  const dismiss = await obj.fetch(new Request('https://x/', { method: 'POST', body: JSON.stringify({ action: 'dismiss' }) }));
  assert.equal(dismiss.status, 409);
  await drain(obj, ctx);
  assert.equal((await call(obj, { action: 'status' })).job.booked.length, 40);
  await call(obj, { action: 'dismiss' });
  assert.equal((await call(obj, { action: 'status' })).job, null);
});

test('an empty wallet stops the run and lists what was not attempted', async (t) => {
  let n = 0;
  stubShip(t, async (chunk) => (++n === 1
    ? { booked: [{ order_id: chunk[0] }], failed: [{ order_id: chunk[1], kind: 'wallet' }], skipped: chunk.slice(2).map(id => ({ order_id: id, kind: 'wallet_stop' })) }
    : assert.fail('no chunk after the wallet ran out')));
  const ctx = fakeCtx();
  const obj = new XbBookingJob(ctx, {});
  await call(obj, { action: 'start', job: { mode: 'book', order_ids: ids(20) } });
  await drain(obj, ctx);
  const { job } = await call(obj, { action: 'status' });
  assert.equal(job.stop_reason, 'wallet');
  assert.equal(job.not_attempted.length, 8);
});

test('a chunk that throws is retried, then the run stops with the error', async (t) => {
  const mails = stubShip(t, async () => { throw new Error('supabase down'); });
  const ctx = fakeCtx();
  const obj = new XbBookingJob(ctx, {});
  await call(obj, { action: 'start', job: { mode: 'book', order_ids: ids(3) } });
  const delays = [];
  for (let i = 0; i < 10 && ctx.alarmAt != null; i++) { if (i) delays.push(ctx.alarmAt - Date.now()); ctx.alarmAt = null; await obj.alarm(); }
  const { job } = await call(obj, { action: 'status' });
  assert.equal(job.state, 'done');
  assert.equal(job.stop_reason, 'error');
  assert.match(job.error, /supabase down/);
  assert.equal(job.not_attempted.length, 3);
  assert.equal(delays.length, 3, 'three retries after the first try');
  assert.equal(mails.length, 1);
});
