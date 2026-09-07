'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { afterResponse } = require('./after-response');

test('work is handed to waitUntil so the runtime keeps the isolate alive', async () => {
  // This is the whole point: on Workers an un-registered promise is cancelled
  // when the response is sent, which is how COD orders went unpushed.
  const held = [];
  const ctx = { waitUntil: (p) => held.push(p) };
  await afterResponse(ctx, Promise.resolve('pushed'));
  assert.strictEqual(held.length, 1);
});

test('a failing push never rejects, so it cannot fail the request', async () => {
  const held = [];
  const ctx = { waitUntil: (p) => held.push(p) };
  await assert.doesNotReject(() => afterResponse(ctx, Promise.reject(new Error('NimbusPost 500'))));
  await assert.doesNotReject(() => held[0]);
});

test('no context still runs the work, it just is not protected', async () => {
  // Local dev and direct calls pass no context; that is the old floating
  // behaviour, which must keep working rather than throw.
  let ran = false;
  await afterResponse(undefined, Promise.resolve().then(() => { ran = true; }));
  assert.ok(ran);
  await assert.doesNotReject(() => afterResponse({}, Promise.reject(new Error('x'))));
});

test('a runtime that refuses waitUntil does not take the order down with it', async () => {
  const ctx = { waitUntil: () => { throw new Error('waitUntil not allowed here'); } };
  await assert.doesNotReject(() => afterResponse(ctx, Promise.resolve(1)));
});
