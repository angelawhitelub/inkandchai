/**
 * Customer feedback: five stars and an optional comment, in two places.
 *
 *   Ordering -- on the order confirmation screen, checkout calls
 *               IACFeedback.order(orderId, slot) and the card renders inline.
 *   Website  -- a small card that asks a browsing visitor once, after a few
 *               pages and some time on the page, plus a "Rate your experience"
 *               link added to the footer so anyone can give it unprompted.
 *
 * The website card is deliberately hard to trigger: never on checkout, cart or
 * payment pages, never over an open chat or cart, never twice once answered,
 * and not again for 30 days once dismissed. A shop that nags loses the sale it
 * was asking about.
 *
 * Stars are saved the moment they are tapped, so a rating counts even if the
 * comment is skipped; the comment then updates the same row. Nothing here is
 * ever allowed to show the customer an error. Posts to
 * /.netlify/functions/site-feedback.
 */
(function () {
  'use strict';

  var API = '/.netlify/functions/site-feedback';
  var VKEY = 'iac_fb_vid';        // random id, so re-rating updates one row
  var WKEY = 'iac_fb_web';        // { done } or { dismissed: ms }
  var PVKEY = 'iac_fb_pv';        // page views in this browser
  var NO_PROMPT = /^\/(checkout|cart|refund-upi|admin|ebooks\/read|offline|review)(\/|$)/;
  var MIN_PAGES = 3;
  var DELAY_MS = 25000;
  var SNOOZE_MS = 30 * 86400000;

  function ls(k, v) {
    try {
      if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null');
      localStorage.setItem(k, JSON.stringify(v));
    } catch (e) { return null; }
    return null;
  }

  function visitorId() {
    var v = ls(VKEY);
    if (!v) { v = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); ls(VKEY, v); }
    return v;
  }

  function device() { return window.matchMedia('(max-width:760px)').matches ? 'mobile' : 'desktop'; }

  function post(payload) {
    try {
      payload.visitor_id = visitorId();
      payload.page_url = location.pathname;
      payload.device = device();
      fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify(payload),
      }).catch(function () { /* fine */ });
    } catch (e) { /* fine */ }
  }

  var CSS = [
    '.iac-fb{font-family:var(--t-sans,inherit);color:var(--t-ink,#1d1813);background:var(--t-surface,#fff);',
      'border:1px solid var(--t-line-2,rgba(29,24,19,.16));border-radius:18px;padding:16px 18px;',
      'box-shadow:var(--t-shadow-lg,0 18px 40px rgba(60,40,15,.16));text-align:left}',
    '.iac-fb[hidden]{display:none!important}',
    '.iac-fb-float{position:fixed;left:22px;bottom:96px;z-index:9000;width:340px;max-width:calc(100vw - 24px);',
      'animation:iacFbIn .32s cubic-bezier(.22,.8,.3,1)}',
    '@media(max-width:760px){.iac-fb-float{left:12px;right:12px;width:auto}}',
    '@keyframes iacFbIn{from{transform:translateY(14px);opacity:0}to{transform:none;opacity:1}}',
    '@media(prefers-reduced-motion:reduce){.iac-fb-float{animation:none}}',
    '.iac-fb-inline{margin:1.6rem auto;max-width:420px}',
    '.iac-fb-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}',
    '.iac-fb-q{font-size:15px;font-weight:700;line-height:1.35;margin:0}',
    '.iac-fb-sub{font-size:12.5px;color:var(--t-muted,#766a5d);margin:3px 0 0;line-height:1.45}',
    '.iac-fb-x{flex:none;width:30px;height:30px;border-radius:999px;border:1px solid var(--t-line-2,rgba(29,24,19,.16));',
      'background:transparent;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:0}',
    '.iac-fb-stars{display:flex;gap:4px;margin-top:10px}',
    '.iac-fb-inline .iac-fb-stars{justify-content:center}',
    '.iac-fb-star{background:none;border:none;padding:2px;cursor:pointer;font-size:30px;line-height:1;',
      'color:rgba(118,106,93,.4);transition:color .12s,transform .12s;font-family:system-ui,sans-serif}',
    '.iac-fb-star.on{color:#e3a72f}',
    '.iac-fb-star:hover{transform:scale(1.12)}',
    '.iac-fb-star:focus-visible{outline:2px solid #e3a72f;outline-offset:2px;border-radius:6px}',
    '.iac-fb-scale{display:flex;justify-content:space-between;font-size:11.5px;color:var(--t-muted,#766a5d);margin-top:2px;max-width:190px}',
    '.iac-fb-inline .iac-fb-scale{margin:2px auto 0}',
    '.iac-fb textarea{display:block;width:100%;box-sizing:border-box;margin-top:12px;min-height:74px;resize:vertical;',
      'font:inherit;font-size:14px;color:inherit;background:var(--t-paper,#faf6ef);',
      'border:1px solid var(--t-line-2,rgba(29,24,19,.16));border-radius:12px;padding:10px 12px}',
    '.iac-fb textarea:focus{outline:2px solid var(--t-brand,#8f5f12);outline-offset:1px}',
    '.iac-fb-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}',
    '.iac-fb-actions button{font:inherit;font-size:13.5px;font-weight:700;border-radius:999px;padding:9px 16px;cursor:pointer}',
    '.iac-fb-skip{background:transparent;border:1px solid var(--t-line-2,rgba(29,24,19,.16));color:inherit}',
    '.iac-fb-send{background:var(--t-btn,#231a12);color:var(--t-btn-ink,#fbf6ee);border:1px solid var(--t-btn,#231a12)}',
    '.iac-fb-thanks{font-size:14.5px;font-weight:700;text-align:center;padding:6px 0}',
    '.iac-fb-link{display:inline-block;margin-top:8px;font-weight:600;cursor:pointer;text-decoration:underline;',
      'text-underline-offset:3px;color:inherit;background:none;border:0;font:inherit;padding:0}',
  ].join('');

  var styled = false;
  function style() {
    if (styled) return;
    styled = true;
    var s = document.createElement('style');
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /**
   * One card, either kind. `opts`: { kind, orderId, floating, title, sub,
   * onDone, onDismiss }.
   */
  function card(opts) {
    style();
    var el = document.createElement('div');
    el.className = 'iac-fb ' + (opts.floating ? 'iac-fb-float' : 'iac-fb-inline');
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', opts.title);
    el.innerHTML =
      '<div class="iac-fb-top"><div>'
      +   '<p class="iac-fb-q"></p><p class="iac-fb-sub"></p>'
      + '</div>' + (opts.floating ? '<button type="button" class="iac-fb-x" aria-label="Close">✕</button>' : '') + '</div>'
      + '<div class="iac-fb-stars" role="radiogroup" aria-label="Rate from 1 to 5 stars">'
      +   [1, 2, 3, 4, 5].map(function (i) {
            return '<button type="button" class="iac-fb-star" role="radio" aria-checked="false" data-v="' + i
              + '" aria-label="' + i + ' star' + (i > 1 ? 's' : '') + '">☆</button>';
          }).join('')
      + '</div>'
      + '<div class="iac-fb-scale"><span>Poor</span><span>Excellent</span></div>'
      + '<div class="iac-fb-more"></div>';
    el.querySelector('.iac-fb-q').textContent = opts.title;
    el.querySelector('.iac-fb-sub').textContent = opts.sub || '';

    var chosen = 0;
    var stars = el.querySelectorAll('.iac-fb-star');
    function paint(n) {
      stars.forEach(function (b, i) { b.classList.toggle('on', i < n); b.textContent = i < n ? '★' : '☆'; });
    }
    function payload(extra) {
      var p = { kind: opts.kind, rating: chosen };
      if (opts.orderId) p.order_id = opts.orderId;
      for (var k in extra) p[k] = extra[k];
      return p;
    }
    function thanks() {
      el.innerHTML = '<div class="iac-fb-thanks">Thank you ✨ We read every one of these.</div>';
      if (opts.onDone) opts.onDone();
      if (opts.floating) setTimeout(function () { el.remove(); }, 2600);
    }

    stars.forEach(function (b) {
      var v = Number(b.dataset.v);
      b.addEventListener('mouseenter', function () { paint(v); });
      b.addEventListener('click', function () {
        chosen = v;
        stars.forEach(function (x) { x.setAttribute('aria-checked', String(Number(x.dataset.v) === v)); });
        paint(v);
        post(payload({}));                         // the stars count even if the comment is skipped
        var more = el.querySelector('.iac-fb-more');
        var low = v <= 3;
        var hint = opts.kind === 'order'
          ? (low ? 'What went wrong while ordering? (optional)' : 'Anything that could have been easier? (optional)')
          : (low ? 'What should we fix? (optional)' : 'What do you like, or what could be better? (optional)');
        more.innerHTML = '<textarea maxlength="1000" aria-label="Your feedback"></textarea>'
          + '<div class="iac-fb-actions"><button type="button" class="iac-fb-skip">Skip</button>'
          + '<button type="button" class="iac-fb-send">Send feedback</button></div>';
        var ta = more.querySelector('textarea');
        ta.placeholder = hint;
        more.querySelector('.iac-fb-skip').onclick = thanks;
        more.querySelector('.iac-fb-send').onclick = function () {
          var c = ta.value.trim();
          if (c) post(payload({ comment: c }));
          thanks();
        };
        if (device() === 'desktop') ta.focus();
      });
    });
    el.querySelector('.iac-fb-stars').addEventListener('mouseleave', function () { paint(chosen); });
    var x = el.querySelector('.iac-fb-x');
    if (x) x.addEventListener('click', function () { el.remove(); if (opts.onDismiss) opts.onDismiss(); });
    return el;
  }

  // ── Ordering ─────────────────────────────────────────────────────────────
  function order(orderId, slot) {
    if (!orderId || !slot) return;
    var key = 'iac_fb_order_' + orderId;
    if (ls(key)) return;                          // already rated this order
    slot.innerHTML = '';
    slot.appendChild(card({
      kind: 'order',
      orderId: String(orderId),
      title: 'How was ordering from Ink & Chai?',
      sub: 'Tap a star. It takes two seconds and helps us fix what slowed you down.',
      onDone: function () { ls(key, 1); },
    }));
  }

  // ── Website ──────────────────────────────────────────────────────────────
  var floating = null;

  /** Keep the card above the WhatsApp button, the mobile tab bar and the sticky buy bar. */
  function lift(el) {
    var r = el.getBoundingClientRect();
    var bottom = device() === 'mobile' ? 12 : 22;
    document.querySelectorAll('.wa-float, .mob-nav, .actions').forEach(function (o) {
      var b = o.getBoundingClientRect();
      if (!b.width || !b.height || getComputedStyle(o).position !== 'fixed') return;
      if (b.bottom < window.innerHeight - 200) return;
      if (b.right < r.left - 8 || b.left > r.right + 8) return;
      bottom = Math.max(bottom, window.innerHeight - b.top + 12);
    });
    el.style.bottom = Math.round(bottom) + 'px';
  }

  function openWebsite(fromLink) {
    if (floating && document.body.contains(floating)) return;
    floating = card({
      kind: 'website',
      floating: true,
      title: 'How’s your experience with our website?',
      sub: 'Finding books, browsing, checkout — tell us how it felt.',
      onDone: function () { ls(WKEY, { done: Date.now() }); },
      onDismiss: function () { if (!fromLink) ls(WKEY, { dismissed: Date.now() }); },
    });
    document.body.appendChild(floating);
    lift(floating);
  }

  function busyElsewhere() {
    return !!document.querySelector('.ink-panel.on, .cart-sidebar.open, .srch-overlay.open, .modal.open, [role="dialog"][aria-modal="true"]:not([hidden])');
  }

  function maybePrompt() {
    if (NO_PROMPT.test(location.pathname)) return;
    var st = ls(WKEY);
    if (st && st.done) return;
    if (st && st.dismissed && Date.now() - st.dismissed < SNOOZE_MS) return;
    var pv = (Number(ls(PVKEY)) || 0) + 1;
    ls(PVKEY, pv);
    if (pv < MIN_PAGES) return;
    setTimeout(function tryShow() {
      if (document.hidden || busyElsewhere()) { setTimeout(tryShow, 8000); return; }
      openWebsite(false);
    }, DELAY_MS);
  }

  function footerLink() {
    var foots = document.querySelectorAll('footer');
    var f = foots[foots.length - 1];
    if (!f || f.querySelector('.iac-fb-link')) return;
    var wrap = document.createElement('div');
    var a = document.createElement('button');
    a.type = 'button';
    a.className = 'iac-fb-link';
    a.textContent = '★ Rate your experience';
    a.addEventListener('click', function () { style(); openWebsite(true); });
    wrap.appendChild(a);
    f.appendChild(wrap);
  }

  function init() {
    if (/^\/admin(\/|$)/.test(location.pathname)) return;
    footerLink();
    maybePrompt();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.IACFeedback = { order: order, open: function () { style(); openWebsite(true); } };
})();
