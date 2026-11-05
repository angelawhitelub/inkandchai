'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ask = require('./delivery-failed-ask');

const NOW = Date.parse('2026-11-05T06:00:00Z');
const order = (over = {}) => ({
  id: 'u1', razorpay_order_id: 'IC-1', status: 'out_for_delivery', last_courier_status: 'exception',
  created_at: '2026-11-01T06:00:00Z', customer_name: 'Riya Sharma', customer_phone: '919876543210',
  cart_items: [{ title: 'Atomic Habits', qty: 1 }],
  ...over,
});

// A small PostgREST stand-in: eq / is / in / gte honoured; or() trusted to the caller's row set.
function fakeDb(rows, { error = null } = {}) {
  const updates = [];
  const from = () => {
    const f = []; let patch = null;
    const match = (r) => f.every((t) => t(r));
    const b = {
      select() { return b; },
      update(p) { patch = p; return b; },
      eq(c, v) { f.push((r) => r[c] === v); return b; },
      is(c, v) { f.push((r) => (r[c] ?? null) === v); return b; },
      in(c, v) { f.push((r) => v.includes(r[c])); return b; },
      gte(c, v) { f.push((r) => String(r[c] ?? '') >= v); return b; },
      or() { return b; }, order() { return b; }, limit() { return b; },
      then(ok, bad) {
        if (error) return Promise.resolve({ data: null, error }).then(ok, bad);
        const hit = rows.filter(match);
        if (patch && hit.length) { hit.forEach((r) => Object.assign(r, patch)); updates.push(patch); }
        return Promise.resolve({ data: hit.map((r) => (patch ? { id: r.id } : r)), error: null }).then(ok, bad);
      },
    };
    return b;
  };
  return { from, rows, updates };
}

function sender(result = { ok: true }) {
  const fn = async (m) => { fn.calls.push(m); return result; };
  fn.calls = [];
  return fn;
}

test('only an out-for-delivery order with a failure from the courier is asked', () => {
  assert.equal(ask.askEligible(order()).ok, true);
  assert.equal(ask.askEligible(order({ last_courier_status: 'Undelivered' })).ok, true);
  for (const over of [
    { status: 'shipped' }, { status: 'delivered' }, { status: 'rto' },
    { last_courier_status: 'in transit' }, { last_courier_status: 'lookup failed: timeout' }, { last_courier_status: '' },
    { delivery_failed_asked_at: '2026-11-04T06:00:00Z' }, { cancellation_requested_at: '2026-11-04T06:00:00Z' },
    { late_cancel_at: '2026-11-04T06:00:00Z' }, { customer_phone: '' },
  ]) assert.equal(ask.askEligible(order(over)).ok, false, JSON.stringify(over));
});

test('sends the template once, with cover, name, order and books, and logs it', async () => {
  const db = fakeDb([order({ cart_items: [{ title: 'Atomic Habits', qty: 1, img: 'https://cdn.example.com/a.webp' }] })]);
  const send = sender();
  const logged = [];
  const deps = { supabase: db, send, now: () => NOW, isJpeg: async () => true, logMessage: async (p, m) => { logged.push(m); } };
  const first = await ask.sendAsks(deps, { template: 'delivery_failed_ask' });
  assert.equal(first.sent.length, 1);
  assert.equal(send.calls[0].template, 'delivery_failed_ask');
  assert.deepEqual(send.calls[0].params, ['Riya', 'IC-1', 'Atomic Habits']);
  assert.match(send.calls[0].headerImageUrl, /^https:\/\/wsrv\.nl\/.*a\.webp.*output=jpg/);
  assert.equal(db.rows[0].delivery_failed_state, 'asked');
  assert.match(logged[0], /still want this order/);
  await ask.sendAsks(deps, { template: 'delivery_failed_ask' });
  assert.equal(send.calls.length, 1);
});

test('no template sends nothing; a preview writes nothing', async () => {
  const db = fakeDb([order()]);
  const send = sender();
  const off = await ask.sendAsks({ supabase: db, send, now: () => NOW }, { template: '' });
  assert.equal(off.enabled, false);
  const preview = await ask.sendAsks({ supabase: db, send, now: () => NOW }, { template: 'x', dryRun: true });
  assert.equal(preview.would_send.length, 1);
  assert.equal(send.calls.length, 0);
  assert.equal(db.updates.length, 0);
});

