/**
 * Pincode delivery estimate for the product page.
 *
 * Replaces the fixed "Delhi NCR / Nearby states / Rest of India" table, which
 * was a guess with no pincode behind it, with a real per-pincode date from the
 * courier network. The old table stays in the markup as the no-JS fallback and
 * is only removed once this has an answer to put in its place.
 *
 * The pincode is remembered, so a shopper types it once and every product page
 * afterwards opens with their own delivery date already on it.
 *
 * Contract with the page: an element with [data-delivery-eta] containing the
 * fallback markup, optionally carrying data-extra-days for slow-to-pick titles.
 */
(function () {
  'use strict';

  var STORE_KEY = 'iac_delivery_pincode';
  var ENDPOINT = '/.netlify/functions/delivery-estimate';

  function readPin() {
    try { return (localStorage.getItem(STORE_KEY) || '').replace(/\D/g, '').slice(0, 6); }
    catch (e) { return ''; }
  }
  function writePin(pin) {
    try { localStorage.setItem(STORE_KEY, pin); } catch (e) {}
  }

  function fmtDate(iso) {
    var parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!parts) return '';
    var d = new Date(Date.UTC(+parts[1], +parts[2] - 1, +parts[3]));
    return new Intl.DateTimeFormat('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
    }).format(d);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formHtml(pin) {
    return ''
      + '<div class="eta-head">Estimated delivery</div>'
      + '<div class="eta-pin-row">'
      +   '<input class="eta-pin-input" type="text" inputmode="numeric" maxlength="6" '
      +     'placeholder="Enter pincode" aria-label="Delivery pincode" value="' + esc(pin) + '" />'
      +   '<button type="button" class="eta-pin-btn">CHECK</button>'
      + '</div>'
      + '<div class="eta-pin-result" role="status" aria-live="polite"></div>';
  }

  function render(box, state) {
    var out = box.querySelector('.eta-pin-result');
    if (!out) return;
    if (state.loading) {
      out.className = 'eta-pin-result eta-pin-loading';
      out.textContent = 'Checking couriers…';
      return;
    }
    if (state.error) {
      out.className = 'eta-pin-result eta-pin-error';
      out.textContent = state.error;
      return;
    }
    if (state.serviceable === false) {
      out.className = 'eta-pin-result eta-pin-error';
      out.textContent = state.message || 'No courier currently delivers to this pincode.';
      return;
    }
    var lines = [];
    if (state.estimated_delivery) {
      lines.push('<div class="eta-pin-date">Delivery by <strong>' + esc(fmtDate(state.estimated_delivery)) + '</strong></div>');
    }
    if (state.place) lines.push('<div class="eta-pin-place">to ' + esc(state.place) + '</div>');
    lines.push('<div class="eta-pin-cod">' + (state.cod_available
      ? 'Cash on delivery available'
      : 'Prepaid only at this pincode') + '</div>');
    out.className = 'eta-pin-result eta-pin-ok';
    out.innerHTML = lines.join('');
  }

  function attach(box) {
    if (box.dataset.etaReady === '1') return;
    box.dataset.etaReady = '1';

    var fallback = box.innerHTML;         // the zone table, kept for failure
    var saved = readPin();
    box.innerHTML = formHtml(saved);

    var input = box.querySelector('.eta-pin-input');
    var btn = box.querySelector('.eta-pin-btn');
    var extraDays = parseInt(box.getAttribute('data-extra-days'), 10) || 0;
    var inFlight = null;

    function restoreFallback() {
      // Only if we never managed to show a real answer — otherwise the shopper
      // would watch their delivery date turn back into a generic table.
      if (box.dataset.etaAnswered === '1') return;
      box.innerHTML = fallback;
      box.dataset.etaReady = '';
      attach(box);
    }

    function check(pin) {
      if (!/^\d{6}$/.test(pin)) {
        render(box, { error: 'Enter a 6-digit pincode.' });
        return;
      }
      writePin(pin);
      render(box, { loading: true });
      var mine = (inFlight = {});

      // The place name comes from the existing pincode lookup, so a shopper can
      // see they typed the pincode they meant. It must never block the date.
      Promise.all([
        fetch(ENDPOINT + '?pincode=' + encodeURIComponent(pin) + (extraDays ? '&extra_days=' + extraDays : ''))
          .then(function (r) { return r.json(); }),
        fetch('/.netlify/functions/pincode-lookup?pin=' + encodeURIComponent(pin))
          .then(function (r) { return r.json(); })
          .catch(function () { return {}; }),
      ]).then(function (res) {
        if (inFlight !== mine) return;          // a newer check has started
        var eta = res[0] || {};
        var loc = res[1] || {};
        if (eta.error && eta.serviceable !== false && !eta.estimated_delivery) {
          render(box, { error: eta.error });
          return;
        }
        var place = [loc.city, loc.state].filter(Boolean).join(', ');
        box.dataset.etaAnswered = '1';
        render(box, {
          serviceable: eta.serviceable,
          message: eta.message,
          estimated_delivery: eta.estimated_delivery,
          cod_available: eta.cod_available,
          place: place,
        });
      }).catch(function () {
        if (inFlight !== mine) return;
        render(box, { error: 'Could not check just now. Please try again.' });
        restoreFallback();
      });
    }

    if (btn) btn.addEventListener('click', function () { check((input.value || '').replace(/\D/g, '')); });
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); check((input.value || '').replace(/\D/g, '')); }
      });
      input.addEventListener('input', function () {
        var v = (input.value || '').replace(/\D/g, '').slice(0, 6);
        if (v !== input.value) input.value = v;
        if (v.length === 6) check(v);          // no reason to make them press a button
      });
    }

    if (/^\d{6}$/.test(saved)) check(saved);
  }

  function init() {
    var boxes = document.querySelectorAll('[data-delivery-eta]');
    for (var i = 0; i < boxes.length; i++) attach(boxes[i]);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Dynamic product pages build their markup after load.
  window.iacDeliveryEtaInit = init;
})();
