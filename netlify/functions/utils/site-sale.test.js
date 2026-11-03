const test = require('node:test');
const assert = require('node:assert/strict');
const { SITE_SALES, activeSiteSale, siteSaleDiscount, betterOfSale } = require('./site-sale');

const festive = new Date('2026-10-25T12:00:00Z');

test('Dussehra & Diwali: 7% off above ₹499 with FESTIVE7 only, from 20 Oct to the end of 10 Nov IST', () => {
  assert.deepEqual(siteSaleDiscount(500, festive, 'FESTIVE7'), {
    code: 'FESTIVE7', discount: 35, source: 'site_sale', label: 'Dussehra & Diwali Sale 7% off',
  });
  assert.equal(siteSaleDiscount(1299, festive, ' festive7 ').discount, 90, 'the code is normalised');
  assert.equal(siteSaleDiscount(1299, festive).discount, 0, 'not automatic: no code, no sale');
  assert.equal(siteSaleDiscount(1299, festive, 'FESTIVE10').discount, 0, 'the old code is gone');
  assert.equal(siteSaleDiscount(1299, festive, 'INKLOVE10').discount, 0);
  assert.equal(siteSaleDiscount(499, festive, 'FESTIVE7').discount, 0, '₹499 is not above ₹499');
  assert.equal(activeSiteSale(new Date('2026-10-19T18:29:59Z')), null, 'not before midnight 20 Oct IST');
  assert.equal(activeSiteSale(new Date('2026-10-19T18:30:00Z')).code, 'FESTIVE7');
  assert.equal(activeSiteSale(new Date('2026-11-10T18:29:59Z')).code, 'FESTIVE7', 'all of 10 Nov IST');
  assert.equal(activeSiteSale(new Date('2026-11-10T18:30:00Z')), null);
  assert.equal(siteSaleDiscount(999, new Date('2026-11-11T00:00:00Z'), 'FESTIVE7').discount, 0);
});

test('the Freedom Sale keeps its old window and amounts', () => {
  const during = new Date('2026-08-15T12:00:00Z');
  assert.equal(siteSaleDiscount(400, during).code, 'FREEDOM');
  assert.equal(siteSaleDiscount(999, during).discount, 149);
  assert.equal(siteSaleDiscount(500, new Date('2026-08-15T18:30:00Z')).discount, 0);
});

test('sales never overlap', () => {
  const sorted = [...SITE_SALES].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  for (let i = 1; i < sorted.length; i++) assert.ok(new Date(sorted[i].startsAt) > new Date(sorted[i - 1].endsAt));
});

test('a code worth more than the sale wins; otherwise the sale', () => {
  const sale = siteSaleDiscount(2000, festive, 'FESTIVE7');   // 140
  assert.equal(betterOfSale(sale, { code: 'SAVE15', discount: 300 }).code, 'SAVE15');
  assert.equal(betterOfSale(sale, { code: 'X', discount: 140 }).code, 'FESTIVE7', 'tie goes to the sale');
  assert.equal(betterOfSale({ discount: 0 }, { code: 'X', discount: 5 }).code, 'X');
});
