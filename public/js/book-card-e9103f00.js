
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

  /* Lifetime units sold ("🔥 445 sold"), for books with 10+ sold: the same
     number the product page and Reader Bestsellers show. Loaded once per page
     from sold-counts; cards drawn before it arrives are filled in after. */
  var SOLD_KEY = 'iac_sold_counts';
  var soldCounts = null;
  try { soldCounts = JSON.parse(sessionStorage.getItem(SOLD_KEY) || 'null'); } catch (e) {}

  function soldLine(b) {
    var n = soldCounts && b && b.slug ? soldCounts[String(b.slug).toLowerCase()] : 0;
    return n ? '<div class="iac-sold" style="font-size:.72rem;font-weight:600;color:#c4621a;margin:.15rem 0 .1rem;">'
      + '🔥 ' + Number(n).toLocaleString('en-IN') + ' sold</div>' : '';
  }

  function fillSoldLines(root) {
    if (!soldCounts) return;
    var cards = (root || document).querySelectorAll('a.book-card[href^="/product/"]');
    for (var i = 0; i < cards.length; i++) {
      var a = cards[i];
      if (a.querySelector('.iac-sold') || a.getAttribute('data-no-sold')) continue;
      var m = (a.getAttribute('href') || '').match(/^\/product\/([^/?#]+)/);
      var slug = '';
      try { slug = m ? decodeURIComponent(m[1]) : ''; } catch (e) { slug = m ? m[1] : ''; }
      var html = soldLine({ slug: slug });
      var author = a.querySelector('.book-author');
      if (html && author) author.insertAdjacentHTML('afterend', html);
    }
  }
  window.iacFillSoldLines = fillSoldLines;

  if (window.fetch) {
    fetch('/.netlify/functions/sold-counts').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !d.counts) return;
      soldCounts = d.counts;
      try { sessionStorage.setItem(SOLD_KEY, JSON.stringify(soldCounts)); } catch (e) {}
      fillSoldLines();
    }).catch(function () {});
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

  /* @param opts  { badge: 'New arrival' } adds a labelled chip above the other
   *              badges; { className: 'home-merch-card' } adds a class to the
   *              card, for grids that size their own cards.
   *              Guarded because every grid calls this as .map(iacBookCard),
   *              and Array.map hands the index in as the second argument. */
  window.iacBookCard = function (b, opts) {
    if (!b) return '';
    opts = (opts && typeof opts === 'object') ? opts : {};
    var url = String(b.url || '');
    var sold = isSold(b);
    var off = discountPct(b);
    var qty = cartQtyMap()[url] || 0;

    var badges = '';
    if (opts.badge) badges += '<span class="iac-tag">' + esc(opts.badge) + '</span>';
    if (sold) badges += '<span class="iac-soon">Coming soon</span>';
    else if (off) badges += '<span class="iac-off">' + off + '% off</span>';
    // A caller's own label wins: the merchandising rows already say "New
    // arrival" over the card, and stacking our own "New" under it just
    // repeated the word twice in the same corner.
    if (b.n && !sold && !opts.badge) badges += '<span class="iac-new">New</span>';

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

    // A caller's own "N sold" badge (Reader Bestsellers) already says it.
    var noSold = /sold/i.test(String(opts.badge || ''));

    return '<a class="book-card' + (opts.className ? ' ' + esc(opts.className) : '') + '"'
      + ' href="/product/' + esc(b.slug) + '/"' + (noSold ? ' data-no-sold="1"' : '')
      + ' style="text-decoration:none;color:inherit;display:block;">'
      + '<div class="book-cover" style="position:relative;">'
      +   (badges ? '<span class="iac-badges">' + badges + '</span>' : '')
      +   '<img src="' + esc(b.img || '') + '" alt="' + esc(b.t) + '" loading="lazy" onerror="this.style.display=\'none\'"/>'
      +   wish + qadd
      + '</div>'
      + '<div class="book-name">' + esc(b.t) + '</div>'
      + '<div class="book-author">' + esc(b.a || '') + '</div>'
      + (noSold ? '' : soldLine(b))
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
