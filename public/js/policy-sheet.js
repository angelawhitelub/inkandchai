/**
 * Returns & refunds bottom sheet.
 *
 * A peek at the policy without leaving the page — the question "what happens if
 * this book turns up damaged, and how do I get my money back if I paid cash?"
 * is asked at exactly two moments: looking at a book, and paying for it. Sending
 * someone to a full policy page at either point loses the sale or the cart.
 *
 * Shared rather than templated into each page because the same summary now has
 * to appear from generate_site.py (static product pages), product-page.js
 * (admin-created listings) and the checkout, and three copies of a policy is
 * three chances for one of them to say something we no longer do.
 *
 * Usage: give any element `data-policy-sheet` (optionally `="refunds"` or
 * `="cancel"` to open scrolled to that section) and include this file. Styles
 * and markup are injected on first open, so a page that never opens it pays
 * nothing beyond this script.
 *
 * Content must stay in step with /return-policy/ and /refund-policy/. The
 * figures are the ones the code enforces: a 7-day window from delivered_at
 * (request-return.js), a 30-minute cancellation window for prepaid and partial
 * COD (cancel-order.js), and Rs 50 of store credit valid 6 months
 * (utils/return-refund.js).
 */
(function () {
  'use strict';

  var built = false, cssIn = false;
  var sheet, backdrop, panel, lastFocus;

  var CSS = [
    '.pol-backdrop{position:fixed;inset:0;background:rgba(0,0,0,0.55);opacity:0;',
      'transition:opacity .25s ease;z-index:2147483000;}',
    '.pol-backdrop.on{opacity:1}',
    '.pol-sheet{position:fixed;left:0;right:0;bottom:0;z-index:2147483001;',
      'background:var(--bg2,#1c1916);color:var(--cream,#f0e8d8);',
      'border-top:1px solid var(--border,rgba(201,168,76,0.22));',
      'border-radius:18px 18px 0 0;box-shadow:0 -18px 50px rgba(0,0,0,0.5);',
      'max-height:82vh;display:flex;flex-direction:column;',
      'transform:translateY(100%);transition:transform .3s cubic-bezier(.22,.8,.3,1);}',
    '.pol-sheet.on{transform:translateY(0)}',
    '@media (min-width:760px){.pol-sheet{left:50%;right:auto;transform:translate(-50%,100%);',
      'width:min(620px,94vw);border-radius:18px 18px 0 0}',
      '.pol-sheet.on{transform:translate(-50%,0)}}',
    '@media (prefers-reduced-motion:reduce){.pol-sheet,.pol-backdrop{transition:none}}',
    '.pol-grip{width:42px;height:4px;border-radius:999px;background:var(--border,rgba(201,168,76,0.35));',
      'margin:0.6rem auto 0.2rem;flex:none}',
    '.pol-head{display:flex;align-items:center;gap:0.75rem;padding:0.5rem 1.15rem 0.7rem;flex:none;',
      'border-bottom:1px solid var(--border,rgba(201,168,76,0.18))}',
    '.pol-head h2{margin:0;flex:1;font-size:0.95rem;font-weight:600;letter-spacing:0.01em;',
      'color:var(--gold,#c9a84c);font-family:inherit}',
    '.pol-x{background:none;border:1px solid var(--border,rgba(201,168,76,0.3));color:inherit;',
      'width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:0.95rem;line-height:1;flex:none}',
    '.pol-x:hover{background:rgba(201,168,76,0.12)}',
    '.pol-body{overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0.2rem 1.15rem 1.4rem;',
      'font-size:0.79rem;line-height:1.75;color:var(--cream-dim,#a09080)}',
    '.pol-body h3{margin:1.15rem 0 0.4rem;font-size:0.63rem;letter-spacing:0.16em;text-transform:uppercase;',
      'color:var(--gold,#c9a84c);font-weight:600;font-family:inherit}',
    '.pol-body h3:first-child{margin-top:0.9rem}',
    '.pol-body p{margin:0.35rem 0}',
    '.pol-body strong{color:var(--cream,#f0e8d8)}',
    '.pol-row{display:flex;gap:0.6rem;padding:0.5rem 0;border-bottom:1px dashed var(--border,rgba(201,168,76,0.16))}',
    '.pol-row:last-child{border-bottom:none}',
    '.pol-row b{flex:0 0 38%;color:var(--cream,#f0e8d8);font-weight:600}',
    '.pol-note{margin-top:0.7rem;padding:0.7rem 0.85rem;border-left:3px solid #6dbf6d;',
      'background:rgba(109,191,109,0.07);color:var(--cream,#f0e8d8);border-radius:0 6px 6px 0}',
    '.pol-links{display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:1.1rem}',
    '.pol-links a{flex:1;min-width:150px;text-align:center;padding:0.6rem 0.7rem;text-decoration:none;',
      'border:1px solid var(--border,rgba(201,168,76,0.3));border-radius:8px;',
      'color:var(--gold,#c9a84c);font-size:0.66rem;letter-spacing:0.1em;text-transform:uppercase}',
    '.pol-links a:hover{background:rgba(201,168,76,0.1)}',
    'html[data-theme="light"] .pol-sheet{background:#fffaf0;color:#2a2018}',
    'html[data-theme="light"] .pol-body{color:#5a4a38}',
    'html[data-theme="light"] .pol-body strong,html[data-theme="light"] .pol-row b{color:#2a2018}',
    '.pol-trigger{display:inline-flex;align-items:center;gap:0.4rem;cursor:pointer;',
      'background:none;border:1px solid var(--border,rgba(201,168,76,0.3));border-radius:999px;',
      'padding:0.42rem 0.85rem;color:var(--gold,#c9a84c);font:inherit;font-size:0.63rem;',
      'letter-spacing:0.1em;text-transform:uppercase;transition:background .2s}',
    '.pol-trigger:hover{background:rgba(201,168,76,0.12)}',
  ].join('');

  var HTML =
    '<div class="pol-grip"></div>' +
    '<div class="pol-head">' +
      '<h2 id="polSheetTitle">Returns &amp; refunds</h2>' +
      '<button class="pol-x" type="button" aria-label="Close">&#10005;</button>' +
    '</div>' +
    '<div class="pol-body">' +

      '<h3 id="pol-returns">Returning a book</h3>' +
      '<p><strong>7 days</strong> from the day your order is delivered. Open <strong>My Orders</strong>, ' +
      'pick the order and tap <strong>Request Return</strong> — our courier collects it free, usually within 48 hours.</p>' +
      '<p>Returnable: wrong book, damaged or torn pages, missing pages, ' +
      'or a book that is not what the page described.</p>' +

      '<h3 id="pol-refunds">How your refund reaches you</h3>' +
      '<div class="pol-row"><b>Paid online</b><span>Straight back to the same card or account, automatically. 2–4 business days.</span></div>' +
      '<div class="pol-row"><b>Cash on Delivery</b><span>Nothing was paid online, so we transfer it to a UPI ID or bank account you give us.</span></div>' +
      '<div class="pol-row"><b>Partial COD</b><span>Only the deposit was taken online. We send the <strong>whole amount — deposit and cash together — as one transfer</strong>, never split in two.</span></div>' +
      '<div class="pol-row"><b>Store credit</b><span>Instant, with a <strong>₹50 bonus</strong> on top, valid 6 months. No bank details needed.</span></div>' +

      '<div class="pol-note">Paid cash? We ask for a <strong>UPI ID</strong>, or your <strong>account number with IFSC ' +
      'and the account-holder name</strong>, at the moment you raise the return. Either one is enough. ' +
      'We ask up front because without it there is nowhere to send your money.</div>' +

      '<h3 id="pol-cancel">Cancelling an order</h3>' +
      '<div class="pol-row"><b>Cash on Delivery</b><span>Any time before dispatch. Nothing was paid, so nothing to refund.</span></div>' +
      '<div class="pol-row"><b>Paid online</b><span>Within <strong>30 minutes</strong> of placing — full refund to the original method.</span></div>' +
      '<div class="pol-row"><b>Partial COD</b><span>Within <strong>30 minutes</strong> and before dispatch. The online deposit comes back to the same account.</span></div>' +
      '<p>After dispatch an order cannot be cancelled — refuse it at the door, or return it once delivered.</p>' +

      '<div class="pol-links">' +
        '<a href="/return-policy/">Full return policy</a>' +
        '<a href="/refund-policy/">Refunds &amp; cancellations</a>' +
      '</div>' +
    '</div>';

  /**
   * Styles go in at load, not on first open: .pol-trigger is styled by this
   * same sheet, so deferring it would leave the button unstyled until someone
   * clicked it. The markup below stays lazy -- that is the part with a cost.
   */
  function injectCss() {
    if (cssIn) return;
    cssIn = true;
    var style = document.createElement('style');
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function build() {
    if (built) return;
    built = true;
    injectCss();

    backdrop = document.createElement('div');
    backdrop.className = 'pol-backdrop';
    backdrop.hidden = true;

    sheet = document.createElement('div');
    sheet.className = 'pol-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'polSheetTitle');
    sheet.hidden = true;
    sheet.innerHTML = HTML;

    document.body.appendChild(backdrop);
    document.body.appendChild(sheet);
    panel = sheet.querySelector('.pol-body');

    backdrop.addEventListener('click', close);
    sheet.querySelector('.pol-x').addEventListener('click', close);
    attachDrag();
  }

  /** Drag the sheet down to dismiss, the way a native sheet behaves. */
  function attachDrag() {
    var startY = 0, dy = 0, dragging = false;
    function begin(e) {
      // Only from the grip/header, or the body when it is already scrolled to
      // the top -- otherwise a downward swipe should scroll the text.
      var fromHandle = e.target.closest('.pol-grip, .pol-head');
      if (!fromHandle && panel.scrollTop > 0) return;
      dragging = true; startY = e.touches[0].clientY; dy = 0;
      sheet.style.transition = 'none';
    }
    function move(e) {
      if (!dragging) return;
      dy = Math.max(0, e.touches[0].clientY - startY);
      if (dy > 0) sheet.style.transform = 'translateY(' + dy + 'px)';
    }
    function end() {
      if (!dragging) return;
      dragging = false;
      sheet.style.transition = '';
      sheet.style.transform = '';
      if (dy > 110) close();
    }
    sheet.addEventListener('touchstart', begin, { passive: true });
    sheet.addEventListener('touchmove', move, { passive: true });
    sheet.addEventListener('touchend', end);
    sheet.addEventListener('touchcancel', end);
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function open(section) {
    build();
    lastFocus = document.activeElement;
    backdrop.hidden = false;
    sheet.hidden = false;
    panel.scrollTop = 0;
    // Reflow so the transition runs from the off-screen position.
    void sheet.offsetHeight;
    backdrop.classList.add('on');
    sheet.classList.add('on');
    document.documentElement.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);

    if (section) {
      var target = panel.querySelector('#pol-' + section);
      if (target) panel.scrollTop = target.offsetTop - panel.offsetTop - 8;
    }
    var x = sheet.querySelector('.pol-x');
    if (x) x.focus();
  }

  function close() {
    if (!built || sheet.hidden) return;
    backdrop.classList.remove('on');
    sheet.classList.remove('on');
    document.documentElement.style.overflow = '';
    document.removeEventListener('keydown', onKey);
    var done = function () { backdrop.hidden = true; sheet.hidden = true; };
    // Match the CSS duration; also fire on transitionend for a slow device.
    setTimeout(done, 320);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  // Delegated so triggers rendered after load (a cart drawer, a lazy section)
  // work without re-binding.
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-policy-sheet]');
    if (!t) return;
    e.preventDefault();
    open(t.getAttribute('data-policy-sheet') || '');
  });

  injectCss();

  window.IacPolicySheet = { open: open, close: close };
})();
