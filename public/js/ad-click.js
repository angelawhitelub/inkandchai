/**
 * Did this visitor arrive from a Google Ads click?
 *
 * Loaded on every storefront page. When a landing URL carries gclid / gbraid /
 * wbraid it is remembered here (90 days, Google's click window), so the answer
 * survives the visitor browsing a few pages before checkout. The Google tag's
 * own _gcl_* cookies are checked too.
 *
 * Checkout sends window.iacAdClick() with the order: 'gclid:<id>' (or gbraid /
 * wbraid), or 'none'. The Google Ads retraction feed uses it to skip orders
 * Google never counted as conversions -- retracting those is what filled the
 * daily upload with "This conversion doesn't exist" errors. See
 * netlify/functions/utils/ad-click.js.
 */
(function () {
  'use strict';
  var KEY = 'iac_ad_click';
  var TTL = 90 * 86400000;
  var ID = /^[A-Za-z0-9_.\-]{8,200}$/;

  function remember() {
    try {
      var p = new URLSearchParams(location.search);
      var kinds = ['gclid', 'gbraid', 'wbraid'];
      for (var i = 0; i < kinds.length; i++) {
        var v = p.get(kinds[i]);
        if (v && ID.test(v)) {
          localStorage.setItem(KEY, JSON.stringify({ v: kinds[i] + ':' + v, t: Date.now() }));
          return;
        }
      }
    } catch (e) { /* storage blocked */ }
  }

  function cookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  // _gcl_aw = "GCL.<timestamp>.<gclid>", _gcl_gb = "GCL.<timestamp>.<gbraid>".
  function fromCookie(name, kind) {
    var parts = cookie(name).split('.');
    var id = parts.slice(2).join('.');
    return id && ID.test(id) ? kind + ':' + id : '';
  }

  window.iacAdClick = function () {
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && s.v && Date.now() - s.t < TTL) return s.v;
    } catch (e) { /* fall through to cookies */ }
    return fromCookie('_gcl_aw', 'gclid') || fromCookie('_gcl_gb', 'gbraid') || 'none';
  };

  remember();
})();