test('a failed send releases the claim so the next run retries', async () => {
  const db = fakeDb([order()]);
  const out = await ask.sendAsks({ supabase: db, send: sender({ ok: false, status: 400 }), now: () => NOW, isJpeg: async () => true }, { template: 'x' });
  assert.equal(out.failed.length, 1);
  assert.equal(db.rows[0].delivery_failed_asked_at, null);
  assert.equal(db.rows[0].delivery_failed_state, null);
});

test('opted-out customers and old orders are left alone; the run is capped', async () => {
  const db = fakeDb([order(), order({ id: 'u2', created_at: '2026-09-01T06:00:00Z' })]);
  const send = sender();
  const out = await ask.sendAsks({ supabase: db, send, now: () => NOW, isOptedOut: async () => true }, { template: 'x' });
  assert.equal(send.calls.length, 0);
  assert.equal(out.skipped.length, 1);
  const many = fakeDb([order(), order({ id: 'u2', razorpay_order_id: 'IC-2' })]);
  const capped = await ask.sendAsks({ supabase: many, send: sender(), now: () => NOW, isJpeg: async () => true }, { template: 'x', max: 1 });
  assert.equal(capped.sent.length, 1);
  assert.equal(capped.skipped[0].reason, 'per-run cap; next run');
});

test('missing columns read as "run the SQL", not a crash', async () => {
  const db = fakeDb([], { error: { message: 'column orders.delivery_failed_asked_at does not exist' } });
  const out = await ask.sendAsks({ supabase: db, send: sender(), now: () => NOW }, { template: 'x' });
  assert.match(out.error, /orders_delivery_failed_ask/);
  assert.equal(await ask.findOpenAsk(db, '919876543210', NOW), null);
});

const asked = (over = {}) => order({ delivery_failed_asked_at: '2026-11-05T05:00:00Z', delivery_failed_state: 'asked', ...over });
const reply = (db, text) => ask.handleReply({ supabase: db, now: () => NOW }, text, { ...db.rows[0] });

test('want → nobody came → alternate number is stored step by step', async () => {
  const db = fakeDb([asked()]);
  const one = await reply(db, ask.WANT_BUTTON);
  assert.deepEqual(one.buttons, [ask.FUTURE_BUTTON, ask.NOBODY_BUTTON]);
  assert.match(one.reply, /I requested future delivery/);
  assert.match(one.reply, /Nobody came for delivery/);
  assert.equal(db.rows[0].delivery_failed_choice, 'want');
  assert.equal(db.rows[0].delivery_failed_state, 'reason');
  assert.ok(db.rows[0].delivery_failed_answered_at);

  const two = await reply(db, ask.NOBODY_BUTTON);
  assert.match(two.reply, /alternate phone number/);
  assert.equal(db.rows[0].delivery_failed_reason, 'nobody_came');
  assert.equal(db.rows[0].delivery_failed_state, 'number');

  const three = await reply(db, 'my other number is +91 98765-43211');
  assert.match(three.reply, /9876543211/);
  assert.equal(db.rows[0].delivery_failed_alt_phone, '9876543211');
  assert.equal(db.rows[0].delivery_failed_state, 'closed');
});

test('want → future delivery asks the date and stores it, with no number asked', async () => {
  const db = fakeDb([asked()]);
  await reply(db, ask.WANT_BUTTON);
  const one = await reply(db, ask.FUTURE_BUTTON);
  assert.match(one.reply, /Which date/);
  assert.equal(db.rows[0].delivery_failed_reason, 'future_delivery');
  assert.equal(db.rows[0].delivery_failed_state, 'date');
  const two = await reply(db, '12 Nov');
  assert.match(two.reply, /12 Nov 2026/);
  assert.equal(db.rows[0].delivery_failed_future_date, '2026-11-12');
  assert.equal(db.rows[0].delivery_failed_state, 'closed');
  assert.equal(db.rows[0].delivery_failed_alt_phone, undefined);
});

