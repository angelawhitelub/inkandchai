'use strict';

const FREEDOM_SALE = Object.freeze({
  code: 'FREEDOM',
  percent: 15,
  // "Above ₹399" is intentionally strict: ₹399 does not qualify; ₹400 does.
  threshold: 399,
  endsAt: '2026-08-15T18:29:59Z', // 15 Aug 2026, 11:59:59 PM IST
});

function freedomSaleIsLive(now = Date.now()) {
  const time = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(time) && time <= new Date(FREEDOM_SALE.endsAt).getTime();
}

function freedomSaleDiscount(subtotal, now = Date.now()) {
  const value = Number(subtotal) || 0;
  if (!freedomSaleIsLive(now) || value <= FREEDOM_SALE.threshold) {
    return { code: '', discount: 0, source: '' };
  }
  return {
    code: FREEDOM_SALE.code,
    discount: Math.max(0, Math.floor(value * FREEDOM_SALE.percent / 100)),
    source: 'freedom_sale',
  };
}

module.exports = { FREEDOM_SALE, freedomSaleIsLive, freedomSaleDiscount };
