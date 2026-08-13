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
