const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shipmentHasMoved,
  isPartialCod,
  cancellationAge,
  PREPAID_WINDOW_MS,
} = require('../../netlify/functions/cancel-order')._test;
const { normalizeStatus } = require('../../netlify/functions/nimbuspost-webhook')._test;

test('AWB assignment alone does not block COD cancellation', () => {
  assert.equal(shipmentHasMoved({ tracking_id: 'AWB123', shipment_moved_at: null }), false);
});

test('courier movement blocks COD cancellation', () => {
  assert.equal(shipmentHasMoved({ shipment_moved_at: '2026-07-29T00:00:00Z' }), true);
  assert.equal(shipmentHasMoved({ last_nimbuspost_status: 'in transit' }), true);
  assert.equal(shipmentHasMoved({ last_nimbuspost_status: 'pickup done' }), true);
  assert.equal(shipmentHasMoved({ last_nimbuspost_status: 'out for delivery' }), true);
});

test('NimbusPost SPD origin scan becomes an in-transit event', () => {
  assert.equal(normalizeStatus('spd'), 'in_transit');
  assert.equal(normalizeStatus('in transit'), 'in_transit');
});

test('partial COD is detected from every persisted representation', () => {
  assert.equal(isPartialCod({ status: 'partial_cod_pending' }), true);
  assert.equal(isPartialCod({ status: 'confirmed', advance_paid_paise: 5100 }), true);
  assert.equal(isPartialCod({ status: 'confirmed', shipment_payment_type: 'partial_cod' }), true);
  assert.equal(isPartialCod({
    status: 'confirmed',
    cart_items: [{ title: 'Book', _payment: { mode: 'partial_cod' } }],
  }), true);
  assert.equal(isPartialCod({ status: 'cod_pending', advance_paid_paise: 0 }), false);
});

test('partial/prepaid cancellation age uses the same 30-minute boundary', () => {
  const now = Date.parse('2026-08-13T18:00:00.000Z');
  assert.equal(cancellationAge({ created_at: new Date(now - PREPAID_WINDOW_MS).toISOString() }, now).ageMs, PREPAID_WINDOW_MS);
  assert.equal(cancellationAge({ created_at: new Date(now - PREPAID_WINDOW_MS - 1).toISOString() }, now).ageMs > PREPAID_WINDOW_MS, true);
  assert.equal(cancellationAge({}, now).ageMs, Number.POSITIVE_INFINITY);
});

// IC-20260919-IUPN2: Amazon Shipping via iThink, no scans to us, delivered
// 24 Sep, last_courier_status "Delivered" from 3 Oct -- and still cancelled
// from the website on 7 Oct because only NimbusPost was asked.
test("the courier's own last word (iThink / Amazon bookings) blocks cancellation", () => {
  assert.equal(shipmentHasMoved({ status: 'shipped', tracking_id: '372685510045', last_courier_status: 'Delivered' }), true);
  assert.equal(shipmentHasMoved({ last_courier_status: 'In Transit' }), true);
  assert.equal(shipmentHasMoved({ delivered_at: '2026-09-24T15:00:00Z' }), true);
  assert.equal(shipmentHasMoved({ last_courier_status: 'Pickup Scheduled' }), false, 'still waiting at our end');
  assert.equal(shipmentHasMoved({ last_courier_status: 'lookup failed: timeout' }), false, 'an error is not a scan');
  assert.equal(shipmentHasMoved({ last_courier_status: 'Cancelled' }), false);
});

test('live check asks every courier, not just NimbusPost', async () => {
  const { liveMovement } = require('../../netlify/functions/cancel-order')._test;
  const order = { id: 'o1', tracking_id: '372685510045', courier_name: 'Amazon Shipping' };
  const npUnknown = async () => ({ moved: null, status: '', error: 'awb not in response' });
  const amazon = (state, status) => async () => new Map([['o1', { state, status }]]);

  assert.deepEqual(await liveMovement(order, { npShipmentMoved: npUnknown, checkPickups: amazon('moved', 'Delivered') }),
    { moved: true, status: 'Delivered' });
  assert.equal((await liveMovement(order, { npShipmentMoved: npUnknown, checkPickups: amazon('waiting', 'Pickup Scheduled') })).moved, false);
  assert.equal((await liveMovement(order, { npShipmentMoved: npUnknown, checkPickups: amazon('unknown', '') })).moved, null,
    'nobody knows: unchanged behaviour (allowed on local state)');
  assert.equal((await liveMovement(order, { npShipmentMoved: async () => ({ moved: true, status: 'picked' }), checkPickups: amazon('unknown', '') })).moved, true);
  assert.equal((await liveMovement(order, { npShipmentMoved: npUnknown, checkPickups: async () => { throw new Error('down'); } })).moved, null);
  assert.equal((await liveMovement(order, { timeoutMs: 20, npShipmentMoved: () => new Promise(() => {}), checkPickups: amazon('moved', 'Delivered') })).moved, true,
    'a hung NimbusPost does not hide the other courier');
});