test('cancel is recorded and promises no refund; it never touches the order status', async () => {
  const db = fakeDb([asked()]);
  const out = await reply(db, ask.CANCEL_BUTTON);
  assert.equal(db.rows[0].delivery_failed_choice, 'cancel');
  assert.equal(db.rows[0].delivery_failed_state, 'closed');
  assert.equal(db.rows[0].status, 'out_for_delivery');
  assert.doesNotMatch(out.reply, /refund/i);
  assert.ok(db.updates.every((u) => !('status' in u)));
});

test('changing their mind to cancel at the reason step replaces the want', async () => {
  const db = fakeDb([asked()]);
  await reply(db, ask.WANT_BUTTON);
  await reply(db, 'cancel it');
  assert.equal(db.rows[0].delivery_failed_choice, 'cancel');
  assert.equal(db.rows[0].delivery_failed_state, 'closed');
});

test('no alternate number closes it and records nothing as a number', async () => {
  const db = fakeDb([asked({ delivery_failed_state: 'number', delivery_failed_choice: 'want', delivery_failed_reason: 'nobody_came' })]);
  await reply(db, 'NO');
  assert.equal(db.rows[0].delivery_failed_state, 'closed');
  assert.equal(db.rows[0].delivery_failed_alt_phone, undefined);
});

test('anything else goes to the AI and changes nothing', async () => {
  for (const [state, text] of [['asked', 'where is my parcel right now?'], ['reason', 'what do you mean'], ['date', 'what do you mean'], ['number', 'why do you need it']]) {
    const db = fakeDb([asked({ delivery_failed_state: state })]);
    const out = await reply(db, text);
    assert.equal(out.handled, false, text);
    assert.equal(db.updates.length, 0, text);
    assert.match(ask.contextFor(db.rows[0]), /DELIVERY FAILED QUESTION OPEN/);
  }
});

test('a number typed straight away means they want it, and is stored', async () => {
  const db = fakeDb([asked()]);
  await reply(db, 'call 9876543211');
  assert.equal(db.rows[0].delivery_failed_choice, 'want');
  assert.equal(db.rows[0].delivery_failed_alt_phone, '9876543211');
});

test('a double tap only counts once', async () => {
  const db = fakeDb([asked()]);
  const stale = { ...db.rows[0] };
  await ask.handleReply({ supabase: db }, ask.WANT_BUTTON, stale);
  const again = await ask.handleReply({ supabase: db }, ask.WANT_BUTTON, stale);
  assert.equal(again.handled, false);
  assert.equal(db.updates.length, 1);
});

test('finds the one midway first, and ignores delivered or stale questions', async () => {
  const db = fakeDb([
    asked({ id: 'a', razorpay_order_id: 'IC-A', delivery_failed_asked_at: '2026-11-05T01:00:00Z' }),
    asked({ id: 'b', razorpay_order_id: 'IC-B', delivery_failed_state: 'number' }),
    asked({ id: 'c', status: 'delivered', delivery_failed_state: 'number' }),
    asked({ id: 'd', delivery_failed_state: 'closed' }),
    asked({ id: 'e', delivery_failed_asked_at: '2026-10-01T01:00:00Z' }),
  ]);
  assert.equal((await ask.findOpenAsk(db, '9876543210', NOW)).id, 'b');
  db.rows[1].delivery_failed_state = 'closed';
  assert.equal((await ask.findOpenAsk(db, '9876543210', NOW)).id, 'a');
});

test('reading the typed answers', () => {
  for (const t of ['yes', 'Haan', 'I want this order', 'i still want it', 'chahiye']) assert.equal(ask.choiceOf(t), 'want', t);
  for (const t of ['no', 'Cancel this order', "don't want it", 'nahi chahiye', 'no need']) assert.equal(ask.choiceOf(t), 'cancel', t);
  for (const t of ['where is my order', 'hello', 'nothing arrived', 'nowhere']) assert.equal(ask.choiceOf(t), null, t);
  for (const t of ['Nobody came', 'no one came', 'koi nahi aaya', "courier didn't come"]) assert.equal(ask.reasonOf(t), 'nobody_came', t);
  for (const t of ['Future delivery', 'I requested future delivery', 'deliver later', 'next week']) assert.equal(ask.reasonOf(t), 'future_delivery', t);
  assert.equal(ask.numberOf('12345'), '');
  assert.equal(ask.numberOf('98765 43210'), '9876543210');
});

