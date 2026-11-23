/*
 * Pay Later at checkout (netlify/functions/utils/pay-later).
 *
 * Shows nothing unless the owner has switched Pay Later on and the cart holds
 * a Pay Later title. Then: a greyed "not eligible" button for customers with
 * fewer than 5 delivered orders (no apply form), or, for eligible ones, a form
 * that takes the PAN photo + bank details with the reasons we ask for them,
 * and places an order that waits for the owner's confirmation.
 * Every rule is enforced again by pay-later-order; this only explains it.
 * Uses the checkout page's own getCart(), collectAddr(), clearCart().
 */
(function () {
  'use strict';
  var slot = document.getElementById('payLaterSlot');
  if (!slot) return;

  var state = { status: null, open: false, busy: false };
  var timer = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function cart() { try { return (typeof getCart === 'function' ? getCart() : []) || []; } catch (e) { return []; } }
  function phone() { var el = document.getElementById('ch-phone'); return el ? el.value.replace(/\D/g, '') : ''; }

  function check() {
    var c = cart();
    if (!c.length) { slot.innerHTML = ''; return; }
    fetch('/.netlify/functions/pay-later-status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone(), slugs: c.map(function (i) { return i && i.slug; }).filter(Boolean) }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      var keep = state.open && d && d.enabled && d.eligible && d.cart === 'all';
      state.status = d;
      if (!keep) { state.open = false; render(); }   /* never wipe a half-filled form */
    })
      .catch(function () { /* Pay Later simply stays hidden */ });
  }
  function soon() { clearTimeout(timer); timer = setTimeout(check, 700); }

  var BTN = 'display:block;width:100%;margin-top:.75rem;padding:.85rem 1rem;border-radius:10px;font-weight:700;font-size:.85rem;letter-spacing:.02em;';
  function render() {
    var d = state.status;
    if (!d || !d.enabled || d.cart === 'none') { slot.innerHTML = ''; return; }
    if (!d.eligible) {
      slot.innerHTML = '<button type="button" disabled aria-disabled="true" style="' + BTN + 'border:1px dashed #b9a3dc;background:#f6f1fb;color:#8a7aa6;cursor:not-allowed;">🕒 Pay Later · pay within ' + esc(d.due_days || 7) + ' days of delivery</button>'
        + '<div style="font-size:.66rem;line-height:1.6;text-align:center;margin-top:.4rem;color:var(--cream-dim);">' + esc(d.message || '') + '</div>';
      return;
    }
    if (!state.open) {
      slot.innerHTML = '<button type="button" id="plOpenBtn" style="' + BTN + 'border:1px solid #7b55c7;background:#f1eafb;color:#4b2a8c;cursor:pointer;">🕒 Pay Later · pay within ' + esc(d.due_days || 7) + ' days of delivery</button>'
        + '<div style="font-size:.66rem;line-height:1.6;text-align:center;margin-top:.4rem;color:var(--cream-dim);">You are eligible. Your order is placed after we confirm it.</div>';
      document.getElementById('plOpenBtn').onclick = function () {
        if (typeof collectAddr === 'function' && !collectAddr()) return;
        state.open = true; render();
        var f = document.getElementById('plForm'); if (f) f.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      return;
    }
    var why = (d.why || []).map(function (t) { return '<li style="margin:.25rem 0;">' + esc(t) + '</li>'; }).join('');
    var input = 'width:100%;padding:.65rem .75rem;border-radius:8px;border:1px solid var(--border);background:#fff;color:inherit;font-size:.85rem;margin-top:.25rem;';
    var label = 'display:block;font-size:.7rem;margin-top:.7rem;color:var(--cream-dim);';
    slot.innerHTML = '<div id="plForm" style="margin-top:.85rem;padding:1rem;border:1px solid #b9a3dc;border-radius:14px;background:#faf7fd;text-align:left;">'
      + '<div style="font-weight:700;font-size:.9rem;margin-bottom:.4rem;">🕒 Pay Later: a few details for your credit check</div>'
      + '<div style="font-weight:600;font-size:.74rem;margin-top:.4rem;">Why we ask for your PAN and bank details</div>'
      + '<ul style="font-size:.7rem;line-height:1.6;padding-left:1.1rem;margin:.3rem 0 .4rem;color:var(--cream-dim);">' + why + '</ul>'
      + '<label style="' + label + '">Photo of your PAN card (front side)<input id="plPan" type="file" accept="image/jpeg,image/png,image/webp" style="' + input + '"/></label>'
      + '<label style="' + label + '">Name exactly as on your PAN card<input id="plPanName" type="text" autocomplete="off" style="' + input + '"/></label>'
      + '<label style="' + label + '">PAN number<input id="plPanNo" type="text" maxlength="10" autocomplete="off" placeholder="ABCDE1234F" style="' + input + 'text-transform:uppercase;"/></label>'
      + '<label style="' + label + '">Bank account number (in the same name as your PAN)<input id="plAcc" type="text" inputmode="numeric" autocomplete="off" style="' + input + '"/></label>'
      + '<label style="' + label + '">Bank account number again<input id="plAcc2" type="text" inputmode="numeric" autocomplete="off" style="' + input + '"/></label>'
      + '<label style="' + label + '">IFSC code<input id="plIfsc" type="text" maxlength="11" autocomplete="off" placeholder="SBIN0001234" style="' + input + 'text-transform:uppercase;"/></label>'
      + '<label style="display:flex;gap:.55rem;align-items:flex-start;margin-top:.85rem;font-size:.7rem;line-height:1.5;cursor:pointer;"><input id="plConsent" type="checkbox" style="width:18px;height:18px;min-width:18px;max-width:18px;flex:0 0 18px;padding:0;margin:.1rem 0 0;border-radius:3px;accent-color:#5b34b0;appearance:auto;-webkit-appearance:checkbox;"/><span>' + esc(d.consent || '') + '</span></label>'
      + '<div id="plErr" role="alert" style="display:none;margin-top:.7rem;color:#b3261e;font-size:.74rem;"></div>'
      + '<button type="button" id="plSubmit" style="' + BTN + 'border:none;background:#5b34b0;color:#fff;cursor:pointer;">Request Pay Later order</button>'
      + '<button type="button" id="plCancel" style="display:block;margin:.5rem auto 0;background:none;border:none;color:var(--cream-dim);font-size:.7rem;text-decoration:underline;cursor:pointer;">Choose another way to pay</button>'
      + '</div>';
    document.getElementById('plCancel').onclick = function () { state.open = false; render(); };
    document.getElementById('plSubmit').onclick = submit;
  }

  function fail(msg) {
    var e = document.getElementById('plErr');
    if (e) { e.textContent = msg; e.style.display = ''; e.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }

  /* Shrinks the photo to at most 1800 px as a JPEG, so it uploads quickly. */
  function readImage(file) {
    return new Promise(function (resolve, reject) {
      if (!file) return reject(new Error('Please choose a photo of your PAN card.'));
      if (!/^image\//.test(file.type)) return reject(new Error('Please upload a photo (JPG or PNG) of your PAN card.'));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var max = 1800, w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, max / Math.max(w, h));
          var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          var data = c.toDataURL('image/jpeg', 0.85);
          URL.revokeObjectURL(url);
          resolve({ type: 'image/jpeg', data: data.split(',')[1] });
        } catch (e) { URL.revokeObjectURL(url); reject(new Error('We could not read that photo. Please try another one.')); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('We could not read that photo. Please upload a JPG or PNG.')); };
      img.src = url;
    });
  }

  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }

  function submit() {
    if (state.busy) return;
    var addr = typeof collectAddr === 'function' ? collectAddr() : null;
    if (!addr) return;
    var kyc = {
      pan_name: val('plPanName'), pan: val('plPanNo').toUpperCase(), account: val('plAcc').replace(/\s/g, ''),
      account_confirm: val('plAcc2').replace(/\s/g, ''), ifsc: val('plIfsc').toUpperCase(),
      consent: !!(document.getElementById('plConsent') || {}).checked,
    };
    if (kyc.pan_name.length < 3) return fail('Enter your name exactly as it is printed on your PAN card.');
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(kyc.pan)) return fail('Enter a valid 10-character PAN number (like ABCDE1234F).');
    if (!/^\d{9,18}$/.test(kyc.account)) return fail('Enter a valid bank account number (9 to 18 digits).');
    if (kyc.account !== kyc.account_confirm) return fail('The two bank account numbers do not match.');
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(kyc.ifsc)) return fail('Enter a valid 11-character IFSC code (like SBIN0001234).');
    if (!kyc.consent) return fail('Please tick the consent box so we can check your credit score.');
    var file = (document.getElementById('plPan') || {}).files;
    var btn = document.getElementById('plSubmit');
    state.busy = true; if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    readImage(file && file[0]).then(function (image) {
      return fetch('/.netlify/functions/pay-later-order', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cart: cart(),
          customer: { name: addr.name, phone: addr.phone, email: addr.email, address: addr.address },
          coupon: (typeof appliedCouponCode !== 'undefined' && appliedCouponCode) || '',
          kyc: kyc, pan_image: image,
        }),
      }).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Could not place your request.'); return d; }); });
    }).then(function (d) {
      try { if (typeof clearCart === 'function') clearCart(); } catch (e) { /* cart already gone */ }
      var block = document.getElementById('paymentBlock') || slot;
      block.innerHTML = '<div style="padding:1.2rem;border:1px solid #b9a3dc;border-radius:14px;background:#faf7fd;text-align:center;line-height:1.7;">'
        + '<div style="font-size:1.6rem;">🕒</div><div style="font-weight:700;font-size:1rem;">Pay Later request received</div>'
        + '<div style="font-size:.8rem;margin-top:.3rem;">Order <strong>' + esc(d.order_id) + '</strong> · ₹' + esc(Number(d.amount || 0).toLocaleString('en-IN')) + ' to pay after delivery</div>'
        + '<div style="font-size:.74rem;color:var(--cream-dim);margin-top:.5rem;">Nothing has been charged. We will check your credit score and email you once your order is confirmed, usually within 24 hours. No OTP is needed, and our employees will never call or message you asking for one.</div>'
        + (d.mandate_key ? '<div id="plAutopay" style="margin-top:1rem;padding:.9rem;border:1px dashed #7b55c7;border-radius:12px;background:#fff;text-align:left;">'
          + '<div style="font-weight:700;">🔁 Last step: set up AutoPay</div>'
          + '<div style="font-size:.76rem;margin:.35rem 0 .6rem;">If your order is still unpaid on the day it is delivered, we collect ₹' + esc(Number(d.amount || 0).toLocaleString('en-IN')) + ' through AutoPay. Your bank or UPI app tells you before any money is taken. Nothing is taken now (UPI asks for a ₹1 approval). If we decline your request, we cancel the AutoPay.</div>'
          + '<button type="button" data-m="upi" style="' + BTN + 'border:1px solid #7b55c7;background:#f1eafb;color:#4b2a8c;cursor:pointer;margin:0 0 .45rem;">UPI AutoPay (any UPI app)</button>'
          + '<button type="button" data-m="emandate" style="' + BTN + 'border:1px solid #7b55c7;background:#fff;color:#4b2a8c;cursor:pointer;margin:0;">Bank mandate on the account you gave (net banking)</button>'
          + '<div id="plApMsg" style="font-size:.74rem;margin-top:.5rem;"></div></div>' : '')
        + '<a href="/" style="display:inline-block;margin-top:.9rem;color:#5b34b0;">Continue browsing</a></div>';
      block.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (d.mandate_key) {
        Array.prototype.forEach.call(document.querySelectorAll('#plAutopay button[data-m]'), function (b) {
          b.onclick = function () { autopay(d.order_id, d.mandate_key, b.getAttribute('data-m')); };
        });
      }
    }).catch(function (e) {
      fail(e.message || 'Could not place your request.');
    }).then(function () {
      state.busy = false;
      var b = document.getElementById('plSubmit'); if (b) { b.disabled = false; b.textContent = 'Request Pay Later order'; }
    });
  }

  /* AutoPay mandate (pay-later-mandate): Razorpay Checkout in recurring mode. */
  function apMsg(t, ok) { var el = document.getElementById('plApMsg'); if (el) { el.style.color = ok ? '#2e7d32' : '#b3261e'; el.textContent = t; } }
  function apCall(body) {
    return fetch('/.netlify/functions/pay-later-mandate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (x) { if (!r.ok) throw new Error(x.error || 'AutoPay could not be set up.'); return x; }); });
  }
  function autopay(orderId, key, method) {
    if (typeof Razorpay !== 'function') return apMsg('Payment window did not load. Please refresh the page and try again.');
    apMsg('Opening…', true);
    apCall({ action: 'start', order: orderId, key: key, method: method }).then(function (s) {
      if (s.already) { apMsg(s.status === 'active' ? '✅ AutoPay is already set up.' : '⏳ Your bank is confirming the mandate.', true); return; }
      var rzp = new Razorpay({
        key: s.key_id, order_id: s.order_id, customer_id: s.customer_id, recurring: method === 'upi' ? '1' : true,
        name: 'Ink & Chai', description: 'Pay Later AutoPay for ' + orderId, notes: s.notes || {},
        prefill: { name: s.name || '', email: s.email || '', contact: s.contact || '' },
        theme: { color: '#5b34b0' },
        handler: function (resp) {
          apMsg('Checking…', true);
          apCall({ action: 'verify', order: orderId, key: key, razorpay_payment_id: resp.razorpay_payment_id, razorpay_order_id: resp.razorpay_order_id, razorpay_signature: resp.razorpay_signature })
            .then(function (v) {
              var box = document.getElementById('plAutopay');
              if (box) box.innerHTML = v.status === 'active'
                ? '<div style="font-weight:700;color:#2e7d32;">✅ AutoPay is set up</div><div style="font-size:.76rem;margin-top:.3rem;">We will only collect it if the order is still unpaid on the day it is delivered. No OTP is needed, and our employees will never call or message you asking for one.</div>'
                : '<div style="font-weight:700;color:#4b2a8c;">⏳ Sent to your bank</div><div style="font-size:.76rem;margin-top:.3rem;">Your bank confirms the mandate in 1 to 2 working days. Nothing more to do.</div>';
            }).catch(function (e) { apMsg(e.message); });
        },
        modal: { ondismiss: function () { apMsg('AutoPay was not set up. You can try again.'); } },
      });
      rzp.on && rzp.on('payment.failed', function (r) { apMsg((r && r.error && r.error.description) || 'AutoPay approval failed. Please try again.'); });
      rzp.open();
    }).catch(function (e) { apMsg(e.message); });
  }

  var ph = document.getElementById('ch-phone');
  if (ph) { ph.addEventListener('input', soon); ph.addEventListener('change', check); }
  window.addEventListener('storage', soon);
  /* The checkout re-renders the summary when the cart changes; follow it. */
  var sum = document.getElementById('orderItems');
  if (sum && window.MutationObserver) new MutationObserver(soon).observe(sum, { childList: true, subtree: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check); else check();
})();
