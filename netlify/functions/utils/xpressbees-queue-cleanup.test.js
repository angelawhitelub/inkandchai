'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runCleanup } = require('../xpressbees-queue-cleanup-scheduled');

function spy(reply) {
  const calls = [];
  const fn = async (arg) => { calls.push(arg); return typeof reply === 'function' ? reply(arg) : reply; };
  fn.calls = calls;
  return fn;
}

test('runs the guarded cancel for any courier, and stays quiet when all goes well', async () => {
  const cancel = spy({ statusCode: 200, data: { to_cancel: 2, skipped_booked: 886, results: [
    { orders: ['IC-1'], ok: true }, { orders: ['IC-2'], ok: true }] } });
  const alert = spy();
  const out = await runCleanup({ cancel, alertOwner: alert });
  assert.deepEqual(cancel.calls[0], { dry_run: false, any_courier: true, limit: 100 });
  assert.deepEqual(out.cancelled, ['IC-1', 'IC-2']);
  assert.equal(alert.calls.length, 0);
});

test('a failed cancel reaches the owner', async () => {
  const cancel = spy({ statusCode: 200, data: { results: [
    { orders: ['IC-1'], ok: true }, { orders: ['IC-2'], ok: false, error: 'HTTP 404' }] } });
  const alert = spy();
  const out = await runCleanup({ cancel, alertOwner: alert });
  assert.equal(out.failed, 1);
  assert.match(alert.calls[0], /IC-2: HTTP 404/);
});

test('an endpoint error reaches the owner', async () => {
  const alert = spy();
  const out = await runCleanup({ cancel: spy({ statusCode: 500, data: { error: 'orders query failed' } }), alertOwner: alert });
  assert.equal(out.ok, false);
  assert.match(alert.calls[0], /orders query failed/);
});

test('a dry run cancels nothing and alerts no one', async () => {
  const cancel = spy({ statusCode: 200, data: { to_cancel: 1, plan: [{ order: 'IC-1' }] } });
  const alert = spy();
  const out = await runCleanup({ cancel, alertOwner: alert }, { dryRun: true });
  assert.equal(cancel.calls[0].dry_run, true);
  assert.deepEqual(out.plan, ['IC-1']);
  assert.equal(alert.calls.length, 0);
});

test('over HTTP it is owner-only', async () => {
  process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-secret';
  const { handler } = require('../xpressbees-queue-cleanup-scheduled');
  const res = await handler({ rawUrl: 'https://x/.netlify/functions/xpressbees-queue-cleanup-scheduled', httpMethod: 'POST', headers: {}, path: '/.netlify/functions/xpressbees-queue-cleanup-scheduled' });
  assert.equal(res.statusCode, 401);
});
