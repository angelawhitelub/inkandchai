/**
 * Tests for WhatsApp opt-out handling.
 *
 * Origin: 18 customers had sent exactly "STOP" and the bot replied to them with
 * a greeting — "Hello! How can I assist you today? 😊" at 08-11T16:34 being the
 * most recent. STOP is WhatsApp's universal opt-out keyword.
 *
 * The false-positive tests are the important ones: silencing a customer who was
 * complaining ("stop sending me the wrong book") is a worse failure than the
 * bug being fixed.
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  isOptOutKeyword, isOptInKeyword, optStateFromHistory, isOptedOut,
  optedOutPhoneSet, phoneKey, normalizeKeyword,
} = require('./bot-optout');

test('the exact keyword, in any casing or punctuation, opts out', () => {
  for (const s of ['STOP', 'stop', 'Stop', ' stop ', 'stop.', 'STOP!', 'stop!!!',
                   'unsubscribe', 'UNSUBSCRIBE', 'opt out', 'opt-out', 'optout',
                   'remove me', 'leave me alone', 'band karo', 'mat bhejo']) {
    assert.strictEqual(isOptOutKeyword(s), true, `${JSON.stringify(s)} should opt out`);
  }
});

test('"stop messaging" and friends opt out — found verbatim in the history', () => {
  for (const s of ['Stop messaging', 'stop messaging me', 'stop sending messages', 'no more messages']) {
    assert.strictEqual(isOptOutKeyword(s), true, `${JSON.stringify(s)} should opt out`);
  }
});

test('CRITICAL: a complaint containing "stop" does NOT opt out', () => {
  for (const s of [
    'please stop sending me the wrong book',
    'stop my order',
    'why did you stop replying',
    'I want to stop the delivery, can you cancel',
    'non stop shipping issues',
    'bus stop road, near the market',   // an address line
    // Real book titles pulled from the live message history. Silencing a
    // customer for naming a book would be the worst outcome of this change.
    'Heartstopper volume 6',
    'Stop Letting Everything Affect You',
    'Had orded for 2set of books stop letting everything effect you but receivwd only 1',
    'Stop lying and give me the exact status',
  ]) {
    assert.strictEqual(isOptOutKeyword(s), false, `${JSON.stringify(s)} must reach a human, not be silenced`);
  }
});

test('opt-in keywords are recognised', () => {
  for (const s of ['START', 'start', 'unstop', 'resume', 'subscribe', 'opt in']) {
    assert.strictEqual(isOptInKeyword(s), true);
  }
});

test('empty and rubbish input is neither', () => {
  for (const v of ['', '   ', null, undefined, 42, {}]) {
    assert.strictEqual(isOptOutKeyword(v), false);
    assert.strictEqual(isOptInKeyword(v), false);
  }
});

test('normalizeKeyword strips punctuation and emoji but keeps words', () => {
  assert.strictEqual(normalizeKeyword('STOP! 😊'), 'stop');
  assert.strictEqual(normalizeKeyword('  Opt-Out.  '), 'opt out');
});

// ── latest intent wins ──────────────────────────────────────────────────────
test('newest message decides: STOP then START means subscribed', () => {
  // newest-first, as the query returns them
  const history = [{ message: 'START' }, { message: 'hello' }, { message: 'STOP' }];
  assert.strictEqual(optStateFromHistory(history), 'in');
});

test('newest message decides: START then STOP means unsubscribed', () => {
  const history = [{ message: 'STOP' }, { message: 'thanks' }, { message: 'START' }];
  assert.strictEqual(optStateFromHistory(history), 'out');
});

test('no keyword anywhere means no opinion', () => {
  assert.strictEqual(optStateFromHistory([{ message: 'where is my order' }]), null);
  assert.strictEqual(optStateFromHistory([]), null);
  assert.strictEqual(optStateFromHistory(null), null);
});

// ── isOptedOut against a stubbed database ───────────────────────────────────
function stubDb(rows, { error = null } = {}) {
  const q = {
    select: () => q, eq: () => q, or: () => q, order: () => q,
    limit: () => Promise.resolve({ data: rows, error }),
  };
  return { from: () => q };
}

test('isOptedOut reads the history', async () => {
  assert.strictEqual(await isOptedOut(stubDb([{ message: 'STOP' }]), '919999999999'), true);
  assert.strictEqual(await isOptedOut(stubDb([{ message: 'hi' }]), '919999999999'), false);
});

test('a database error fails OPEN — never silence someone by accident', async () => {
  const res = await isOptedOut(stubDb(null, { error: { message: 'connection reset' } }), '919999999999');
  assert.strictEqual(res, false, 'a lookup failure must not mute a customer');
});

test('missing db or phone is not opted out', async () => {
  assert.strictEqual(await isOptedOut(null, '919999999999'), false);
  assert.strictEqual(await isOptedOut(stubDb([{ message: 'STOP' }]), ''), false);
});

// ── the bulk set used by broadcasts ─────────────────────────────────────────
test('optedOutPhoneSet keeps only those whose LATEST intent was out', async () => {
  const rows = [                                    // newest first
    { customer_phone: '919000000001', message: 'STOP',  created_at: '2026-08-11T10:00:00Z' },
    { customer_phone: '919000000002', message: 'START', created_at: '2026-08-11T09:00:00Z' },
    { customer_phone: '919000000002', message: 'STOP',  created_at: '2026-08-01T09:00:00Z' },
    { customer_phone: '919000000003', message: 'please stop sending the wrong book', created_at: '2026-08-11T08:00:00Z' },
  ];
  const set = await optedOutPhoneSet(stubDb(rows));
  assert.strictEqual(set.has(phoneKey('919000000001')), true, 'said STOP');
  assert.strictEqual(set.has(phoneKey('919000000002')), false, 'opted back in');
  assert.strictEqual(set.has(phoneKey('919000000003')), false, 'was complaining, not unsubscribing');
  assert.strictEqual(set.size, 1);
});

test('optedOutPhoneSet matches regardless of country-code formatting', async () => {
  const set = await optedOutPhoneSet(stubDb([
    { customer_phone: '919667336650', message: 'STOP', created_at: '2026-08-11T10:00:00Z' },
  ]));
  for (const variant of ['9667336650', '919667336650', '+91 96673 36650', '09667336650']) {
    assert.strictEqual(set.has(phoneKey(variant)), true, `${variant} should match`);
  }
});

test('optedOutPhoneSet THROWS on error — a broadcast must not guess', async () => {
  await assert.rejects(
    () => optedOutPhoneSet(stubDb(null, { error: { message: 'timeout' } })),
    /opt-out lookup failed/);
});
