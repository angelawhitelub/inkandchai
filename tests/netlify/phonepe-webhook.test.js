const test = require('node:test');
const assert = require('node:assert/strict');

const {
  refundMerchantIdFromPayload,
  orderIdFromRefundMerchantId,
  originalOrderIdFromRefundPayload,
  refundDecision,
} = require('../../netlify/functions/phonepe-webhook')._test;

test('extracts the original order from an Ink & Chai refund merchant id', () => {
  assert.equal(
    orderIdFromRefundMerchantId('REFUND-IC-20260713-VKOZK-1783959501740'),
    'IC-20260713-VKOZK'
  );
  assert.equal(
    orderIdFromRefundMerchantId('REFUND-IC-CW-20260630-KD9HO-1783959501740'),
    'IC-CW-20260630-KD9HO'
  );
});

test('prefers PhonePe originalMerchantOrderId when supplied', () => {
  assert.equal(originalOrderIdFromRefundPayload({
    originalMerchantOrderId: 'IC-ORIGINAL',
    merchantOrderId: 'REFUND-IC-WRONG-1783959501740',
  }), 'IC-ORIGINAL');
});

test('supports common refund merchant id field names', () => {
  assert.equal(refundMerchantIdFromPayload({
    merchantRefundId: 'REFUND-IC-ONE-1783959501740',
  }), 'REFUND-IC-ONE-1783959501740');
  assert.equal(originalOrderIdFromRefundPayload({
    merchant_order_id: 'REFUND-IC-TWO-1783959501740',
  }), 'IC-TWO');
});

test('rejects unrecognised refund ids instead of guessing an order', () => {
  assert.equal(orderIdFromRefundMerchantId('T2607132148224673546857'), '');
});

test('completed refunds are full or partial according to the refunded amount', () => {
  assert.deepEqual(refundDecision({ amount_paise: 3900 }, 'COMPLETED', 3900), {
    status: 'refunded', refundState: 'COMPLETED',
  });
  assert.deepEqual(refundDecision({ amount_paise: 3900 }, 'COMPLETED', 1000), {
    status: 'partially_refunded', refundState: 'COMPLETED',
  });
});

test('a later failure can never downgrade a completed refund', () => {
  assert.deepEqual(refundDecision({ status: 'refunded', refund_state: 'COMPLETED' }, 'FAILED', 3900), {
    ignore: 'stale-refund-failure',
  });
});