test('own buttons are told apart from the COD confirmation buttons', () => {
  assert.ok(ask.isOwnButton('Cancel this order'));
  assert.ok(ask.isOwnButton('  i want this order '));
  assert.ok(!ask.isOwnButton('Cancel order'));
  assert.ok(!ask.isOwnButton('Confirm'));
});

test('"no one came" is never read as cancelling', async () => {
  for (const text of ['no one came', 'nobody came', 'no courier came', 'koi nahi aaya']) {
    const db = fakeDb([asked()]);
    await reply(db, text);
    assert.notEqual(db.rows[0].delivery_failed_choice, 'cancel', text);
  }
  const db = fakeDb([asked()]);
  const out = await reply(db, 'nobody came');
  assert.equal(db.rows[0].delivery_failed_choice, 'want');
  assert.equal(db.rows[0].delivery_failed_reason, 'nobody_came');
  assert.equal(db.rows[0].delivery_failed_state, 'number');
  assert.match(out.reply, /alternate phone number/);
});

test('a bare no cancels only as the answer to "do you still want it?"', async () => {
  const atAsked = fakeDb([asked()]);
  await reply(atAsked, 'no');
  assert.equal(atAsked.rows[0].delivery_failed_choice, 'cancel');

  const atReason = fakeDb([asked()]);
  await reply(atReason, ask.WANT_BUTTON);
  const out = await reply(atReason, 'no');
  assert.equal(out.handled, false);
  assert.equal(atReason.rows[0].delivery_failed_choice, 'want');
  assert.equal(atReason.rows[0].delivery_failed_state, 'reason');
});

// NOW is Thursday 5 Nov 2026, 11:30 IST.
test('reads the dates people actually type', () => {
  const iso = (t, o) => ask.futureDateOf(t, NOW, o)?.iso;
  assert.equal(iso('12 Nov'), '2026-11-12');
  assert.equal(iso('12th november'), '2026-11-12');
  assert.equal(iso('Nov 12'), '2026-11-12');
  assert.equal(iso('12 of nov'), '2026-11-12');
  assert.equal(iso('12/11'), '2026-11-12');
  assert.equal(iso('12-11-2026'), '2026-11-12');
  assert.equal(iso('12.11.26'), '2026-11-12');
  assert.equal(iso('deliver on 3 dec please'), '2026-12-03');
  assert.equal(iso('tomorrow'), '2026-11-06');
  assert.equal(iso('kal'), '2026-11-06');
  assert.equal(iso('parso'), '2026-11-07');
  assert.equal(iso('day after tomorrow'), '2026-11-07');
  assert.equal(iso('monday'), '2026-11-09');
  assert.equal(iso('next somvar'), '2026-11-09');
  assert.equal(iso('thursday'), '2026-11-12');
  assert.equal(iso('5 jan'), '2027-01-05');
});

test('a bare day counts only where we just asked for a date', () => {
  assert.equal(ask.futureDateOf('15', NOW), null);
  assert.equal(ask.futureDateOf('15', NOW, { bareDay: true }).iso, '2026-11-15');
  assert.equal(ask.futureDateOf('15th', NOW, { bareDay: true }).iso, '2026-11-15');
  assert.equal(ask.futureDateOf('15 tareekh', NOW, { bareDay: true }).iso, '2026-11-15');
  assert.equal(ask.futureDateOf('2', NOW, { bareDay: true }).iso, '2026-12-02');
  assert.equal(ask.futureDateOf('45', NOW, { bareDay: true }), null);
});

test('past or far-off dates are sent back, and nonsense is not a date', () => {
  assert.deepEqual(ask.futureDateOf('2 Nov', NOW), { bad: true });
  assert.deepEqual(ask.futureDateOf('1/1/2020', NOW), { bad: true });
  assert.deepEqual(ask.futureDateOf('10 Sep 2027', NOW), { bad: true });
  assert.equal(ask.futureDateOf('31 feb', NOW), null);
  assert.equal(ask.futureDateOf('what do you mean', NOW), null);
  assert.equal(ask.futureDateOf('where is my book', NOW), null);
});

