const test = require('node:test');
const assert = require('node:assert/strict');
const { FREEDOM_SALE, freedomSaleIsLive, freedomSaleDiscount } = require('./freedom-sale');

const duringSale = new Date('2026-08-15T12:00:00Z');
const afterSale = new Date('2026-08-15T18:30:00Z');

test('FREEDOM gives 15% off above ₹399', () => {
  assert.deepEqual(freedomSaleDiscount(400, duringSale), {
    code: 'FREEDOM', discount: 60, source: 'freedom_sale',
  });
  assert.equal(freedomSaleDiscount(999, duringSale).discount, 149);
});

test('₹399 does not qualify because the offer says above ₹399', () => {
  assert.equal(freedomSaleDiscount(399, duringSale).discount, 0);
});

test('sale ends at midnight after Independence Day', () => {
  assert.equal(FREEDOM_SALE.endsAt, '2026-08-15T18:29:59Z');
  assert.equal(freedomSaleIsLive(afterSale), false);
  assert.equal(freedomSaleDiscount(500, afterSale).discount, 0);
});
