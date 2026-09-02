'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { softUpdate, notifyApprovedOnce } = require('../../netlify/functions/process-return')._test;

/** Minimal PostgREST stand-in: rejects any column not in `columns`. */
function fakeDb(columns) {
  const calls = [];
  return {
    calls,
    from() {
      return {
        update(fields) {
          calls.push({ ...fields });
          const missing = Object.keys(fields).find(k => !columns.includes(k));
          return {
            eq: async () => missing
              ? { error: { message: `column return_requests.${missing} does not exist` } }
              : { error: null },
          };
        },
      };
    },
  };
}

test('softUpdate writes everything when every column exists', async () => {
  const db = fakeDb(['last_push_error', 'last_push_error_at']);
  const r = await softUpdate(db, 'id-1', { last_push_error: 'wallet low', last_push_error_at: 'now' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(db.calls.length, 1);
});

test('softUpdate drops only the missing column and keeps the rest', async () => {
  // The migration has not been run for last_push_error_at.
  const db = fakeDb(['last_push_error']);
  const r = await softUpdate(db, 'id-1', { last_push_error: 'wallet low', last_push_error_at: 'now' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(db.calls[db.calls.length - 1], { last_push_error: 'wallet low' });
});

test('softUpdate gives up cleanly when no column exists', async () => {
  const db = fakeDb([]);
  const r = await softUpdate(db, 'id-1', { last_push_error: 'x', last_push_error_at: 'y' });
  assert.strictEqual(r.ok, false);
  // It must not loop forever on a database that rejects everything.
  assert.ok(db.calls.length <= 6, `tried ${db.calls.length} times`);
});

test('softUpdate reports a real error rather than treating it as a bad column', async () => {
  const db = {
    from: () => ({ update: () => ({ eq: async () => ({ error: { message: 'permission denied' } }) }) }),
  };
  const r = await softUpdate(db, 'id-1', { last_push_error: 'x' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /permission denied/);
});

test('an already-notified customer is not messaged again on retry', async () => {
  const db = fakeDb(['approved_notified_at']);
  const r = await notifyApprovedOnce(db, { id: 'r1', approved_notified_at: '2026-09-01T00:00:00Z' });
  assert.strictEqual(r.sent, false);
  // Nothing written, nothing sent — a second push attempt is silent.
  assert.strictEqual(db.calls.length, 0);
});

test('deduped is false when the stamp column is missing, so the caller knows', async () => {
  // No columns: the notification goes out but cannot be remembered.
  const db = fakeDb([]);
  const r = await notifyApprovedOnce(db, { id: 'r1', customer_email: '', customer_phone: '' });
  assert.strictEqual(r.sent, true);
  assert.strictEqual(r.deduped, false);
});