test('words for a time are kept as they said them', () => {
  assert.equal(ask.futureDateOf('next week', NOW).words, 'next week');
  assert.equal(ask.futureDateOf('After 5 days', NOW).words, 'After 5 days');
  assert.equal(ask.futureDateOf('agle hafte', NOW).words, 'agle hafte');
});

test('at the date step: a bad date asks again, words are stored, no date closes', async () => {
  const dateStep = () => fakeDb([asked({ delivery_failed_state: 'date', delivery_failed_choice: 'want', delivery_failed_reason: 'future_delivery' })]);
  let db = dateStep();
  const bad = await reply(db, '2 Nov');
  assert.match(bad.reply, /upcoming date/);
  assert.equal(db.rows[0].delivery_failed_state, 'date');
  assert.equal(db.updates.length, 0);

  db = dateStep();
  await reply(db, 'next week');
  assert.equal(db.rows[0].delivery_failed_future_date, 'next week');
  assert.equal(db.rows[0].delivery_failed_state, 'closed');

  db = dateStep();
  await reply(db, "don't know yet");
  assert.equal(db.rows[0].delivery_failed_state, 'closed');
  assert.equal(db.rows[0].delivery_failed_future_date, undefined);
  assert.equal(db.rows[0].delivery_failed_reason, 'future_delivery');

  db = dateStep();
  await reply(db, 'cancel it');
  assert.equal(db.rows[0].delivery_failed_choice, 'cancel');
  assert.equal(db.rows[0].delivery_failed_reason, null);
});

test('a date given early skips the date question', async () => {
  let db = fakeDb([asked()]);
  await reply(db, ask.WANT_BUTTON);
  await reply(db, '15 Nov');
  assert.equal(db.rows[0].delivery_failed_reason, 'future_delivery');
  assert.equal(db.rows[0].delivery_failed_future_date, '2026-11-15');
  assert.equal(db.rows[0].delivery_failed_state, 'closed');

  db = fakeDb([asked()]);
  await reply(db, 'please deliver later on 15 nov');
  assert.equal(db.rows[0].delivery_failed_choice, 'want');
  assert.equal(db.rows[0].delivery_failed_future_date, '2026-11-15');
  assert.equal(db.rows[0].delivery_failed_state, 'closed');
});

test('option 2 at the reason step is not read as the 2nd of the month', async () => {
  const db = fakeDb([asked()]);
  await reply(db, ask.WANT_BUTTON);
  await reply(db, '2');
  assert.equal(db.rows[0].delivery_failed_reason, 'nobody_came');
  assert.equal(db.rows[0].delivery_failed_state, 'number');
});

test('a day mentioned in passing is not taken as the date they want', async () => {
  for (const text of ['the courier came on monday', 'kal aaya tha', 'I was out of town on saturday when he tried']) {
    const db = fakeDb([asked()]);
    await reply(db, ask.WANT_BUTTON);
    const out = await reply(db, text);
    assert.equal(out.handled, false, text);
    assert.equal(db.rows[0].delivery_failed_state, 'reason', text);
    assert.equal(db.rows[0].delivery_failed_future_date, undefined, text);
  }
  const db = fakeDb([asked()]);
  await reply(db, ask.WANT_BUTTON);
  await reply(db, 'kal');
  assert.equal(db.rows[0].delivery_failed_future_date, '2026-11-06');
});

test('no cover, or a cover that fails the check, sends the store image, so the message is never lost', async () => {
  const withCover = order({ cart_items: [{ title: 'A', img: 'https://cdn.example.com/a.webp' }] });
  assert.match(await ask.headerImageFor(withCover, async () => true), /wsrv\.nl/);
  assert.equal(await ask.headerImageFor(withCover, async () => false), ask.FALLBACK_IMAGE);
  let checked = false;
  assert.equal(await ask.headerImageFor(order(), async () => { checked = true; return true; }), ask.FALLBACK_IMAGE);
  assert.equal(checked, false);

  const db = fakeDb([order()]);
  const send = sender();
  await ask.sendAsks({ supabase: db, send, now: () => NOW }, { template: 'x' });
  assert.equal(send.calls[0].headerImageUrl, ask.FALLBACK_IMAGE);
});
