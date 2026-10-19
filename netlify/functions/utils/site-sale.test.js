const test = require('node:test');
const assert = require('node:assert/strict');
const { SITE_SALES, activeSiteSale, siteSaleDiscount, betterOfSale } = require('./site-sale');

const festive = new Date('2026-10-25T12:00:00Z');

test('Dussehra & Diwali: 10% off above ₹399, from 20 Oct to the end of 10 Nov IST', () => {
  assert.deepEqual(siteSaleDiscount(400, festive), {
    code: 'FESTIVE10', discount: 40, source: 'site_sale', label: 'Dussehra & Diwali Sale 10% off',
  });
  assert.equal(siteSaleDiscount(1299, festive).discount, 129);
  assert.equal(siteSaleDiscount(399, festive).discount, 0, '₹399 is not above ₹399');
  assert.equal(activeSiteSale(new Date('2026-10-19T18:29:59Z')), null, 'not before midnight 20 Oct IST');
  assert.equal(activeSiteSale(new Date('2026-10-19T18:30:00Z')).code, 'FESTIVE10');
  assert.equal(activeSiteSale(new Date('2026-11-10T18:29:59Z')).code, 'FESTIVE10', 'all of 10 Nov IST');
  assert.equal(activeSiteSale(new Date('2026-11-10T18:30:00Z')), null);
  assert.equal(siteSaleDiscount(999, new Date('2026-11-11T00:00:00Z')).discount, 0);
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
  const sale = siteSaleDiscount(2000, festive);          // 200
  assert.equal(betterOfSale(sale, { code: 'SAVE15', discount: 300 }).code, 'SAVE15');
  assert.equal(betterOfSale(sale, { code: 'INKLOVE10', discount: 200 }).code, 'FESTIVE10', 'tie goes to the sale');
  assert.equal(betterOfSale({ discount: 0 }, { code: 'X', discount: 5 }).code, 'X');
});
