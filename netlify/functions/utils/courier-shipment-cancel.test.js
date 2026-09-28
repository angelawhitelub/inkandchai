const test = require('node:test');
const assert = require('node:assert/strict');
const { cancelCourierShipment } = require('./courier-shipment-cancel');

const order = (extra) => ({ tracking_id: '143449610819603', courier_name: 'Xpressbees', ...extra });
function fakeXb(status, { cancelFails = false, trackFails = false } = {}) {
  const calls = { cancel: [] };
  return {
    calls,
    async track() { if (trackFails) throw new Error('timeout'); return { status }; },
    async cancel(awb) { if (cancelFails) throw new Error('Shipment already picked'); calls.cancel.push(awb); return 'Shipment Cancelled.'; },
  };
}

test('cancels a shipment still waiting for pickup', async () => {
  const xb = fakeXb('pending pickup');
  const r = await cancelCourierShipment(order(), { xb });
  assert.equal(r.action, 'cancelled');
  assert.deepEqual(xb.calls.cancel, ['143449610819603']);
});

test('never cancels a parcel that has left, and says so', async () => {
  for (const s of ['in transit', 'out for delivery', 'delivered', 'rto', 'picked up', '']) {
    const xb = fakeXb(s);
    const r = await cancelCourierShipment(order(), { xb });
    assert.equal(r.action, 'moving', s);
    assert.equal(xb.calls.cancel.length, 0, s);
    assert.match(r.message, /too late to cancel/);
  }
});

test('reads the latest scan when the top-level status is missing', async () => {
  const xb = fakeXb(undefined);
  xb.track = async () => ({ history: [
    { event_time: '2026-09-28 04:49', status_code: 'in transit' },
    { event_time: '2026-09-25 23:45', status_code: 'pending pickup' },
  ] });
  const r = await cancelCourierShipment(order(), { xb });
  assert.equal(r.action, 'moving');
  assert.equal(xb.calls.cancel.length, 0);
});

test('an unreadable status is not a licence to cancel', async () => {
  const xb = fakeXb('pending pickup', { trackFails: true });
  const r = await cancelCourierShipment(order(), { xb });
  assert.equal(r.action, 'error');
  assert.equal(xb.calls.cancel.length, 0);
});

test('already cancelled, other couriers and no AWB are reported, not acted on', async () => {
  assert.equal((await cancelCourierShipment(order(), { xb: fakeXb('cancelled') })).action, 'already_cancelled');
  const other = await cancelCourierShipment(order({ courier_name: 'Delhivery' }), { xb: fakeXb('pending pickup') });
  assert.equal(other.action, 'not_supported');
  assert.match(other.message, /NOT cancelled/);
  assert.equal((await cancelCourierShipment(order({ tracking_id: '' }), { xb: fakeXb('pending pickup') })).action, 'none');
});

test('a refused cancel comes back as a message, never a throw', async () => {
  const r = await cancelCourierShipment(order(), { xb: fakeXb('pending pickup', { cancelFails: true }) });
  assert.equal(r.action, 'error');
  assert.match(r.message, /Cancel it in the XpressBees panel/);
});
