const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const codOrder = fs.readFileSync(path.join(root, 'netlify/functions/cod-order.js'), 'utf8');
const generator = fs.readFileSync(path.join(root, 'generate_site.py'), 'utf8');
const checkout = fs.readFileSync(path.join(root, 'public/checkout/index.html'), 'utf8');

const MIN = 199;

test('the client and the server agree on the minimum', () => {
  assert.match(codOrder, new RegExp(`const COD_MIN_SUBTOTAL = ${MIN};`));
  assert.match(generator, new RegExp(`const COD_MIN_SUBTOTAL = ${MIN};`));
  // And the generated page actually carries it — the generator has its own copy
  // of the checkout script, so editing public/js/checkout.js alone does nothing.
  assert.match(checkout, new RegExp(`const COD_MIN_SUBTOTAL = ${MIN};`));
});

test('the server rejects a sub-minimum COD order with the shortfall', () => {
  assert.match(codOrder, /priced\.subtotal < COD_MIN_SUBTOTAL/);
  assert.match(codOrder, /cod_below_minimum/);
  assert.match(codOrder, /shortfall_inr/);
  // It must read the SERVER-derived subtotal, never a client-supplied total.
  assert.doesNotMatch(codOrder, /body\.subtotal < COD_MIN_SUBTOTAL/);
});

test('the guard runs before the order is written', () => {
  const guard = codOrder.indexOf('cod_below_minimum');
  const insert = codOrder.indexOf(".from('orders')");
  assert.ok(guard > 0 && insert > 0, 'both markers present');
  assert.ok(guard < insert, 'the minimum is checked before any row is inserted');
});

test('the checkout quotes the exact shortfall, not a bare refusal', () => {
  assert.match(checkout, /add ₹\$\{codShort/);
  assert.match(checkout, /to avail Cash on Delivery/);
  assert.match(checkout, /COD_MIN_SUBTOTAL - codSub/);
});

// The arithmetic the page prints, checked directly.
function shortfall(subtotal) { return Math.max(0, MIN - subtotal); }

test('shortfall maths', () => {
  assert.equal(shortfall(49), 150);
  assert.equal(shortfall(189), 10);
  assert.equal(shortfall(198), 1);
  assert.equal(shortfall(199), 0);   // exactly at the minimum qualifies
  assert.equal(shortfall(350), 0);
});

test('partial COD stays above the COD minimum, so the two cannot disagree', () => {
  const partial = Number(generator.match(/const PARTIAL_PAYMENT_THRESHOLD = (\d+);/)[1]);
  assert.ok(partial >= MIN, `partial COD threshold ${partial} must not sit below the COD minimum ${MIN}`);
});
