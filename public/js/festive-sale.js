/**
 * Dussehra & Diwali Sale — the storefront dressing (20 Oct – 10 Nov 2026 IST).
 *
 * Flat 10% off every order above ₹399, applied automatically on every payment
 * mode. The till is netlify/functions/utils/site-sale.js (FESTIVE10) and the
 * checkout page mirrors it; this file only advertises it, so its dates,
 * threshold and percentage MUST match those two.
 *
 * Loaded on every storefront page through the IAC-THEME block (site_theme.py,
 * and utils/site-theme.js for function-rendered pages). Outside the window it
 * does nothing, and when the countdown reaches zero on an open page it removes
 * everything it added -- an ended sale must never keep advertising itself.
 *
 *   • a festive bar with a live countdown at the top of every page
 *   • a hero with a big countdown above the homepage carousel
 *   • on a product page, the price after 10% (or how much more to add)
 *   • a one-line reminder in the cart drawer
 */
(function () {
  'use strict';

  var SALE = {
    code: 'FESTIVE10',
    percent: 10,
    threshold: 399,                                   // strictly above: ₹400 qualifies
    start: Date.parse('2026-10-19T18:30:00Z'),        // 20 Oct 2026, 00:00 IST
    end: Date.parse('2026-11-10T18:29:59Z'),          // 10 Nov 2026, 23:59:59 IST
    diwali: Date.parse('2026-11-07T18:30:00Z'),       // 8 Nov 2026, 00:00 IST
  };
  var IST = 5.5 * 3600000;

  function live(now) { return now >= SALE.start && now <= SALE.end; }
  if (!live(Date.now())) return;
  if (/^\/admin(\/|$)/.test(location.pathname)) return;

  var path = location.pathname;
  var isHome = path === '/' || path === '/index.html';
  var isProduct = /^\/product\/[^/]+\/?$/.test(path);
  var isCheckout = /^\/checkout(\/|$)/.test(path);

  function istDay(t) { return Math.floor((t + IST) / 86400000); }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function inr(n) { return '₹' + Math.round(n).toLocaleString('en-IN'); }

  /** The headline changes with the festival: Dussehra, the run-up, Diwali, last call. */
  function phase(now) {
    var today = istDay(now);
    var dussehra = istDay(SALE.start);
    var diwali = istDay(SALE.diwali);
    var d = diwali - today;
    var until = d === 1 ? 'Diwali is tomorrow' : 'Diwali in ' + d + ' days';
    if (today === dussehra) return { head: 'Happy Dussehra! 🏹', sub: until };
    if (today < diwali) return { head: 'Diwali Sale 🪔', sub: until };
    if (today === diwali) return { head: 'Happy Diwali! 🪔', sub: 'Festive Sale on till 10 Nov' };
    return { head: 'Last days! 🪔', sub: 'Festive Sale ends 10 Nov' };
  }

  var CSS = [
    '.iacf-bar{position:relative;z-index:60;background:linear-gradient(100deg,#5a0f12 0%,#8e1c13 38%,#b5470f 72%,#7a1410 100%);color:#fff6e3;font-family:"Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center;padding:.62rem 2.4rem .7rem;line-height:1.35;font-size:.86rem;}',
    '.iacf-bar::after{content:"";position:absolute;left:0;right:0;bottom:-9px;height:9px;pointer-events:none;background:radial-gradient(circle at 7px 0,#ffb320 0 5px,transparent 5.5px) 0 0/28px 9px repeat-x,radial-gradient(circle at 21px 0,#ff7a12 0 4px,transparent 4.5px) 0 0/28px 9px repeat-x;filter:drop-shadow(0 1px 0 rgba(0,0,0,.15));}',
    '.iacf-bar b{color:#ffd56b;font-weight:800;letter-spacing:.01em;}',
    '.iacf-bar .iacf-sep{opacity:.55;margin:0 .45rem;}',
    '.iacf-bar .iacf-sub{color:#ffe7b0;}',
    '.iacf-bar .iacf-clock{display:inline-flex;gap:.25rem;align-items:center;margin-left:.35rem;font-variant-numeric:tabular-nums;font-weight:800;}',
    '.iacf-bar .iacf-clock span{background:rgba(0,0,0,.28);border:1px solid rgba(255,213,107,.35);border-radius:6px;padding:.05rem .32rem;color:#ffe7b0;}',
    '.iacf-bar a.iacf-shop{display:inline-block;margin-left:.6rem;padding:.2rem .7rem;border-radius:999px;background:#ffd56b;color:#4a0d0d;font-weight:800;text-decoration:none;font-size:.78rem;}',
    '.iacf-bar a.iacf-shop:hover{background:#ffe7a0;}',
    '.iacf-bar button.iacf-x{position:absolute;right:.5rem;top:50%;transform:translateY(-50%);background:none;border:0;color:#ffe7b0;font-size:1.15rem;line-height:1;cursor:pointer;padding:.3rem .45rem;opacity:.8;}',
    '@media (max-width:640px){.iacf-bar{font-size:.78rem;padding:.55rem 2rem .62rem;}.iacf-bar .iacf-hide-sm,.iacf-bar a.iacf-shop{display:none;}}',

    '.iacf-hero{position:relative;overflow:hidden;margin:1.4rem clamp(.75rem,3vw,2.5rem) .6rem;border-radius:22px;padding:clamp(1.4rem,4vw,2.6rem) clamp(1.1rem,4vw,3rem);color:#fff6e3;font-family:"Plus Jakarta Sans",system-ui,sans-serif;',
    'background:radial-gradient(120% 140% at 85% 10%,rgba(255,179,32,.35) 0,transparent 45%),radial-gradient(90% 120% at 10% 100%,rgba(255,122,18,.28) 0,transparent 50%),linear-gradient(135deg,#3d0a0c 0%,#6e1512 45%,#8e2a10 100%);box-shadow:0 18px 44px rgba(70,10,10,.28);}',
    '.iacf-hero::before{content:"";position:absolute;left:0;right:0;top:0;height:14px;background:radial-gradient(circle at 10px 4px,#ffb320 0 6px,transparent 6.5px) 0 0/40px 14px repeat-x,radial-gradient(circle at 30px 4px,#ff7a12 0 5px,transparent 5.5px) 0 0/40px 14px repeat-x,linear-gradient(#2f7d32,#2f7d32) 0 0/100% 2px no-repeat;}',
    '.iacf-hero-in{position:relative;display:flex;flex-wrap:wrap;gap:1.4rem 2.4rem;align-items:center;justify-content:space-between;}',
    '.iacf-eyebrow{font-size:.78rem;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#ffd56b;}',
    '.iacf-title{font-family:"DM Serif Display",Georgia,serif;font-size:clamp(1.9rem,5vw,3.3rem);line-height:1.05;margin:.35rem 0 .5rem;color:#fff6e3;}',
    '.iacf-title em{font-style:normal;color:#ffd56b;}',
    '.iacf-lead{font-size:clamp(.95rem,1.8vw,1.1rem);color:#ffe7b0;max-width:34rem;margin:0;}',
    '.iacf-lead b{color:#fff;}',
    '.iacf-cta{display:inline-block;margin-top:1rem;padding:.75rem 1.5rem;border-radius:999px;background:#ffd56b;color:#4a0d0d;font-weight:800;text-decoration:none;box-shadow:0 6px 18px rgba(255,179,32,.35);}',
    '.iacf-cta:hover{background:#ffe7a0;}',
    '.iacf-timer{text-align:center;}',
    '.iacf-timer-label{font-size:.72rem;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#ffd56b;margin-bottom:.5rem;}',
    '.iacf-cd{display:flex;gap:.45rem;justify-content:center;}',
    '.iacf-cd div{min-width:64px;padding:.55rem .4rem .45rem;border-radius:14px;background:rgba(0,0,0,.28);border:1px solid rgba(255,213,107,.35);}',
    '.iacf-cd b{display:block;font-size:clamp(1.5rem,4vw,2.1rem);line-height:1;font-weight:800;font-variant-numeric:tabular-nums;color:#fff6e3;}',
    '.iacf-cd i{display:block;font-style:normal;font-size:.62rem;letter-spacing:.14em;text-transform:uppercase;color:#ffd56b;margin-top:.3rem;}',
    '.iacf-diyas{margin-top:.7rem;font-size:1.35rem;letter-spacing:.35rem;}',
    '.iacf-flame{display:inline-block;animation:iacf-flicker 2.4s ease-in-out infinite;}',
    '.iacf-flame:nth-child(2){animation-delay:.6s}.iacf-flame:nth-child(3){animation-delay:1.2s}.iacf-flame:nth-child(4){animation-delay:1.8s}',
    '@keyframes iacf-flicker{0%,100%{transform:translateY(0) scale(1);filter:drop-shadow(0 0 4px rgba(255,190,60,.7))}50%{transform:translateY(-2px) scale(1.06);filter:drop-shadow(0 0 10px rgba(255,190,60,.95))}}',
    '@media (max-width:640px){.iacf-hero-in{flex-direction:column;align-items:flex-start;}.iacf-timer{width:100%;}.iacf-cd div{min-width:0;flex:1;}}',

    '.iacf-pdp{margin:.7rem 0 .45rem;padding:.75rem .95rem;border-radius:14px;background:linear-gradient(120deg,rgba(142,28,19,.10),rgba(255,179,32,.14));border:1px solid rgba(181,71,15,.35);font-family:"Plus Jakarta Sans",system-ui,sans-serif;}',
    '.iacf-pdp-head{font-size:.72rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#a3360f;}',
    '.iacf-pdp-price{font-size:1.25rem;font-weight:800;color:#8e1c13;margin-top:.2rem;}',
    '.iacf-pdp-price small{font-size:.8rem;font-weight:600;color:inherit;opacity:.85;margin-left:.35rem;}',
    '.iacf-pdp-note{font-size:.82rem;margin-top:.2rem;opacity:.9;}',
    '.iacf-pdp-clock{font-size:.8rem;margin-top:.35rem;font-weight:700;font-variant-numeric:tabular-nums;color:#a3360f;}',
    'html:not(.iac-light):not([data-theme="light"]) .iacf-pdp-head,html:not(.iac-light):not([data-theme="light"]) .iacf-pdp-clock{color:#ffb35a;}',
    'html:not(.iac-light):not([data-theme="light"]) .iacf-pdp-price{color:#ffd56b;}',

    '.iacf-cart{margin:0 0 .6rem;padding:.5rem .7rem;border-radius:10px;background:linear-gradient(120deg,rgba(142,28,19,.12),rgba(255,179,32,.16));font-size:.78rem;line-height:1.35;}',
    '@media (prefers-reduced-motion:reduce){.iacf-flame{animation:none;}}',
  ].join('\n');

  function addStyle() {
    if (document.getElementById('iacf-style')) return;
    var s = document.createElement('style');
    s.id = 'iacf-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ── Top bar ────────────────────────────────────────────────────────────────
  var BAR_KEY = 'iacf_bar_closed';
  function barClosed() { try { return sessionStorage.getItem(BAR_KEY) === '1'; } catch (e) { return false; } }

  function addBar(now) {
    if (barClosed() || document.querySelector('.iacf-bar')) return;
    var p = phase(now);
    var bar = document.createElement('div');
    bar.className = 'iacf-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Dussehra and Diwali Sale');
    bar.innerHTML =
      '<b class="iacf-phase">' + p.head + '</b><span class="iacf-sep">·</span>' +
      '<span>Flat <b>10% off</b> on orders above ₹399</span>' +
      '<span class="iacf-hide-sm"><span class="iacf-sep">·</span><span class="iacf-sub">Auto-applied at checkout</span></span>' +
      '<span class="iacf-sep">·</span><span class="iacf-hide-sm">Ends in</span>' +
      '<span class="iacf-clock" aria-live="off"><span data-iacf="d">--</span>d<span data-iacf="h">--</span>:<span data-iacf="m">--</span>:<span data-iacf="s">--</span></span>' +
      (isCheckout ? '' : '<a class="iacf-shop" href="/books/">Shop now</a>') +
      '<button type="button" class="iacf-x" aria-label="Hide the sale bar">×</button>';
    bar.querySelector('.iacf-x').addEventListener('click', function () {
      try { sessionStorage.setItem(BAR_KEY, '1'); } catch (e) { /* private mode */ }
      bar.remove();
    });
    document.body.insertBefore(bar, document.body.firstChild);
  }

  // ── Homepage hero ──────────────────────────────────────────────────────────
  function addHero(now) {
    if (!isHome || document.querySelector('.iacf-hero')) return;
    var anchor = document.getElementById('promoCarousel');
    if (!anchor || !anchor.parentNode) return;
    var p = phase(now);
    var hero = document.createElement('section');
    hero.className = 'iacf-hero';
    hero.setAttribute('aria-label', 'Dussehra and Diwali Sale');
    hero.innerHTML =
      '<div class="iacf-hero-in">' +
        '<div>' +
          '<div class="iacf-eyebrow">' + p.head + ' · ' + p.sub + '</div>' +
          '<h2 class="iacf-title">Dussehra &amp; Diwali <em>Sale</em></h2>' +
          '<p class="iacf-lead">Flat <b>10% off</b> on every order above <b>₹399</b> — applied automatically at checkout, on Pay Now and Cash on Delivery. Gift a book this festive season.</p>' +
          '<a class="iacf-cta" href="/books/">Shop the Festive Sale →</a>' +
        '</div>' +
        '<div class="iacf-timer">' +
          '<div class="iacf-timer-label">Sale ends in</div>' +
          '<div class="iacf-cd">' +
            '<div><b data-iacf="d">--</b><i>Days</i></div>' +
            '<div><b data-iacf="h">--</b><i>Hours</i></div>' +
            '<div><b data-iacf="m">--</b><i>Mins</i></div>' +
            '<div><b data-iacf="s">--</b><i>Secs</i></div>' +
          '</div>' +
          '<div class="iacf-diyas" aria-hidden="true"><span class="iacf-flame">🪔</span><span class="iacf-flame">🪔</span><span class="iacf-flame">🪔</span><span class="iacf-flame">🪔</span></div>' +
        '</div>' +
      '</div>';
    anchor.parentNode.insertBefore(hero, anchor);
  }

  // ── Product page ───────────────────────────────────────────────────────────
  function productPrice() {
    // The text is the live price (admin overrides rewrite it after load); the
    // attribute and the page's currentItem are what was baked.
    var el = document.querySelector('[data-sale-anchor] [data-product-price], .price-row [data-product-price], [data-product-price]');
    var fromText = el ? parseFloat(String(el.textContent || '').replace(/[^\d.]/g, '')) : 0;
    if (fromText > 0) return fromText;
    if (el && Number(el.getAttribute('data-product-price')) > 0) return Number(el.getAttribute('data-product-price'));
    /* global currentItem */
    if (typeof currentItem !== 'undefined' && currentItem && Number(currentItem.price) > 0) return Number(currentItem.price);
    return 0;
  }

  function addProductBox() {
    if (!isProduct || document.querySelector('.iacf-pdp')) return;
    var anchor = document.querySelector('[data-sale-anchor], .price-row, .product-price-row');
    if (!anchor || !anchor.parentNode) return;
    var box = document.createElement('div');
    box.className = 'iacf-pdp';
    box.innerHTML =
      '<div class="iacf-pdp-head">🪔 Dussehra &amp; Diwali Sale</div>' +
      '<div class="iacf-pdp-body"></div>' +
      '<div class="iacf-pdp-clock">Ends in <span data-iacf="d">--</span>d <span data-iacf="h">--</span>h <span data-iacf="m">--</span>m <span data-iacf="s">--</span>s</div>';
    anchor.parentNode.insertBefore(box, anchor.nextSibling);
    renderProductBox();
  }

  var lastPrice = -1;
  function renderProductBox() {
    var body = document.querySelector('.iacf-pdp .iacf-pdp-body');
    if (!body) return;
    var price = productPrice();
    if (price === lastPrice) return;
    lastPrice = price;
    if (price > SALE.threshold) {
      var off = Math.floor(price * SALE.percent / 100);
      body.innerHTML = '<div class="iacf-pdp-price">' + inr(price - off) + '<small>after 10% off (save ' + inr(off) + ')</small></div>' +
        '<div class="iacf-pdp-note">Applied automatically at checkout — no code needed.</div>';
    } else {
      var more = price > 0 ? (SALE.threshold + 1) - price : 0;
      body.innerHTML = '<div class="iacf-pdp-note"><b>Flat 10% off</b> your whole order above ₹399' +
        (more > 0 ? ' — add ' + inr(more) + ' more in books to unlock it.' : '.') +
        ' Applied automatically at checkout.</div>';
    }
  }

  // ── Cart drawer ────────────────────────────────────────────────────────────
  function addCartNote() {
    var footer = document.getElementById('cartFooter');
    if (!footer || footer.querySelector('.iacf-cart')) return;
    var note = document.createElement('div');
    note.className = 'iacf-cart';
    note.innerHTML = '🪔 <b>Festive Sale:</b> 10% off is applied automatically at checkout on orders above ₹399.';
    footer.insertBefore(note, footer.firstChild);
  }

  // ── Countdown ──────────────────────────────────────────────────────────────
  function removeAll() {
    var nodes = document.querySelectorAll('.iacf-bar, .iacf-hero, .iacf-pdp, .iacf-cart, #iacf-style');
    for (var i = 0; i < nodes.length; i++) nodes[i].remove();
  }

  var timer = null;
  function tick() {
    var now = Date.now();
    var left = SALE.end - now;
    if (left <= 0) { removeAll(); if (timer) clearInterval(timer); return; }
    var parts = {
      d: pad(Math.floor(left / 86400000)),
      h: pad(Math.floor((left % 86400000) / 3600000)),
      m: pad(Math.floor((left % 3600000) / 60000)),
      s: pad(Math.floor((left % 60000) / 1000)),
    };
    var cells = document.querySelectorAll('[data-iacf]');
    for (var i = 0; i < cells.length; i++) {
      var v = parts[cells[i].getAttribute('data-iacf')];
      if (v !== undefined && cells[i].textContent !== v) cells[i].textContent = v;
    }
    // The headline moves on at midnight IST without a reload.
    var head = document.querySelector('.iacf-bar .iacf-phase');
    if (head) { var p = phase(now).head; if (head.textContent !== p) head.textContent = p; }
    renderProductBox();
  }

  function init() {
    if (!live(Date.now())) return;
    addStyle();
    addBar(Date.now());
    addHero(Date.now());
    addProductBox();
    addCartNote();
    tick();
    timer = setInterval(tick, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
