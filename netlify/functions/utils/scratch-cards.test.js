'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./scratch-cards');

/** A Supabase stand-in: orders by razorpay_order_id, and scratch_cards by code. */
function fakeDb({ orders = {}, cards = {} } = {}) {
  const updates = [];
  const db = {
    updates,
    from(table) {
      const q = { filters: {}, upd: null };
      const api = {
        select() { return api; },
        update(v) { q.upd = v; return api; },
        eq(k, v) { q.filters[k] = v; return api; },
        async maybeSingle() {
          if (table === 'orders') { const o = orders[q.filters.razorpay_order_id]; return { data: o ? { status: o } : null, error: null }; }
          return { data: cards[q.filters.code] || null, error: null };
        },
        then(resolve) {
          updates.push({ table, ...q });
          const card = Object.values(cards).find((c) => c.id === q.filters.id && c.status === q.filters.status);
          resolve({ data: card ? [{ id: card.id, value_paise: card.value_paise }] : [], error: null });
        },
      };
      return api;
    },
  };
  return db;
}

const reward = (over = {}) => ({ id: 'c1', code: 'SCRATCH-ABCDEFG', value_paise: 7500, min_subtotal_paise: 39900, status: 'scratched', source_order_id: 'IC-1', expires_at: new Date(Date.now() + 864e5).toISOString(), ...over });

test('isRewardCard tells reward cards from store credit', () => {
  assert.equal(S.isRewardCard(reward()), true);
  assert.equal(S.isRewardCard(reward({ value_paise: 43900, min_subtotal_paise: 43900 })), false);
});

test('earningOrderGone: cancelled/refunded order voids a reward card; paid, shipped, missing do not; credit never', async () => {
  for (const [status, gone] of [['cancelled', true], ['refunded', true], ['refund_pending', true], ['rto', true], ['paid', false], ['shipped', false], ['delivered', false]]) {
    assert.equal(await S.earningOrderGone(fakeDb({ orders: { 'IC-1': status } }), reward()), gone, status);
  }
  assert.equal(await S.earningOrderGone(fakeDb(), reward()), false, 'missing order');
  const credit = reward({ value_paise: 43900, min_subtotal_paise: 43900 });
  assert.equal(await S.earningOrderGone(fakeDb({ orders: { 'IC-1': 'refunded' } }), credit), false, 'store credit');
});

test('claimScratchCardForOrder refuses a card whose order was cancelled, and claims a live one', async () => {
  const card = reward();
  let db = fakeDb({ orders: { 'IC-1': 'cancelled' }, cards: { [card.code]: card } });
  let r = await S.claimScratchCardForOrder(db, card.code, 'IC-2');
  assert.deepEqual(r, { claimed: false, reason: 'order_cancelled' });
  assert.equal(db.updates.length, 0);

  db = fakeDb({ orders: { 'IC-1': 'shipped' }, cards: { [card.code]: card } });
  r = await S.claimScratchCardForOrder(db, card.code, 'IC-2');
  assert.equal(r.claimed, true);
  assert.equal(r.value_paise, 7500);
});

test('rewardCardBlock: usable only once the earning order has shipped; store credit always usable', async () => {
  const cases = [['paid', 'not_unlocked'], ['pickup_scheduled', 'not_unlocked'], ['shipped', null], ['in_transit', null], ['delivered', null], ['refunded', 'order_cancelled']];
  for (const [status, want] of cases) {
    const block = await S.rewardCardBlock(fakeDb({ orders: { 'IC-1': status } }), reward());
    assert.equal(block ? block.reason : null, want, status);
  }
  const b = await S.rewardCardBlock(fakeDb({ orders: { 'IC-1': 'paid' } }), reward());
  assert.match(b.message, /IC-1 ships/);
  const credit = reward({ value_paise: 43900, min_subtotal_paise: 43900 });
  assert.equal(await S.rewardCardBlock(fakeDb({ orders: { 'IC-1': 'refunded' } }), credit), null);
});

test('claimScratchCardForOrder waits for the earning order to ship', async () => {
  const card = reward();
  const db = fakeDb({ orders: { 'IC-1': 'paid' }, cards: { [card.code]: card } });
  assert.deepEqual(await S.claimScratchCardForOrder(db, card.code, 'IC-2'), { claimed: false, reason: 'not_unlocked' });
});
