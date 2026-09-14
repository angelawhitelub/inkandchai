const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolvePaymentType,
  refundBasePaise,
  needsManualPayout,
  resolvePayoutDestination,
  payoutLabel,
  payoutLabelMasked,
} = require('./return-refund');

const partialCodOrder = (extra = {}) => ({
  amount_paise: 4090,                                  // the 10% deposit captured online
  razorpay_payment_id: 'T2508061234567890',
  cart_items: [{ _payment: { mode: 'partial_cod', full_total: 409, balance: 368.1 } }],
  ...extra,
});

test('partial COD is its own payment type, not prepaid', () => {
  assert.equal(resolvePaymentType(partialCodOrder()), 'partial_cod');
  assert.equal(resolvePaymentType({ razorpay_payment_id: 'pay_X' }), 'prepaid');
  assert.equal(resolvePaymentType({ razorpay_payment_id: null }), 'cod');
});

test('the refund base for partial COD is everything the customer paid', () => {
  // Deposit online + cash to the courier. This is the number that must reach
  // them, and it is nine times what the gateway could ever return.
  assert.equal(refundBasePaise(partialCodOrder()), 40900);
});

test('both cash-carrying payment types need a manual payout', () => {
  // The bug this fixes: partial_cod answered false here, so its refund was
  // routed to a gateway holding only the deposit.
  assert.equal(needsManualPayout('cod'), true);
  assert.equal(needsManualPayout('partial_cod'), true);
  assert.equal(needsManualPayout('prepaid'), false);
  assert.equal(needsManualPayout(''), false);
  assert.equal(needsManualPayout(undefined), false);
  assert.equal(needsManualPayout('PARTIAL_COD'), true);
});

test('a UPI id is accepted and wins over bank details', () => {
  const r = resolvePayoutDestination({ upiId: '9580219645@ybl' });
  assert.equal(r.ok, true);
  assert.equal(r.destination.upiId, '9580219645@ybl');
  assert.equal(r.destination.bankAccount, '');
});

test('a full bank triplet is accepted, normalised', () => {
  const r = resolvePayoutDestination({
    bankAccount: '5010 0123-456789', bankIfsc: 'hdfc0001234', bankHolder: '  Mohit Pandey ',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.destination, {
    upiId: '', bankAccount: '50100123456789', bankIfsc: 'HDFC0001234', bankHolder: 'Mohit Pandey',
  });
});

test('a half-filled bank triplet is refused, not silently ignored', () => {
  // Someone who typed an account number has asked for a bank transfer. Letting
  // it through would store a destination nobody can actually pay.
  assert.equal(resolvePayoutDestination({ bankAccount: '50100123456789' }).ok, false);
  assert.equal(resolvePayoutDestination({ bankAccount: '50100123456789', bankIfsc: 'HDFC0001234' }).ok, false);
  assert.equal(resolvePayoutDestination({ bankIfsc: 'HDFC0001234' }).ok, false);
});

test('malformed destinations are refused with something a customer can act on', () => {
  assert.match(resolvePayoutDestination({ upiId: 'not-a-upi' }).error, /UPI/i);
  assert.match(resolvePayoutDestination({ bankAccount: '123', bankIfsc: 'HDFC0001234', bankHolder: 'A B' }).error, /account number/i);
  assert.match(resolvePayoutDestination({ bankAccount: '50100123456789', bankIfsc: 'NOPE', bankHolder: 'A B' }).error, /IFSC/i);
  assert.match(resolvePayoutDestination({}).error, /UPI ID, or your bank account/i);
});

test('an IFSC must have the zero in the fifth position', () => {
  const ok = (ifsc) => resolvePayoutDestination({ bankAccount: '50100123456789', bankIfsc: ifsc, bankHolder: 'A B' }).ok;
  assert.equal(ok('HDFC0001234'), true);
  assert.equal(ok('HDFC1001234'), false);   // real IFSCs always carry the 0
  assert.equal(ok('HDFC000123'), false);    // too short
});

test('the payout label says enough to make the transfer', () => {
  assert.equal(payoutLabel({ upiId: 'a@b' }), 'UPI a@b');
  assert.equal(
    payoutLabel({ bankAccount: '50100123456789', bankIfsc: 'HDFC0001234', bankHolder: 'Mohit Pandey' }),
    'A/c 50100123456789 · HDFC0001234 · Mohit Pandey',
  );
  assert.equal(payoutLabel({}), '');
});

test('the customer-facing label never repeats a full account number back', () => {
  // They know their own account; an email is a worse place for all 14 digits.
  const masked = payoutLabelMasked({ bankAccount: '50100123456789', bankIfsc: 'HDFC0001234' });
  assert.match(masked, /ending 6789/);
  assert.doesNotMatch(masked, /50100123456789/);
  assert.equal(payoutLabelMasked({ upiId: 'a@b' }), 'UPI a@b');
  assert.equal(payoutLabelMasked({}), 'the details you gave us');
});
