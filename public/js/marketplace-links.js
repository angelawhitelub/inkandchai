/* Ink & Chai "You can also buy from our Amazon / Flipkart store".
 * Loaded on product pages by cart.js. Asks get-marketplace-links whether this
 * book has store links (set from the admin product editor); if it does, puts a
 * button for each one under Add to Cart / Buy Now. Books without links are
 * untouched. */
(function () {
  'use strict';

  var STORES = [
    { key: 'amazon_url', label: 'Amazon' },
    { key: 'flipkart_url', label: 'Flipkart' },
  ];
  var links = null;

  function productSlug() {
    var parts = location.pathname.split('/').filter(Boolean);
    return parts[0] === 'product' && parts[1] ? decodeURIComponent(parts[1]).toLowerCase() : '';
  }

  function addStyles() {
    if (document.getElementById('iac-mkt-css')) return;
    var s = document.createElement('style');
    s.id = 'iac-mkt-css';
    s.textContent = ''
      + '.iac-mkt{margin:.2rem 0 1.2rem;text-align:center}'
      + '.iac-mkt-label{font:600 .6rem Inter,Montserrat,sans-serif;letter-spacing:.18em;text-transform:uppercase;color:var(--muted,#a09080);margin-bottom:.6rem}'
      + '.iac-mkt-row{display:flex;gap:.6rem;justify-content:center;flex-wrap:wrap}'
      + '.iac-mkt-btn{flex:1 1 140px;max-width:240px;display:inline-flex;align-items:center;justify-content:center;gap:.45rem;font:700 .64rem Montserrat,Inter,sans-serif;letter-spacing:.16em;text-transform:uppercase;padding:.85rem 1rem;border:1px solid rgba(201,168,76,.45);border-radius:999px;background:rgba(201,168,76,.06);color:var(--gold-light,var(--gold,#c9a84c));text-decoration:none;transition:background .2s,color .2s,transform .2s}'
      + '.iac-mkt-btn:hover,.iac-mkt-btn:focus-visible{background:var(--gold,#c9a84c);color:var(--bg,#0d0b08);outline:none;transform:translateY(-1px)}'
      + '.iac-mkt-btn span[aria-hidden]{font-size:.8rem;letter-spacing:0}';
    document.head.appendChild(s);
  }

  function place() {
    if (document.querySelector('.iac-mkt')) return;
    var present = STORES.filter(function (s) { return links[s.key]; });
    if (!present.length) return;

    var box = document.createElement('div');
    box.className = 'iac-mkt';
    var label = document.createElement('div');
    label.className = 'iac-mkt-label';
    label.textContent = 'You can also buy from our ' + present.map(function (s) { return s.label; }).join(' & ') + ' store';
    box.appendChild(label);
    var row = document.createElement('div');
    row.className = 'iac-mkt-row';
    present.forEach(function (s) {
      var a = document.createElement('a');
      a.className = 'iac-mkt-btn';
      a.href = links[s.key];
      a.target = '_blank';
      a.rel = 'noopener nofollow';
      a.innerHTML = '<span aria-hidden="true">🛒</span><span></span>';
      a.lastChild.textContent = 'Buy on ' + s.label;
      row.appendChild(a);
    });
    box.appendChild(row);

    // Under Add to Cart / Buy Now. On phones .actions is a fixed bar at the
    // bottom, so this lands where the buttons would have been in the flow.
    var actions = document.querySelector('main .actions');
    if (actions && actions.parentNode) actions.insertAdjacentElement('afterend', box);
    else return;
    addStyles();
  }

  function init() {
    var slug = productSlug();
    if (!slug || links) return;
    fetch('/.netlify/functions/get-marketplace-links?slug=' + encodeURIComponent(slug))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.links) return;
        links = d.links;
        place();
      })
      .catch(function () {});
  }

  window.IACMarketplaceLinks = { init: init };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
