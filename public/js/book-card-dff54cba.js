
/* One book card, for every grid on the site.
 *
 * There were four copies of this markup and they had drifted apart in ways
 * that mattered, not just cosmetically:
 *   - two of them dropped data-no-cod and data-pub-sourced, so a prepaid-only
 *     title added from those grids reached checkout with Cash on Delivery
 *     still offered;
 *   - two had no sold-out state at all;
 *   - /collection/ had no add button whatsoever, and its card was a <div>
 *     with an onclick instead of a link, so it could not be opened in a new
 *     tab and carried no href for a crawler to follow.
 * One renderer means the next change to a card lands everywhere at once.
 */
(function () {
  if (window.iacBookCard) return;              // one definition per page

  var CART_KEY = 'akshar_cart';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function num(v) {
    return parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, '')) || 0;
  }

  /* A discount badge is a price claim, so it is only drawn when the claim is
     credible. Several hundred titles carry a placeholder MRP -- a 1,199 list
     price against a 49 cover price -- which arithmetic turns into "96% OFF",
     a number nobody should publish and the kind of thing Merchant Center
     suspends an account over. Above the cap the struck-through MRP still
     shows exactly as it does today; only the badge is withheld. */
  var MAX_CREDIBLE_OFF = 70;
  var MIN_WORTH_SHOWING = 5;

  function discountPct(b) {
    var p = num(b.p), o = num(b.op);
    if (!(p > 0 && o > p)) return 0;
    var off = Math.round((1 - p / o) * 100);
    return (off < MIN_WORTH_SHOWING || off > MAX_CREDIBLE_OFF) ? 0 : off;
  }

  function isSold(b) {
    return !!b && b.stock !== null && b.stock !== undefined && Number(b.stock) <= 0;
  }

  function cartQtyMap() {
    var m = {};
    try {
      var c = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
      for (var i = 0; i < c.length; i++) {
        if (c[i] && c[i].id) m[String(c[i].id)] = Number(c[i].qty) || 0;
      }
    } catch (e) {}                              // private mode, cleared storage
    return m;
  }

  window.iacBookCard = function (b) {
    if (!b) return '';
    var url = String(b.url || '');
    var sold = isSold(b);
    var off = discountPct(b);
    var qty = cartQtyMap()[url] || 0;

    var badges = '';
    if (sold) badges += '<span class="iac-soon">Coming soon</span>';
    else if (off) badges += '<span class="iac-off">' + off + '% off</span>';
    if (b.n && !sold) badges += '<span class="iac-new">New</span>';

    /* The heart keeps the class and data-url the page's own
       updateWishlistBadge() already looks for, so that keeps working
       untouched. Rendered only where a wishlist actually exists. */
    var wish = '';
    if (typeof window.toggleWishlist === 'function') {
      var on = window.isWishlisted ? !!window.isWishlisted(url) : false;
      wish = '<button type="button" class="wish-btn' + (on ? ' wishlisted' : '') + '" data-wish="1"'
        + ' data-url="' + esc(url) + '"'
        + ' data-title="' + esc(b.t) + '"'
        + ' data-img="' + esc(b.img || '') + '"'
        + ' data-price="' + num(b.p) + '"'
        + ' aria-label="' + (on ? 'Remove from wishlist' : 'Save to wishlist') + '">'
        + (on ? '♥' : '♡') + '</button>';
    }

    var qadd;
    if (sold) {
      qadd = '<span class="iac-qadd off" aria-hidden="true">—</span>';
    } else {
      qadd = '<button type="button" class="iac-qadd' + (qty ? ' has' : '') + '" data-qadd="1"'
        + ' data-url="' + esc(url) + '"'
        + ' data-title="' + esc(b.t) + '"'
        + ' data-author="' + esc(b.a || '') + '"'
        + ' data-price="' + num(b.p) + '"'
        + ' data-img="' + esc(b.img || '') + '"'
        + ' data-sku="' + esc(b.sku || '') + '"'
        + ' data-stock="' + (b.stock == null ? '' : esc(b.stock)) + '"'
        + ' data-no-cod="' + (b.no_cod ? '1' : '') + '"'
        + ' data-pub-sourced="' + (b.publisher_sourced ? '1' : '') + '"'
        + ' aria-label="Add ' + esc(b.t) + ' to cart">'
        + (qty ? qty : '+') + '</button>';
    }

    return '<a class="book-card" href="/product/' + esc(b.slug) + '/" style="text-decoration:none;color:inherit;display:block;">'
      + '<div class="book-cover" style="position:relative;">'
      +   (badges ? '<span class="iac-badges">' + badges + '</span>' : '')
      +   '<img src="' + esc(b.img || '') + '" alt="' + esc(b.t) + '" loading="lazy" onerror="this.style.display=\'none\'"/>'
      +   wish + qadd
      + '</div>'
      + '<div class="book-name">' + esc(b.t) + '</div>'
      + '<div class="book-author">' + esc(b.a || '') + '</div>'
      + '<div class="iac-meta">'
      +   '<span class="book-price">' + esc(b.p) + (b.op ? '<span class="iac-orig">' + esc(b.op) + '</span>' : '') + '</span>'
      +   (b.cat ? '<span class="iac-cat">' + esc(b.cat) + '</span>' : '')
      + '</div>'
      + '</a>';
  };

  /* The buttons are rendered from localStorage at paint time, so anything that
     changes the cart afterwards -- the drawer, another tab, a back-navigation
     out of the bfcache -- has to bring them back in step. */
  function syncQuickAdds(root) {
    var m = cartQtyMap();
    var list = (root || document).querySelectorAll('.iac-qadd[data-qadd]');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var q = m[el.getAttribute('data-url') || ''] || 0;
      el.textContent = q ? String(q) : '+';
      if (q) el.classList.add('has'); else el.classList.remove('has');
    }
  }
  window.iacSyncQuickAdds = syncQuickAdds;

  /* The page loader shows its overlay on any click inside a link, from a
     CAPTURE listener on document. A quick-add button sits inside the card's
     <a>, so cancelling the navigation in the bubble phase would leave the
     overlay up for its full 8-second failsafe. Cancel in capture, and clear
     the overlay anyway in case something else raised it first. */
  function stopLoader() {
    var l = document.getElementById('iacPageLoader');
    if (l) l.classList.remove('show');
  }

  function quickAdd(btn) {
    var d = btn.dataset || {};
    if (d.stock !== '' && d.stock != null && Number(d.stock) <= 0) {
      if (window.showToast) window.showToast('Out of stock — coming soon');
      return;
    }
    if (typeof window.addToCart !== 'function') {   // no cart on this page
      window.location.href = d.url || '/';
      return;
    }
    var item = {
      id: d.url, url: d.url, title: d.title, author: d.author || '',
      price: num(d.price), img: d.img, sku: d.sku || '',
    };
    // _no_cod is what checkout reads to switch Cash on Delivery off. Losing it
    // is how a prepaid-only title gets ordered COD, so it travels with the
    // item from every grid, not just the homepage's main one.
    if (d.noCod) item._no_cod = true;
    if (d.pubSourced) item._publisher_sourced = true;
    window.addToCart(item, { keepBrowsing: true });
    btn.classList.add('pop');
    setTimeout(function () { btn.classList.remove('pop'); }, 420);
    syncQuickAdds();
  }

  function toggleWish(btn) {
    if (typeof window.toggleWishlist !== 'function') return;
    var d = btn.dataset || {};
    window.toggleWishlist({ url: d.url, title: d.title, img: d.img, price: num(d.price) });
    if (window.updateWishlistBadge) window.updateWishlistBadge();
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var qa = t.closest('[data-qadd]');
    if (qa) { ev.preventDefault(); ev.stopPropagation(); stopLoader(); quickAdd(qa); return; }
    var w = t.closest('[data-wish]');
    if (w) { ev.preventDefault(); ev.stopPropagation(); stopLoader(); toggleWish(w); }
  }, true);

  window.addEventListener('storage', function (e) { if (e.key === CART_KEY) syncQuickAdds(); });
  window.addEventListener('pageshow', function () { syncQuickAdds(); });
})();
