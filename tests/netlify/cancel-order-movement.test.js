const test = require('node:test');
const assert = require('node:assert/strict');

const { shipmentHasMoved } = require('../../netlify/functions/cancel-order')._test;
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
