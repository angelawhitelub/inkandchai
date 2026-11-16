'use strict';
// Attaching store credit to a COD order placed without it (IC-20261116-FDLNA, 16 Nov 2026).
const test = require('node:test');
const assert = require('node:assert/strict');

const { applyStoreCredit, refusal } = require('../admin-apply-store-credit')._test;

function db(tables) {
  return {
    from(name) {
      const rows = tables[name];
      const q = { f: {}, inF: {}, upd: null };
      const match = (r) => Object.entries(q.f).every(([k, v]) => r[k] === v)
        && Object.entries(q.inF).every(([k, vs]) => vs.includes(r[k]));
      const api = {
        select() { return api; },
        update(v) { q.upd = v; return api; },
        eq(k, v) { q.f[k] = v; return api; },
        in(k, vs) { q.inF[k] = vs; return api; },
        async maybeSingle() { return { data: rows.find(match) || null, error: null }; },
        then(resolve) {
          const hit = rows.filter(match);
          if (q.upd) hit.forEach((r) => Object.assign(r, q.upd));
          resolve({ data: hit.map((r) => ({ ...r })), error: null });
        },
      };
      return api;
    },
  };
}

const card = (o = {}) => ({ id: 'c1', code: 'SCRATCH-X72BSP', value_paise: 57800, min_subtotal_paise: 57800, status: 'scratched', expires_at: null, ...o });
const order = (o = {}) => ({
  id: 'u1', razorpay_order_id: 'IC-20261116-FDLNA', status: 'cod_pending', amount_paise: 78400,
  tracking_id: null, cart_items: [{ title: 'Sometimes I Lie', qty: 1, price: 565 }, { title: 'Wildfire', qty: 1, price: 199 }], ...o,
});

test('dry run shows ₹784 → ₹206 and changes nothing', async () => {
  const t = { orders: [order()], scratch_cards: [card()] };
  const r = await applyStoreCredit(db(t), { orderId: 'ic-20261116-fdlna', code: 'scratch-x72bsp' });
  assert.equal(r.status, 200);
  assert.equal(r.dry_run, true);
  assert.deepEqual([r.from, r.credit, r.to], [784, 578, 206]);
  assert.equal(t.orders[0].amount_paise, 78400);
  assert.equal(t.scratch_cards[0].status, 'scratched');
});

test('applying claims the card for the order and lowers the total', async () => {
  const t = { orders: [order()], scratch_cards: [card()] };
  const r = await applyStoreCredit(db(t), { orderId: 'IC-20261116-FDLNA', code: 'SCRATCH-X72BSP', dryRun: false });
  assert.equal(r.applied, true);
  assert.equal(t.orders[0].amount_paise, 20600);
  assert.deepEqual(t.orders[0].cart_items[0]._store_credit, { code: 'SCRATCH-X72BSP', discount: 578 });
  assert.equal(t.scratch_cards[0].status, 'redeemed');
  assert.equal(t.scratch_cards[0].redeemed_order_id, 'IC-20261116-FDLNA');
  // A second press is refused: the credit is already there.
  const again = await applyStoreCredit(db(t), { orderId: 'IC-20261116-FDLNA', code: 'SCRATCH-X72BSP', dryRun: false });
  assert.equal(again.status, 409);
});

test('booked, panel-pushed, paid or used: refused', async () => {
  assert.match(refusal(order({ tracking_id: '1434000000001' })), /AWB/);
  assert.match(refusal(order({ nimbus_pushed_at: '2026-11-16T10:00:00Z' })), /NimbusPost/);
  assert.match(refusal(order({ status: 'paid' })), /unpaid COD/);
  assert.equal(refusal(order()), '');
  const used = await applyStoreCredit(db({ orders: [order()], scratch_cards: [card({ status: 'redeemed' })] }),
    { orderId: 'IC-20261116-FDLNA', code: 'SCRATCH-X72BSP', dryRun: false });
  assert.equal(used.status, 409);
  const reward = await applyStoreCredit(db({ orders: [order()], scratch_cards: [card({ value_paise: 7500, min_subtotal_paise: 39900 })] }),
    { orderId: 'IC-20261116-FDLNA', code: 'SCRATCH-X72BSP', dryRun: false });
  assert.equal(reward.status, 409);
});
