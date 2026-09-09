(function(){
  var nav = document.querySelector('nav.mob-nav');
  var path = (location.pathname.replace(/\/+$/, '') || '/');
  var here = path === '/' ? 'home' : (path === '/cart' ? 'cart' : '');

  if (nav) {
    if (here) {
      var tab = nav.querySelector('[data-mn="' + here + '"]');
      if (tab) { tab.classList.add('mn-active'); tab.setAttribute('aria-current', 'page'); }
    }

    // Progressive enhancement, in that order: the href is the behaviour, and
    // where this page already carries the overlay that tab would open, the
    // click opens it in place instead. So the bar behaves exactly like the
    // homepage's where it can, still goes somewhere real where it cannot, and
    // survives a JS failure either way.
    // The page loader listens for link clicks on document in the CAPTURE phase,
    // so it has already shown its overlay by the time this bubble-phase handler
    // cancels the navigation -- and with no navigation to arrive, "Fetching your
    // next read..." then sat over the drawer for the full 8s failsafe. Cancelling
    // the navigation means cancelling the loader that was announcing it.
    var stopLoader = function(){
      var l = document.getElementById('iacPageLoader');
      if (l) l.classList.remove('show');
    };
    var upgrade = function(name, ready, open){
      if (name === here) return;              // already here; let it be a no-op reload
      var a = nav.querySelector('[data-mn="' + name + '"]');
      if (!a) return;
      a.addEventListener('click', function(e){
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
        if (!ready()) return;                 // no overlay here — follow the href
        e.preventDefault();
        stopLoader();
        open();
      });
    };
    upgrade('cart', function(){ return typeof window.openCart === 'function'; },
                    function(){ window.openCart(); });
    upgrade('orders', function(){ return !!(window.IAC && typeof IAC.openMyOrders === 'function'); },
                      function(){ IAC.openMyOrders(); });
    upgrade('account', function(){ return !!(window.IAC && typeof IAC.openAuthModal === 'function'); },
                       function(){ IAC.getUser() ? IAC.openAccountModal() : IAC.openAuthModal(); });

    // cart.js owns this badge, but it is not on every page carrying the bar:
    // /books/ has its own inline mini-cart and the policy pages have no cart
    // code at all. Reading a count is not cart logic — nothing here writes.
    if (typeof window.updateCartUI !== 'function') {
      var badge = document.getElementById('cartBadgeMobile');
      if (badge) {
        var n = 0;
        try {
          (JSON.parse(localStorage.getItem('akshar_cart') || '[]') || []).forEach(function(i){
            n += Number(i && i.qty) || 0;
          });
        } catch (e) { n = 0; }
        if (n > 0) { badge.textContent = n > 99 ? '99+' : String(n); badge.style.display = 'flex'; }
      }
    }
  }

  // Account and Orders exist only as modals, and only on the homepage. Tabs on
  // every other page link here with the intent in the query string; this
  // honours it on arrival. auth.js defines IAC asynchronously, hence the poll.
  var q = new URLSearchParams(location.search);
  var intent = q.get('account') === '1' ? 'account' : (q.get('orders') === '1' ? 'orders' : '');
  if (intent && path === '/') {
    var tries = 0;
    var timer = setInterval(function(){
      if (window.IAC && typeof IAC.openMyOrders === 'function') {
        clearInterval(timer);
        if (intent === 'orders') { IAC.openMyOrders(); }
        else { IAC.getUser() ? IAC.openAccountModal() : IAC.openAuthModal(); }
        // Drop the intent from the URL: without this a refresh, a back button
        // or a shared link reopens the modal every time.
        try { history.replaceState(null, '', location.pathname); } catch (e) {}
      } else if (++tries > 40) {
        clearInterval(timer);   // 8s — auth.js is not coming
      }
    }, 200);
  }
})();