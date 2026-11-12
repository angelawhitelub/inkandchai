'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clearXbQueueRows } = require('./xb-queue-clear');

const spy = (reply) => { const calls = []; const fn = async (a) => { calls.push(a); if (reply instanceof Error) throw reply; return reply; }; fn.calls = calls; return fn; };

test('clears named cancelled orders through the guarded endpoint, newest pages only', async () => {
  const cancel = spy({ statusCode: 200, data: { results: [{ orders: ['IC-1'], ok: true }] } });
  const r = await clearXbQueueRows(['ic-1', 'IC-1', ''], { cancel });
  assert.equal(r.action, 'cleared');
  assert.deepEqual(r.cleared, ['IC-1']);
  assert.deepEqual(cancel.calls[0], { dry_run: false, any_courier: true, closed_here: true, strict: false, order_ids: ['IC-1'], max_pages: 3, limit: 50 });
});

test('nothing in the panel is a quiet no-op', async () => {
  const r = await clearXbQueueRows(['IC-2'], { cancel: spy({ statusCode: 200, data: { results: [] } }) });
  assert.equal(r.action, 'none');
  assert.equal(r.message, '');
});

test('errors are reported, never thrown', async () => {
  const a = await clearXbQueueRows(['IC-3'], { cancel: spy({ statusCode: 502, data: { error: 'could not read' } }) });
  assert.equal(a.action, 'failed');
  assert.match(a.message, /could not read/);
  const b = await clearXbQueueRows(['IC-3'], { cancel: spy(new Error('boom')) });
  assert.equal(b.action, 'failed');
  const c = await clearXbQueueRows(['IC-3'], { cancel: spy({ statusCode: 200, data: { results: [{ orders: ['IC-3'], ok: false }] } }) });
  assert.deepEqual(c.failed, ['IC-3']);
});

test('the off switch and an empty list do nothing', async () => {
  const cancel = spy({ statusCode: 200, data: {} });
  assert.equal((await clearXbQueueRows([], { cancel })).action, 'none');
  process.env.XPRESSBEES_QUEUE_CLEANUP = 'off';
  try { assert.equal((await clearXbQueueRows(['IC-4'], { cancel })).action, 'off'); }
  finally { delete process.env.XPRESSBEES_QUEUE_CLEANUP; }
  assert.equal(cancel.calls.length, 0);
});
