const test = require('node:test');
const assert = require('node:assert/strict');
process.env.ITHINK_ACCESS_TOKEN = process.env.ITHINK_ACCESS_TOKEN || 'test';
process.env.ITHINK_SECRET_KEY = process.env.ITHINK_SECRET_KEY || 'test';
const { checkPickups, pickupState, channelsFor } = require('./pickup-live');
const { classify } = require('./not-picked-up');

test('only a positive pre-pickup phrase counts as waiting', () => {
  for (const s of ['Manifested', 'Not Picked', 'pending pickup', 'Pickup Scheduled', 'BOOKED']) assert.equal(pickupState(s), 'waiting', s);
  for (const s of ['Delivered', 'In Transit', 'Pending', 'Dispatched', 'RTO', 'Out For Delivery']) assert.equal(pickupState(s), 'moved', s);
  for (const s of ['', 'lookup failed: Record not found', 'Invalid AWB']) assert.equal(pickupState(s), 'unknown', s);
  assert.equal(pickupState('Cancelled'), 'cancelled');
  assert.equal(pickupState('RTO Cancelled'), 'moved');
});

test('an XpressBees AWB booked through NimbusPost is asked there too', () => {
  assert.deepEqual(channelsFor({ courier_name: 'Xpressbees', nimbus_pushed_at: 'x' }), ['xpressbees', 'nimbuspost', 'ithink']);
  assert.deepEqual(channelsFor({ courier_name: 'Delhivery', ithink_pushed_at: 'x', nimbus_pushed_at: 'x' }), ['delhivery', 'ithink', 'nimbuspost']);
});

// IC-20260915-IYCBK: listed as "no scan yet, booked 14d ago" while Delhivery
// said Delivered. Booked through iThink, so only iThink knows it.
test('a parcel the courier delivered is reported moved and leaves the tab', async () => {
  const order = {
    id: 'u1', razorpay_order_id: 'IC-20260915-IYCBK', status: 'shipped', created_at: '2026-09-15T22:13:00Z',
    tracking_id: '21025863355960', courier_name: 'Delhivery', ithink_pushed_at: '2026-09-17T00:00:00Z', nimbus_pushed_at: 'x',
  };
  const fetchFn = async (url) => ({
    text: async () => JSON.stringify(/ithink/.test(url)
      ? { status_code: 200, data: { 21025863355960: { message: 'success', awb_no: '21025863355960', current_status: 'Delivered' } } }
      : { ShipmentData: [] }),
  });
  const nimbus = { trackNimbusShipments: async () => [], shipmentStatusFromRow: () => '' };
  const live = await checkPickups([order], { fetch: fetchFn, nimbus });
  assert.deepEqual({ ...live.get('u1') }, { awb: '21025863355960', channel: 'ithink', status: 'Delivered', detail: '', state: 'moved' });

  const now = Date.parse('2026-10-03T00:00:00Z');
  assert.ok(classify(order, now), 'listed before the check');
  assert.equal(classify({ ...order, last_courier_status: 'Delivered' }, now), null);
  const voided = classify({ ...order, last_courier_status: 'Cancelled' }, now);
  assert.equal(voided.courier_cancelled, true);
});

test('nobody answering is unknown, never waiting', async () => {
  const fetchFn = async () => ({ text: async () => 'gateway timeout' });
  const nimbus = { trackNimbusShipments: async () => { throw new Error('down'); } };
  const live = await checkPickups([{ id: 'u2', tracking_id: '236454100592460', courier_name: 'Delhivery', nimbus_pushed_at: 'x' }], { fetch: fetchFn, nimbus });
  assert.equal(live.get('u2').state, 'unknown');
});

test('a courier cancel counts only on an explicit success', async () => {
  process.env.DELHIVERY_API_TOKEN = process.env.DELHIVERY_API_TOKEN || 'test';
  const { cancelAtCourier } = require('./pickup-live');
  const reply = (obj) => async () => ({ ok: true, text: async () => JSON.stringify(obj) });
  const order = { tracking_id: '21025863355971', courier_name: 'Delhivery' };

  assert.equal((await cancelAtCourier(order, { channel: 'ithink' }, { fetch: reply({ data: { 1: { status: 'Success', remark: 'Cancelled', refnum: '21025863355971' } } }) })).ok, true);
  assert.equal((await cancelAtCourier(order, { channel: 'ithink' }, { fetch: reply({ data: { 1: { status: 'Failed', remark: 'Already picked up' } } }) })).ok, false);
  assert.equal((await cancelAtCourier(order, { channel: 'ithink' }, { fetch: reply({ status: 'error', html_message: 'Invalid token' }) })).ok, false);
  assert.equal((await cancelAtCourier(order, { channel: 'delhivery' }, { fetch: reply({ status: true, remark: 'Shipment has been cancelled' }) })).ok, true);
  assert.equal((await cancelAtCourier(order, { channel: 'delhivery' }, { fetch: reply({ status: false, remark: 'not allowed' }) })).ok, false);
  assert.equal((await cancelAtCourier(order, { channel: null })).ok, false);
  const boom = async () => { throw new Error('network down'); };
  assert.equal((await cancelAtCourier(order, { channel: 'delhivery' }, { fetch: boom })).ok, false);
});

// IC-20260919-XOHQB, Amazon Shipping 372685506697: delivered 25 Sep, listed as
// "no answer" because the iThink track API does not know Amazon AWBs.
test('Amazon Shipping: label-only is waiting, any scan after it is moved', () => {
  const { amazonState, pickupState: ps } = require('./pickup-live');
  const wrap = (codes, status) => ({
    eventHistory: JSON.stringify({ eventHistory: codes.map((eventCode) => ({ eventCode })) }),
    progressTracker: JSON.stringify({ summary: { status } }),
  });
  const delivered = amazonState(wrap(['CreationConfirmed', 'PickupDone', 'Received', 'Departed', 'Delivered'], 'Delivered'));
  assert.equal(ps(delivered.status), 'moved');
  assert.equal(ps(amazonState(wrap(['CreationConfirmed'], 'Label created')).status), 'waiting');
  assert.equal(ps(amazonState(wrap(['CreationConfirmed', 'PickupDone'], 'Not Picked')).status), 'moved', 'a summary that reads as waiting cannot hide a pickup scan');
  assert.equal(ps(amazonState(wrap(['CreationConfirmed', 'ShipmentCancelled'], 'Cancelled')).status), 'cancelled');
  assert.equal(amazonState({}), null);
});

test('an Amazon AWB is asked of Amazon before iThink', () => {
  assert.deepEqual(channelsFor({ courier_name: 'Amazon Shipping', ithink_pushed_at: 'x', nimbus_pushed_at: 'x' }), ['amazon', 'ithink', 'nimbuspost']);
});
