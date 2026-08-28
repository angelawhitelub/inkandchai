/**
 * Google automated discounts — the storefront half.
 *
 * A visitor arriving from a Shopping ad that Google chose to discount lands on
 *   /product/<slug>/?pv2=<signed-token>
 * We hand that token to our own function, which verifies Google's ES256
 * signature server-side (the browser is never trusted to read a price out of a
 * token) and returns the discounted price plus an opaque 48-hour grant.
 *
 * Google's requirements, and how each is met:
 *   • show the discount on the product page for >= 30 minutes, even after the
 *     customer navigates away and returns WITHOUT the token
 *       → the grant is kept in localStorage for 48 hours and reapplied on load
 *   • honour it in the cart and checkout for >= 48 hours
 *       → the grant rides along with every checkout request, where the server
 *         re-verifies it before pricing the order
 *
 * The stored price is only ever cosmetic. utils/pricing.js re-derives every
 * amount from the catalogue and applies the grant itself, so a customer who
 * edits localStorage changes what they see and not what they pay.
 */
(function () {
  'use strict';

  var STORE_PREFIX = 'iac_gd_';
  var ENDPOINT = '/.netlify/functions/google-discount';

  function slugFromPath() {
    var m = String(location.pathname || '').match(/\/product\/([^/?#]+)\/?/i);
    return m ? decodeURIComponent(m[1]).toLowerCase() : '';
  }

  function read(slug) {
    try {
      var raw = localStorage.getItem(STORE_PREFIX + slug);
      if (!raw) return null;
      var v = JSON.parse(raw);
      if (!v || !v.grant || !(Number(v.exp) > Date.now())) {
        localStorage.removeItem(STORE_PREFIX + slug);
        return null;
      }
      return v;
    } catch (e) { return null; }
  }

  function write(slug, price, grant, expiresAt) {
    try {
      localStorage.setItem(STORE_PREFIX + slug, JSON.stringify({
        price: Number(price), grant: grant,
        exp: expiresAt ? Date.parse(expiresAt) : (Date.now() + 48 * 3600 * 1000),
      }));
    } catch (e) { /* private mode — the discount still applies for this page view */ }
  }

  // Every live grant, for the checkout payloads. Cheap enough to send them all:
  // the server ignores any that don't match a cart line.
  function grants() {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(STORE_PREFIX) !== 0) continue;
        var v = read(k.slice(STORE_PREFIX.length));
        if (v) out.push(v.grant);
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  function inr(n) {
    return '₹ ' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }

  // Repaint the product page's price. Kept deliberately narrow — the price
  // element carries data-product-price, which is also what cart.js reads when
  // the customer adds the book, so the two cannot disagree.
  function paint(price) {
    var el = document.querySelector('[data-product-price]');
    if (!el) return;
    var was = Number(el.getAttribute('data-product-price')) || 0;
    if (was && !(price < was)) return;      // never paint a rise
    el.setAttribute('data-product-price', String(price));
    el.textContent = inr(price);
    var orig = el.parentElement && el.parentElement.querySelector('.orig');
    if (orig && was) orig.textContent = inr(was);
    // Keep the "% off MRP" badge honest — the discount just moved the sale price.
    if (typeof window.syncSaveBadge === 'function') { try { window.syncSaveBadge(); } catch (e) {} }
    var badge = document.createElement('span');
    badge.className = 'iac-gd-badge';
    badge.style.cssText = 'display:inline-block;margin-left:.5rem;font-size:.62rem;letter-spacing:.1em;'
      + 'text-transform:uppercase;padding:.2rem .5rem;border:1px solid rgba(109,191,109,.5);color:#6dbf6d;';
    badge.textContent = 'Special price';
    if (!document.querySelector('.iac-gd-badge')) el.parentElement.appendChild(badge);
  }

  function apply() {
    var slug = slugFromPath();
    if (!slug) return;

    var token = new URLSearchParams(location.search).get('pv2');
    var stored = read(slug);

    if (!token) {
      if (stored) paint(stored.price);      // the >= 30 minute rule
      return;
    }

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pv2: token, slug: slug }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) { if (stored) paint(stored.price); return; }
        write(slug, d.price, d.grant, d.expires_at);
        paint(d.price);
      })
      .catch(function () { if (stored) paint(stored.price); });
  }

  window.iacDiscountGrants = grants;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
})();
