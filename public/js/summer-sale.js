/**
 * Injects the Independence Day Freedom Sale block on static product pages.
 * Loaded by every static /product/<slug>/index.html page.
 * Safe to include after sale ends: removes itself if expired.
 * Self-contained: injects its own CSS so it doesn't depend on external stylesheets.
 */
(function () {
  var SALE_END   = new Date('2026-08-15T18:29:59Z');
  var COUPON     = 'FREEDOM';
  var MIN_PRICE  = 400;

  if (Date.now() >= SALE_END.getTime()) return; // sale over — do nothing

  function init() {
    // Get price from the currentItem global (set inline on every static page)
    var price = (typeof currentItem !== 'undefined' && currentItem.price) ? Number(currentItem.price) : 0;

    // Fallback: parse from [data-product-price] span
    if (!price) {
      var priceEl = document.querySelector('[data-product-price]');
      if (priceEl) price = parseFloat(priceEl.textContent.replace(/[^\d.]/g, '')) || 0;
    }

    // Inject CSS (only once)
    if (!document.getElementById('ss-style')) {
      var style = document.createElement('style');
      style.id = 'ss-style';
      style.textContent = [
        '.prod-sale-box{margin:.75rem 0 .25rem;padding:.75rem 1rem;background:linear-gradient(115deg,rgba(255,153,51,.14),rgba(255,255,255,.05),rgba(19,136,8,.14));border:1px solid rgba(255,255,255,.16);border-left:3px solid #ff9933;border-right:3px solid #138808}',
        '.prod-sale-box-head{font-size:.55rem;letter-spacing:.2em;text-transform:uppercase;color:#ffb865;margin-bottom:.4rem;font-family:Montserrat,sans-serif}',
        '.prod-sale-price{font-family:"Cormorant Garamond",Georgia,serif;font-size:1.5rem;color:#f2cf71;font-weight:600}',
        '.prod-sale-saving,.prod-sale-code{font-size:.65rem;color:rgba(255,255,255,.75);margin-left:.5rem;font-family:Montserrat,sans-serif}',
        '.prod-sale-code{margin:.4rem 0 0;letter-spacing:.06em}',
        '.prod-sale-code strong{color:#ffb865;letter-spacing:.15em}',
        '.prod-sale-timer{display:flex;align-items:center;gap:.6rem;margin-top:.5rem;flex-wrap:wrap}',
        '.prod-cd-label{font-size:.52rem;letter-spacing:.14em;text-transform:uppercase;color:#e87070;font-family:Montserrat,sans-serif}',
        '.prod-cd{display:flex;gap:.25rem;align-items:flex-start}',
        '.prod-cd-block{background:rgba(139,26,26,.2);border:1px solid rgba(180,40,40,.35);padding:.3rem .45rem;text-align:center;min-width:34px}',
        '.prod-cd-num{font-family:Montserrat,sans-serif;font-size:.9rem;font-weight:700;color:#e87070;display:block;line-height:1}',
        '.prod-cd-lbl{font-size:.35rem;letter-spacing:.1em;text-transform:uppercase;color:rgba(232,112,112,.7);display:block;font-family:Montserrat,sans-serif}',
        '.prod-cd-sep{font-size:.9rem;color:rgba(232,112,112,.5);line-height:1.4;font-weight:300}'
      ].join('');
      document.head.appendChild(style);
    }

    var eligible = price >= MIN_PRICE;
    var salePrice = Math.max(1, price - Math.floor(price * 0.15));
    var saving    = price - salePrice;

    // Build the sale box HTML
    var box = document.createElement('div');
    box.className = 'prod-sale-box';
    box.id = 'prodSaleBox';
    box.innerHTML =
      '<div class="prod-sale-box-head">🇮🇳 Freedom Sale · ends 15 August</div>' +
      (eligible ? '<div>' +
        '<span class="prod-sale-price">₹' + salePrice.toLocaleString('en-IN') + '</span>' +
        '<span class="prod-sale-saving">Save ₹' + saving + ' (15% off)</span>' +
      '</div>' : '') +
      '<div class="prod-sale-code"><strong>' + COUPON + '</strong> auto-applies when your order subtotal is above ₹399.</div>' +
      '<div class="prod-sale-timer">' +
        '<span class="prod-cd-label">Ends in</span>' +
        '<div class="prod-cd">' +
          '<div class="prod-cd-block"><span class="prod-cd-num" id="ss-d">--</span><span class="prod-cd-lbl">Days</span></div>' +
          '<span class="prod-cd-sep">:</span>' +
          '<div class="prod-cd-block"><span class="prod-cd-num" id="ss-h">--</span><span class="prod-cd-lbl">Hrs</span></div>' +
          '<span class="prod-cd-sep">:</span>' +
          '<div class="prod-cd-block"><span class="prod-cd-num" id="ss-m">--</span><span class="prod-cd-lbl">Min</span></div>' +
          '<span class="prod-cd-sep">:</span>' +
          '<div class="prod-cd-block"><span class="prod-cd-num" id="ss-s">--</span><span class="prod-cd-lbl">Sec</span></div>' +
        '</div>' +
      '</div>';

    // Insert after the price/orig line
    var priceWrapper = document.querySelector('[data-product-price]');
    var insertAfter  = priceWrapper ? (priceWrapper.closest('div') || priceWrapper.parentNode) : null;
    if (insertAfter && insertAfter.parentNode) {
      insertAfter.parentNode.insertBefore(box, insertAfter.nextSibling);
    } else {
      // Last resort: prepend to first <section> inside main
      var sec = document.querySelector('main section');
      if (sec) sec.insertBefore(box, sec.firstChild);
    }

    // Countdown tick
    function tick() {
      var diff = SALE_END.getTime() - Date.now();
      if (diff <= 0) {
        var b = document.getElementById('prodSaleBox');
        if (b) b.remove();
        return;
      }
      function pad(n) { return n < 10 ? '0' + n : String(n); }
      var dEl = document.getElementById('ss-d');
      var hEl = document.getElementById('ss-h');
      var mEl = document.getElementById('ss-m');
      var sEl = document.getElementById('ss-s');
      if (dEl) dEl.textContent = pad(Math.floor(diff / 86400000));
      if (hEl) hEl.textContent = pad(Math.floor((diff % 86400000) / 3600000));
      if (mEl) mEl.textContent = pad(Math.floor((diff % 3600000)  / 60000));
      if (sEl) sEl.textContent = pad(Math.floor((diff % 60000)    / 1000));
    }

    tick();
    setInterval(tick, 1000);
  }

  // Run after DOM is ready (handles both sync and async load)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

// Static catalogue pages already load this file. Load the independent runtime
// gallery enhancer here so existing generated pages gain admin-managed cover
// and gallery overrides without rebuilding thousands of product HTML files.
if (/^\/product\/[^/]+\/?$/.test(location.pathname)) {
  import('/js/product-gallery-overrides.js').catch(function (error) {
    console.warn('Product gallery enhancer unavailable:', error.message);
  });
}
