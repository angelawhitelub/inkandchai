/**
 * summer-sale.js — injects a Summer Sale countdown block on static book product pages.
 * Loaded by every static /product/<slug>/index.html page.
 * Safe to include after sale ends: removes itself if expired.
 */
(function () {
  var SALE_END = new Date('2026-05-19T18:30:00Z');
  var COUPON   = 'SUMMER10';
  var MIN_PRICE = 299;

  if (Date.now() >= SALE_END.getTime()) return; // sale over — do nothing

  // Get price from the currentItem global (set inline on every static page)
  var price = (typeof currentItem !== 'undefined' && currentItem.price) ? Number(currentItem.price) : 0;

  // Fallback: parse from [data-product-price] span
  if (!price) {
    var priceEl = document.querySelector('[data-product-price]');
    if (priceEl) price = parseFloat(priceEl.textContent.replace(/[^\d.]/g, '')) || 0;
  }

  if (price < MIN_PRICE) return; // not eligible

  var salePrice = Math.round(price * 0.90);
  var saving    = price - salePrice;

  // Build the sale box HTML
  var box = document.createElement('div');
  box.className = 'prod-sale-box';
  box.id = 'prodSaleBox';
  box.innerHTML =
    '<div class="prod-sale-box-head">Summer Sale — ends soon</div>' +
    '<div>' +
      '<span class="prod-sale-price">₹' + salePrice.toLocaleString('en-IN') + '</span>' +
      '<span class="prod-sale-saving">Save ₹' + saving + ' (10% off)</span>' +
    '</div>' +
    '<div class="prod-sale-code">Use code ' +
      '<strong id="ssCoupon" title="Click to copy" onclick="(function(){' +
        'navigator.clipboard&&navigator.clipboard.writeText(\'' + COUPON + '\').catch(function(){});' +
        'var el=document.getElementById(\'ssCoupon\');' +
        'el.textContent=\'Copied!\';' +
        'setTimeout(function(){el.textContent=\'' + COUPON + '\';},1800);' +
      '})()">' + COUPON + '</strong>' +
      ' · 10% off prepaid orders ₹' + MIN_PRICE + '+' +
    '</div>' +
    '<div class="prod-sale-timer">' +
      '<span class="prod-cd-label">Ends in</span>' +
      '<div class="prod-cd">' +
        '<div class="prod-cd-block"><span class="prod-cd-num" id="ss-d">00</span><span class="prod-cd-lbl">Days</span></div>' +
        '<span class="prod-cd-sep">:</span>' +
        '<div class="prod-cd-block"><span class="prod-cd-num" id="ss-h">00</span><span class="prod-cd-lbl">Hrs</span></div>' +
        '<span class="prod-cd-sep">:</span>' +
        '<div class="prod-cd-block"><span class="prod-cd-num" id="ss-m">00</span><span class="prod-cd-lbl">Min</span></div>' +
        '<span class="prod-cd-sep">:</span>' +
        '<div class="prod-cd-block"><span class="prod-cd-num" id="ss-s">00</span><span class="prod-cd-lbl">Sec</span></div>' +
      '</div>' +
    '</div>';

  // Insert after the price/orig line — find the element containing [data-product-price]
  var priceWrapper = document.querySelector('[data-product-price]');
  var insertAfter  = priceWrapper ? priceWrapper.closest('div') || priceWrapper.parentNode : null;
  if (insertAfter && insertAfter.parentNode) {
    insertAfter.parentNode.insertBefore(box, insertAfter.nextSibling);
  }

  // Countdown tick
  function tick() {
    var diff = SALE_END.getTime() - Date.now();
    if (diff <= 0) {
      var b = document.getElementById('prodSaleBox');
      if (b) b.remove();
      return;
    }
    var d = Math.floor(diff / 86400000);
    var h = Math.floor((diff % 86400000) / 3600000);
    var m = Math.floor((diff % 3600000)  / 60000);
    var s = Math.floor((diff % 60000)    / 1000);
    function pad(n){ return n < 10 ? '0' + n : String(n); }
    var dEl = document.getElementById('ss-d');
    var hEl = document.getElementById('ss-h');
    var mEl = document.getElementById('ss-m');
    var sEl = document.getElementById('ss-s');
    if (dEl) dEl.textContent = pad(d);
    if (hEl) hEl.textContent = pad(h);
    if (mEl) mEl.textContent = pad(m);
    if (sEl) sEl.textContent = pad(s);
  }

  tick();
  setInterval(tick, 1000);
})();
