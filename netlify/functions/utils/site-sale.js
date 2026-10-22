'use strict';

/**
 * Site-wide sales: an automatic % off every order above a threshold, on every
 * payment mode (prepaid, COD and partial COD), for a fixed window.
 *
 * This is the till. The storefront banners and timers (public/js/festive-sale.js)
 * and the checkout page (CHECKOUT_HTML in generate_site.py) only describe it,
 * and MUST carry the same dates, threshold and percentage -- a page that shows
 * a different total is answered with a 409 "price changed".
 *
 * "Above ₹399" is strict: ₹399 does not qualify, ₹400 does.
 */
const SITE_SALES = Object.freeze([
  Object.freeze({
    code: 'FREEDOM', name: 'Freedom Sale', percent: 15, threshold: 399,
    startsAt: '2026-08-12T18:30:00Z', endsAt: '2026-08-15T18:29:59Z', // 13–15 Aug 2026 IST
  }),
  Object.freeze({
    code: 'FESTIVE10', name: 'Dussehra & Diwali Sale', percent: 10, threshold: 399,
    startsAt: '2026-10-19T18:30:00Z', endsAt: '2026-11-10T18:29:59Z', // 20 Oct – 10 Nov 2026 IST
  }),
]);

const ms = (iso) => new Date(iso).getTime();
const timeOf = (now) => (now instanceof Date ? now.getTime() : Number(now));

/** The sale running at `now`, or null. */
function activeSiteSale(now = Date.now()) {
  const t = timeOf(now);
  if (!Number.isFinite(t)) return null;
  return SITE_SALES.find((s) => t >= ms(s.startsAt) && t <= ms(s.endsAt)) || null;
}

/** { code, discount, source: 'site_sale', label } for this subtotal, or a zero discount. */
function siteSaleDiscount(subtotal, now = Date.now()) {
  const value = Number(subtotal) || 0;
  const sale = activeSiteSale(now);
  if (!sale || value <= sale.threshold) return { code: '', discount: 0, source: '' };
  return {
    code: sale.code,
    discount: Math.max(0, Math.floor(value * sale.percent / 100)),
    source: 'site_sale',
    label: `${sale.name} ${sale.percent}% off`,
  };
}

/**
 * The sale against a code the customer chose: whichever is worth more, the
 * sale on a tie. `other` is the code's own result ({ discount }).
 */
function betterOfSale(saleHit, other) {
  if (!(saleHit && saleHit.discount > 0)) return other;
  return other && other.discount > saleHit.discount ? other : saleHit;
}

module.exports = { SITE_SALES, activeSiteSale, siteSaleDiscount, betterOfSale };
