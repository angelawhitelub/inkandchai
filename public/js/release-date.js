/**
 * Pre-order titles: a product page whose release date is still ahead.
 *
 * The page sets window.__iacRelease = 'YYYY-MM-DD' (product-page for admin-
 * added books, the Worker for catalogue books — see utils/release-date.js) and
 * loads this right after its own ship-by script. It decides at VIEW time, in
 * IST, whether the date is still upcoming, so a cached page goes back to
 * normal on release day without anyone touching it.
 *
 * While upcoming it:
 *   - shows a "Pre-order · Releases on …" notice above the ship-by box;
 *   - moves the ship-by date to the release day plus the book's handling time
 *     (window.__iacHandlingDays), and the delivery estimate with it — the
 *     pincode check gets the same shift through data-extra-days;
 *   - relabels the stock pill, the delivery trust badge and Buy Now.
 *
 * Both page types keep their own ship-by renderer; on catalogue pages the
 * global renderStaticShipBy is replaced, so a later handling-time repaint from
 * the page's override fetch still lands on the release-aware dates.
 */
(function (root) {
  'use strict';

  var DAY = 86400000;
  var IST = 5.5 * 60 * 60 * 1000;
  var CUTOFF = 3;                                   // 03:00 IST manifest cutoff
  var ZONES = [['Delhi NCR', 1], ['Nearby states', 2], ['Rest of India', 3]];

  /**
   * Pure: the dispatch plan for a release date. Day numbers are whole IST
   * days since the epoch. `extra` is how far past the normal dispatch day the
   * parcel leaves — what the pincode estimate needs as extra_days.
   */
  function plan(iso, handling, now) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return null;
    var release = Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY;
    var ist = now + IST;
    var today = Math.floor(ist / DAY);
    if (!(release > today)) return null;            // released: a normal page
    handling = Math.max(0, Math.min(30, parseInt(handling, 10) || 0));
    var normal = today + (new Date(ist).getUTCHours() < CUTOFF ? 0 : 1);
    var ship = Math.max(normal, release) + handling;
    return { release: release, ship: ship, extra: ship - normal, handling: handling, daysToRelease: release - today };
  }

  function fmt(dayNum, w) {
    return new Intl.DateTimeFormat('en-IN', {
      weekday: w, day: 'numeric', month: w === 'long' ? 'long' : 'short',
      year: w === 'long' ? 'numeric' : undefined, timeZone: 'UTC',
    }).format(new Date(dayNum * DAY));
  }

  var api = { plan: plan, fmt: fmt };
  root.iacRelease = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  var doc = root.document;
  if (!doc) return;
  var first = plan(root.__iacRelease, root.__iacHandlingDays, Date.now());
  if (!first) return;
  root.__iacPreorder = true;

  function shipByEl() { return doc.getElementById('staticShipBy') || doc.getElementById('shipBy'); }

  function notice(p) {
    var when = (p.daysToRelease === 1 ? 'tomorrow, ' : 'on ') + fmt(p.release, 'long');
    var dispatch = p.handling > 0
      ? 'we dispatch it within ' + p.handling + ' ' + (p.handling === 1 ? 'day' : 'days') + ' of release'
      : 'we dispatch it on release day';
    return '<div class="iac-preorder" data-preorder style="border:1px solid rgba(232,160,48,0.45);'
      + 'background:linear-gradient(135deg,rgba(232,160,48,0.12),rgba(214,184,94,0.05));padding:0.9rem 1.05rem;'
      + 'border-radius:14px;margin:0.8rem 0;display:flex;gap:0.8rem;align-items:flex-start;">'
      + '<div style="font-size:1.45rem;line-height:1;">📅</div><div>'
      + '<div style="font-size:0.58rem;letter-spacing:0.26em;text-transform:uppercase;color:#e8a030;font-weight:700;margin-bottom:0.35rem;">Pre-order</div>'
      + '<div style="font-size:0.88rem;color:var(--cream);line-height:1.5;font-weight:600;">This title releases ' + when + '</div>'
      + '<div style="font-size:0.74rem;color:var(--muted);line-height:1.6;margin-top:0.3rem;">Order now to reserve your copy — '
      + dispatch + ', and you get tracking as soon as it ships.</div>'
      + '</div></div>';
  }

  function render(handling) {
    var p = plan(root.__iacRelease, handling, Date.now());
    var el = shipByEl();
    if (!p || !el) return;
    var rows = ZONES.map(function (z) {
      return '<div class="eta-row"><span class="eta-zone">' + z[0] + '</span>'
        + '<span class="eta-date">' + fmt(p.ship + z[1], 'short') + '</span></div>';
    }).join('');
    var sub = 'Pre-order — dispatched '
      + (p.handling > 0 ? p.handling + ' ' + (p.handling === 1 ? 'day' : 'days') + ' after release' : 'on release day');
    el.innerHTML = '<div class="ship-by-box"><div class="ship-by-icon">📦</div><div class="ship-by-text">'
      + '<div class="ship-by-label">Ships by</div>'
      + '<div class="ship-by-date">' + fmt(p.ship, 'long') + '</div>'
      + '<div class="ship-by-sub">' + sub + '</div>'
      + '<div class="eta-block" data-delivery-eta data-extra-days="' + p.extra + '">'
      + '<div class="eta-head">Estimated delivery</div>' + rows + '</div>'
      + '</div></div>';
    var old = doc.querySelector('[data-preorder]');
    if (old) old.parentNode.removeChild(old);
    el.insertAdjacentHTML('beforebegin', notice(p));
    if (root.iacDeliveryEtaInit) root.iacDeliveryEtaInit();
  }

  // Catalogue pages repaint through this global when the admin's handling time
  // differs from the baked one; route that through the release-aware renderer.
  root.renderStaticShipBy = function (handling) {
    root.__iacHandlingDays = Math.max(0, Math.min(30, parseInt(handling, 10) || 0));
    render(root.__iacHandlingDays);
  };
  render(root.__iacHandlingDays);

  var stock = doc.querySelector('.stock');
  if (stock && !root.__soldOut) { stock.textContent = 'Pre-order'; stock.style.color = '#e8a030'; stock.style.borderColor = 'rgba(232,160,48,0.4)'; }
  var badges = doc.querySelectorAll('.trust .tt');
  for (var i = 0; i < badges.length; i++) {
    var b = badges[i].querySelector('b');
    if (b && /^Delivery in/i.test(b.textContent)) {
      b.textContent = 'Ships on release';
      var sub = badges[i].querySelector('i');
      if (sub) sub.textContent = 'Then 2-5 days to you';
    }
  }
  var buy = doc.querySelector('.actions button.primary');
  if (buy && /buy now/i.test(buy.textContent)) buy.textContent = 'Pre-order Now';
}(typeof window !== 'undefined' ? window : globalThis));
