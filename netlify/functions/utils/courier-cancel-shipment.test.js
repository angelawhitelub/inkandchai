const test = require('node:test');
const assert = require('node:assert/strict');
const { stopShipment, statusAfterRefund } = require('../courier-cancel-shipment').__test;

function fakeSb() {
  const sb = { updates: [] };
  sb.from = () => {
    const q = { conds: [] };
    const b = {
      update(u) { q.update = u; return b; },
      eq(c, v) { q.conds.push([c, v]); return b; },
      then(ok, bad) { sb.updates.push({ ...q }); return Promise.resolve({ error: null }).then(ok, bad); },
    };
    return b;
  };
  return sb;
}

// IC-20261006-HF8JF as it stood: refunded by the customer's own cancel, then
// re-booked on Delhivery through NimbusPost, status back to 'shipped'.
const hf8jf = (over = {}) => ({
  id: 'u1', razorpay_order_id: 'IC-20261006-HF8JF', status: 'shipped',
  courier_name: 'Delhivery', tracking_id: '236454101180585', nimbus_pushed_at: '2026-10-06T19:21:53Z',
  amount_paise: 54100, refund_amount_paise: 24500,
  late_cancel_at: '2026-10-11T06:03:08Z', late_cancel_state: 'refunded', cancelled_at: null,
  ...over,
});

function deps(state, cancelOk = true) {
  const d = { cancels: 0, recorded: [] };
  d.checkPickups = async (orders) => new Map(orders.map((o) => [o.id, { state, status: state === 'waiting' ? 'pending pickup' : 'In Transit', channel: 'nimbuspost' }]));
  d.cancelAtCourier = async () => { d.cancels += 1; return { ok: cancelOk, message: cancelOk ? 'NimbusPost cancelled it.' : 'refused' }; };
  d.cancelCourierShipment = async () => { throw new Error('XpressBees must not be asked about a Delhivery AWB'); };
  d.recordCourierCancel = async (sb, id, r) => { d.recorded.push(r.action); };
  return d;
}

test('customer-cancelled order re-booked: AWB cancelled while waiting, status put back, nothing refunded', async () => {
  const sb = fakeSb();
  const d = deps('waiting');
  const r = await stopShipment(sb, hf8jf(), d);
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  assert.equal(d.cancels, 1);
  assert.equal(r.body.status_restored, 'partially_refunded');
  const u = sb.updates.find((x) => x.update.status);
  assert.equal(u.update.status, 'partially_refunded');
  assert.ok(u.update.cancelled_at);
  assert.deepEqual(u.conds, [['id', 'u1'], ['status', 'shipped']]);
});

test('already picked up: not cancelled, status left alone', async () => {
  const sb = fakeSb();
  const d = deps('moved');
  const r = await stopShipment(sb, hf8jf(), d);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.courier.action, 'moving');
  assert.equal(d.cancels, 0);
  assert.equal(sb.updates.length, 0);
});

test('courier refuses or does not answer: not ok, status left alone', async () => {
  for (const [state, ok] of [['waiting', false], ['unknown', true]]) {
    const sb = fakeSb();
    const r = await stopShipment(sb, hf8jf(), deps(state, ok));
    assert.equal(r.body.ok, false, state);
    assert.equal(sb.updates.length, 0, state);
  }
});

test('a live order the customer did not cancel is still refused', async () => {
  const r = await stopShipment(fakeSb(), hf8jf({ late_cancel_at: null, late_cancel_state: null }), deps('waiting'));
  assert.equal(r.code, 400);
  const pending = await stopShipment(fakeSb(), hf8jf({ late_cancel_state: 'awaiting_return' }), deps('waiting'));
  assert.equal(pending.code, 400);
});

test('status after refund follows the refund', () => {
  assert.equal(statusAfterRefund(hf8jf()), 'partially_refunded');
  assert.equal(statusAfterRefund(hf8jf({ refund_amount_paise: 54100 })), 'refunded');
  assert.equal(statusAfterRefund(hf8jf({ late_cancel_state: 'refund_pending' })), 'refund_pending');
});
