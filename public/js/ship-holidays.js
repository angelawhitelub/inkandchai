/**
 * Shipping holidays on the product page: days the owner has closed dispatch
 * (admin Tools → Shipping holidays).
 *
 * The Worker adds this, with window.__iacShipHolidays = [{ from, to }], to product
 * pages only while a holiday is ahead, so without one nothing here runs at all. It
 * loads after the page's own ship-by script and only repaints when a holiday
 * actually moves this page's dispatch date.
 *
 * The rule: dispatch is the first open day on or after the normal dispatch day,
 * then the book's handling days are counted on open days only. Delivery dates
 * follow, because data-extra-days tells the pincode estimate how far dispatch moved.
 *
 * Pre-orders are worked out by public/js/release-date.js, which asks fromDay() here.
 */
(function (root) {
  'use strict';

  var DAY = 86400000;
  var IST = 5.5 * 60 * 60 * 1000;
  var CUTOFF = 3;                                   // 03:00 IST manifest cutoff
  var ZONES = [['Delhi NCR', 1], ['Nearby states', 2], ['Rest of India', 3]];
  // Admin caps one holiday at 90 days; this only stops a bad list hanging a page.
  var MAX_SCAN = 800;

  function dayOf(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY : null;
  }

  function closedDays(ranges) {
    var spans = [];
    (ranges || []).forEach(function (r) {
      var from = dayOf(r && r.from);
      var to = dayOf(r && r.to);
      if (from !== null && to !== null && to >= from) spans.push([from, to]);
    });
    return function (day) {
      return spans.some(function (s) { return day >= s[0] && day <= s[1]; });
    };
  }

  /** First open day on or after `day`. */
  function nextOpen(day, closed) {
    var d = day;
    for (var i = 0; i < MAX_SCAN && closed(d); i++) d += 1;
    return d;
  }

  /** The dispatch day from `start`, with `handling` days counted on open days. */
  function fromDay(start, handling, ranges) {
    var closed = closedDays(ranges === undefined ? root.__iacShipHolidays : ranges);
    var d = nextOpen(start, closed);
    for (var i = 0; i < handling; i++) d = nextOpen(d + 1, closed);
    return d;
  }

  /** Pure: the dispatch plan for an ordinary book. Day numbers are whole IST days. */
  function plan(now, handling, ranges) {
    var ist = now + IST;
    var today = Math.floor(ist / DAY);
    var normal = today + (new Date(ist).getUTCHours() < CUTOFF ? 0 : 1);
    handling = Math.max(0, Math.min(30, parseInt(handling, 10) || 0));
    var ship = fromDay(normal, handling, ranges);
    var resume = fromDay(normal, 0, ranges);
    return {
      today: today, normal: normal, handling: handling, ship: ship, resume: resume,
      extra: ship - normal, moved: ship !== normal + handling, closedNow: resume !== normal,
    };
  }

  function fmt(dayNum, w) {
    return new Intl.DateTimeFormat('en-IN', {
      weekday: w, day: 'numeric', month: w === 'long' ? 'long' : 'short', timeZone: 'UTC',
    }).format(new Date(dayNum * DAY));
  }

  function subLine(p) {
    if (p.closedNow) return 'Shipping holiday: dispatch resumes on ' + fmt(p.resume, 'long');
    return 'Allow ' + p.handling + ' extra ' + (p.handling === 1 ? 'day' : 'days') + ' before dispatch, plus a shipping holiday';
  }

  var api = { fromDay: fromDay, plan: plan, subLine: subLine };
  root.iacShipDates = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  var doc = root.document;
  if (!doc) return;

  // A pre-order has its own box: repaint it now the holidays are known.
  if (root.__iacPreorder) {
    if (root.iacRelease && root.iacRelease.repaint) root.iacRelease.repaint();
    return;
  }

  function paint(handling) {
    var p = plan(Date.now(), handling);
    var el = doc.getElementById('staticShipBy') || doc.getElementById('shipBy');
    if (!p.moved || !el || !el.querySelector('.ship-by-box')) return;
    var limited = p.handling > 0 && el.id === 'staticShipBy' ? '<div class="ship-by-limited">⚡ Limited stock</div>' : '';
    var rows = ZONES.map(function (z) {
      return '<div class="eta-row"><span class="eta-zone">' + z[0] + '</span>'
        + '<span class="eta-date">' + fmt(p.ship + z[1], 'short') + '</span></div>';
    }).join('');
    el.innerHTML = '<div class="ship-by-box"><div class="ship-by-icon">📦</div><div class="ship-by-text">'
      + '<div class="ship-by-label">Ships by</div>'
      + '<div class="ship-by-date">' + fmt(p.ship, 'long') + '</div>'
      + '<div class="ship-by-sub">' + subLine(p) + '</div>'
      + limited
      + '<div class="eta-block" data-delivery-eta data-extra-days="' + p.extra + '">'
      + '<div class="eta-head">Estimated delivery</div>' + rows + '</div>'
      + '</div></div>';
    if (root.iacDeliveryEtaInit) root.iacDeliveryEtaInit();
  }

  // Catalogue pages repaint through this global when the admin's handling time
  // differs from the baked one, so a holiday has to survive that repaint.
  var pageRender = root.renderStaticShipBy;
  if (typeof pageRender === 'function') {
    root.renderStaticShipBy = function (handling) {
      root.__iacHandlingDays = Math.max(0, Math.min(30, parseInt(handling, 10) || 0));
      pageRender(root.__iacHandlingDays);
      paint(root.__iacHandlingDays);
    };
  }
  paint(root.__iacHandlingDays);
}(typeof window !== 'undefined' ? window : globalThis));
