/*
 * Quantity selector on product pages (owner's request, 30 Oct 2026).
 *
 * Added to every product page by the Worker (withQtySelector), so the ~2,740
 * baked pages and the admin-created ones (product-page.js) get it without a
 * rebuild. The page's own buttons still do the work: each handler is wrapped,
 * and once it has put one copy in the cart (or in the Buy Now cart) the line
 * is set to the chosen quantity. Baked pages: addBookToCart / buyNowBook.
 * Admin-created pages: addProductToCart(buyNow).
 *
 * Desktop and tablet only: hidden at the product page's phone breakpoint.
 *
 * Checkout still decides what can be bought: a counted book with fewer copies
 * left is refused there with "Only N copies ... are left".
 */
(function () {
  'use strict';
  var MAX = 10;
  var CART = 'akshar_cart';
  var BUY_NOW = 'iac_buy_now_cart';
  var qty = 1;

  function item() {
    try { return typeof currentItem !== 'undefined' ? currentItem : null; } catch (e) { return null; }
  }
  function read(key) {
    try { var v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function write(key, list) {
    try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) {}
  }
  function lineQty(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return Number(list[i].qty) || 1;
    return 0;
  }

  // Run the page's handler, then turn the one copy it added into `qty`.
  function wrap(name, isBuyNow) {
    var original = window[name];
    if (typeof original !== 'function' || original.__qtyWrapped) return;
    var wrapped = function () {
      var it = item();
      var id = it && it.id;
      var buyNow = isBuyNow(arguments);
      var before = buyNow ? localStorage.getItem(BUY_NOW) : lineQty(read(CART), id);
      var result = original.apply(this, arguments);
      if (!id || qty <= 1) return result;
      if (buyNow) {
        var raw = localStorage.getItem(BUY_NOW);
        if (!raw || raw === before) return result;          // refused (sold out)
        var list = read(BUY_NOW);
        list.forEach(function (l) { if (l && l.id === id) l.qty = qty; });
        write(BUY_NOW, list);
      } else {
        var cart = read(CART);
        if (lineQty(cart, id) <= before) return result;      // refused (sold out)
        cart.forEach(function (l) { if (l && l.id === id) l.qty = before + qty; });
        write(CART, cart);
        if (window.refreshCart) window.refreshCart();
      }
      return result;
    };
    wrapped.__qtyWrapped = true;
    window[name] = wrapped;
  }

  function render(box) {
    box.querySelector('.pdp-qty-n').textContent = String(qty);
    box.querySelector('[data-step="-1"]').disabled = qty <= 1;
    box.querySelector('[data-step="1"]').disabled = qty >= MAX;
    var it = item();
    if (it) it.qty = qty;   // what a handler copies when it adds the line itself
  }

  function mount() {
    var actions = document.querySelector('.actions');
    if (!actions || actions.querySelector('.pdp-qty') || window.__soldOut || !item()) return;
    if (!actions.querySelector('button')) return;            // "Coming Soon" box, nothing to buy

    var style = document.createElement('style');
    style.textContent = ''
      + '.actions.has-qty{grid-template-columns:auto 1fr 1fr}'
      // --q-line / --q-ink / --q-font come from the Add to Cart button (syncLook),
      // so the stepper wears whatever outline the site theme gives that button.
      + '.pdp-qty{display:inline-flex;align-items:stretch;border:var(--q-width,1px) solid var(--q-line,#c9a84c);border-radius:999px;min-height:52px;overflow:hidden;background:transparent}'
      + '.actions .pdp-qty button{min-height:0;width:42px;padding:0;border:0;border-radius:0;background:transparent;color:var(--q-ink,#c9a84c);'
      + 'font:500 1.15rem/1 var(--q-font,system-ui,sans-serif);letter-spacing:0;box-shadow:none;cursor:pointer;transform:none;transition:background .15s ease,opacity .15s ease}'
      + '.actions .pdp-qty button:hover:not(:disabled){background:color-mix(in srgb,var(--q-ink,#c9a84c) 10%,transparent);transform:none;filter:none}'
      + '.actions .pdp-qty button:disabled{opacity:.3;cursor:default}'
      + '.actions .pdp-qty button:focus-visible{outline:2px solid var(--q-line,#c9a84c);outline-offset:-3px}'
      + '.pdp-qty-n{display:flex;align-items:center;justify-content:center;min-width:1.6rem;font:700 .95rem/1 var(--q-font,system-ui,sans-serif);color:var(--q-ink,#c9a84c);font-variant-numeric:tabular-nums}'
      // Not on phones (owner, 30 Oct 2026): the fixed bottom bar keeps just its
      // two buttons there, and a phone order is one copy unless changed in the cart.
      + '@media(max-width:760px){.actions.has-qty{grid-template-columns:1fr 1fr}.actions .pdp-qty{display:none}}';
    document.head.appendChild(style);

    var box = document.createElement('div');
    box.className = 'pdp-qty';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Quantity');
    box.innerHTML = '<button type="button" data-step="-1" aria-label="Decrease quantity">−</button>'
      + '<span class="pdp-qty-n" aria-live="polite">1</span>'
      + '<button type="button" data-step="1" aria-label="Increase quantity">+</button>';
    box.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-step]');
      if (!b || b.disabled) return;
      qty = Math.max(1, Math.min(MAX, qty + Number(b.getAttribute('data-step'))));
      render(box);
    });
    actions.insertBefore(box, actions.firstChild);
    actions.classList.add('has-qty');
    render(box);
    var syncLook = function () {
      var ref = actions.querySelector('button.secondary') || actions.querySelector('button:not([data-step])');
      if (!ref) return;
      var cs = getComputedStyle(ref);
      box.style.setProperty('--q-line', cs.borderTopColor);
      box.style.setProperty('--q-width', cs.borderTopWidth);
      box.style.setProperty('--q-ink', cs.color);
      box.style.setProperty('--q-font', cs.fontFamily);
    };
    syncLook();
    // The theme switch (light/dark) restyles the button; follow it.
    new MutationObserver(function () { setTimeout(syncLook, 50); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });

    wrap('addBookToCart', function () { return false; });
    wrap('buyNowBook', function () { return true; });
    wrap('addProductToCart', function (args) { return !!args[0]; });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
