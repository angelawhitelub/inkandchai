/**
 * checkout.js — Ink & Chai
 * Unified checkout modal: address form → Pay Now (Razorpay) or Cash on Delivery.
 * Depends on cart.js being loaded first.
 */

const RAZORPAY_KEY = window.RAZORPAY_KEY_ID || '';

// ── Pincode → City / State ────────────────────────────────────────────────
// Uses a single Netlify function that handles all fallbacks server-side.
async function fetchPincodeData(pin) {
  try {
    const res = await fetch(`/.netlify/functions/pincode-lookup?pin=${pin}`);
    const data = await res.json();
    // `exists` is true when India Post confirmed the PIN, false when it
    // explicitly reported no such PIN, and null when it was unreachable. The
    // lookup can always guess a state from the 3-digit prefix, so city/state
    // being filled does NOT mean the pincode is real — pass the flag through.
    if (res.ok && data.city && data.state) {
      return { city: data.city, state: data.state, exists: data.exists ?? null };
    }
  } catch (e) { /* ignore */ }
  return null;
}

// ── Open unified checkout modal ───────────────────────────────────────────
function openCheckoutForm() {
  const cart = getCart();
  if (cart.length === 0) { showToast('Your cart is empty!'); return; }

  // Remove old if exists
  document.getElementById('unifiedCheckoutModal')?.remove();

  const total = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const totalFmt = '₹ ' + total.toLocaleString('en-IN', { minimumFractionDigits: 2 });

  const modal = document.createElement('div');
  modal.id = 'unifiedCheckoutModal';
  modal.style.cssText = `
    position:fixed; inset:0; background:rgba(13,11,8,0.96); backdrop-filter:blur(10px);
    display:flex; align-items:center; justify-content:center; z-index:6000;
    overflow-y:auto; padding:1.5rem;
  `;

  modal.innerHTML = `
    <div style="background:#1c1916; border:1px solid rgba(201,168,76,0.22);
                width:min(540px,100%); position:relative; overflow:hidden;">

      <!-- Header -->
      <div style="padding:1.8rem 2rem 1.4rem; border-bottom:1px solid rgba(201,168,76,0.12);">
        <button onclick="document.getElementById('unifiedCheckoutModal').remove()"
          style="position:absolute;top:1.2rem;right:1.4rem;background:none;border:none;
                 color:#a09080;font-size:1.3rem;cursor:pointer;line-height:1;">✕</button>
        <div style="font-size:0.55rem;letter-spacing:0.35em;text-transform:uppercase;
                    color:#c9a84c;margin-bottom:0.5rem;">Checkout</div>
        <h3 style="font-family:'Cormorant Garamond',serif;font-size:1.9rem;font-weight:300;
                   color:#faf7f2;margin:0;">Delivery Details</h3>
      </div>

      <!-- Cart summary strip -->
      <div style="padding:0.9rem 2rem;background:#141210;border-bottom:1px solid rgba(201,168,76,0.12);
                  display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:0.65rem;letter-spacing:0.1em;color:#a09080;">
          ${cart.length} item${cart.length > 1 ? 's' : ''}
        </span>
        <span style="font-family:'Cormorant Garamond',serif;font-size:1.2rem;color:#c9a84c;font-weight:600;">
          ${totalFmt}
        </span>
      </div>

      <!-- Form body -->
      <div style="padding:2rem;">

        <!-- Row: Name + Phone -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem;">
          ${chkField('ch-name',  'text',  'Full Name *',     'Your name')}
          ${chkField('ch-phone', 'tel',   'Phone Number *',  '10-digit mobile')}
        </div>

        <!-- Email -->
        <div style="margin-bottom:1rem;">
          ${chkField('ch-email', 'email', 'Email Address *', 'you@example.com')}
        </div>

        <!-- Address Line -->
        <div style="margin-bottom:1rem;">
          ${chkField('ch-addr', 'text', 'House / Street / Locality *', 'e.g. 12B, MG Road, Lajpat Nagar')}
        </div>

        <!-- Row: Pincode + City + State -->
        <div style="display:grid;grid-template-columns:130px 1fr 1fr;gap:1rem;margin-bottom:0.4rem;">
          <div>
            <label style="${labelCss}">Pincode *</label>
            <input id="ch-pin" type="text" inputmode="numeric" maxlength="6" placeholder="6 digits"
              style="${inputCss}"
              onfocus="this.style.borderColor='rgba(201,168,76,0.5)'"
              onblur="this.style.borderColor='rgba(201,168,76,0.18)'"
              oninput="handlePincodeInput(this.value)" />
          </div>
          <div>
            <label style="${labelCss}">City</label>
            <input id="ch-city" type="text" placeholder="Auto-filled"
              style="${inputCss}"
              onfocus="this.style.borderColor='rgba(201,168,76,0.5)'"
              onblur="this.style.borderColor='rgba(201,168,76,0.18)'" />
          </div>
          <div>
            <label style="${labelCss}">State</label>
            <input id="ch-state" type="text" placeholder="Auto-filled"
              style="${inputCss}"
              onfocus="this.style.borderColor='rgba(201,168,76,0.5)'"
              onblur="this.style.borderColor='rgba(201,168,76,0.18)'" />
          </div>
        </div>
        <div id="ch-pin-msg" style="font-size:0.62rem;min-height:1.2em;margin-bottom:1.2rem;
             letter-spacing:0.05em;color:#7a6330;"></div>

        <!-- Divider -->
        <div style="border-top:1px solid rgba(201,168,76,0.12);margin:1.4rem 0 1.6rem;
                    display:flex;align-items:center;gap:1rem;">
          <span style="font-size:0.55rem;letter-spacing:0.28em;text-transform:uppercase;
                       color:#7a6330;white-space:nowrap;">Choose Payment</span>
          <div style="flex:1;height:1px;background:rgba(201,168,76,0.12);"></div>
        </div>

        <!-- Payment buttons -->
        <div style="display:flex;flex-direction:column;gap:0.75rem;">
          <button onclick="submitCheckout('online')"
            style="width:100%;font-family:'Montserrat',sans-serif;font-size:0.65rem;
                   letter-spacing:0.25em;text-transform:uppercase;padding:1.1rem;
                   background:#c9a84c;color:#0d0b08;border:none;cursor:pointer;
                   font-weight:500;transition:all 0.3s;"
            onmouseover="this.style.opacity='0.88'"
            onmouseout="this.style.opacity='1'">
            ⚡ Pay Now — ${totalFmt}
          </button>
          <button onclick="submitCheckout('cod')"
            style="width:100%;font-family:'Montserrat',sans-serif;font-size:0.65rem;
                   letter-spacing:0.22em;text-transform:uppercase;padding:1.05rem;
                   background:transparent;color:#f0e8d8;border:1px solid rgba(201,168,76,0.35);
                   cursor:pointer;font-weight:400;transition:all 0.3s;"
            onmouseover="this.style.borderColor='rgba(201,168,76,0.7)';this.style.color='#c9a84c'"
            onmouseout="this.style.borderColor='rgba(201,168,76,0.35)';this.style.color='#f0e8d8'">
            🚚 Cash on Delivery
          </button>
        </div>

        <p style="font-size:0.6rem;color:#7a6330;text-align:center;margin-top:1.2rem;
                  letter-spacing:0.06em;line-height:1.7;">
          Secure checkout &nbsp;·&nbsp; Pan-India delivery &nbsp;·&nbsp; 7-day returns
        </p>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Pre-fill if logged-in profile is available
  if (window.IAC) setTimeout(() => IAC.prefillCheckout(), 60);

  // Close on backdrop click
  modal.addEventListener('click', e => {
    if (e.target === modal) modal.remove();
  });
}

// Inline CSS helpers so the template strings above stay clean
const labelCss = `display:block;font-size:0.58rem;letter-spacing:0.18em;
  text-transform:uppercase;color:#a09080;margin-bottom:0.45rem;`;
const inputCss = `width:100%;background:#141210;border:1px solid rgba(201,168,76,0.18);
  color:#f0e8d8;padding:0.75rem 0.9rem;font-family:'Montserrat',sans-serif;
  font-size:0.78rem;outline:none;transition:border-color 0.3s;`;

function chkField(id, type, label, placeholder) {
  return `
    <div>
      <label for="${id}" style="${labelCss}">${label}</label>
      <input id="${id}" type="${type}" placeholder="${placeholder}"
        style="${inputCss}"
        onfocus="this.style.borderColor='rgba(201,168,76,0.5)'"
        onblur="this.style.borderColor='rgba(201,168,76,0.18)'" />
    </div>
  `;
}

// ── Pincode live lookup ────────────────────────────────────────────────────
let _pinTimer = null;
// Pincode that India Post explicitly reported as non-existent. Blocks submit.
let _badPincode = '';
function handlePincodeInput(val) {
  const msg = document.getElementById('ch-pin-msg');
  clearTimeout(_pinTimer);
  if (val.length < 6) {
    if (msg) msg.textContent = '';
    return;
  }
  if (msg) msg.textContent = 'Looking up pincode…';
  _pinTimer = setTimeout(async () => {
    const data = await fetchPincodeData(val);
    if (data && data.exists === false) {
      // India Post says this PIN doesn't exist. Don't autofill a guessed
      // city/state — that's what made a typo look accepted. Flag it here and
      // block on submit (see collectAddress).
      _badPincode = val;
      if (msg) {
        msg.textContent = '✕ No such pincode in India Post records — please check and re-enter.';
        msg.style.color = '#c97a7a';
      }
    } else if (data) {
      _badPincode = '';
      const cityEl  = document.getElementById('ch-city');
      const stateEl = document.getElementById('ch-state');
      if (cityEl)  cityEl.value  = data.city;
      if (stateEl) stateEl.value = data.state;
      if (msg) { msg.textContent = '✓ ' + data.city + ', ' + data.state; msg.style.color = '#8fa87a'; }
    } else {
      _badPincode = '';
      if (msg) { msg.textContent = 'Pincode not found — please enter city and state manually.'; msg.style.color = '#c97a7a'; }
    }
  }, 500);
}

// ── Validate + collect address ─────────────────────────────────────────────
function collectAddress() {
  const name  = document.getElementById('ch-name')?.value.trim()  || '';
  const phone = document.getElementById('ch-phone')?.value.trim() || '';
  const email = document.getElementById('ch-email')?.value.trim() || '';
  const addr  = document.getElementById('ch-addr')?.value.trim()  || '';
  const pin   = document.getElementById('ch-pin')?.value.trim()   || '';
  const city  = document.getElementById('ch-city')?.value.trim()  || '';
  const state = document.getElementById('ch-state')?.value.trim() || '';

  if (!name) { showToast('Please enter your full name.'); return null; }
  if (!phone || phone.replace(/\D/g,'').length < 10) {
    showToast('Please enter a valid 10-digit phone number.'); return null;
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    showToast('Please enter a valid email address.'); return null;
  }
  if (!addr) { showToast('Please enter your delivery address.'); return null; }
  if (!pin || pin.length !== 6) { showToast('Please enter a valid 6-digit pincode.'); return null; }
  // A structurally valid but non-existent PIN (e.g. 782417) used to pass:
  // the lookup guesses a state from the 3-digit prefix, so the form looked
  // filled. Block only when India Post explicitly denied it — never when the
  // lookup was merely unreachable, so a flaky API can't stop real orders.
  if (_badPincode && _badPincode === pin) {
    showToast('That pincode doesn\u2019t exist in India Post records. Please check your 6-digit delivery pincode.');
    document.getElementById('ch-pin')?.focus();
    return null;
  }

  return {
    name, phone, email,
    address: `${addr}, ${city ? city + ', ' : ''}${state ? state + ' – ' : ''}${pin}`.replace(/^,\s*|,\s*$/g,''),
    pincode: pin, city, state,
  };
}

// ── Unified submit router ─────────────────────────────────────────────────
function submitCheckout(method) {
  const addr = collectAddress();
  if (!addr) return;
  if (method === 'online') {
    startCheckout(addr);
  } else {
    submitCOD(addr);
  }
}

// ── Razorpay checkout ─────────────────────────────────────────────────────
async function startCheckout(addr) {
  const cart = getCart();
  if (!cart.length) { showToast('Your cart is empty!'); return; }

  showToast('Creating order…');

  try {
    const res = await fetch('/.netlify/functions/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cart,
        customer: addr,
        coupon: (typeof appliedCouponCode === 'string' ? appliedCouponCode : ''),
        payment_mode: 'full',
        discount_grants: (window.iacDiscountGrants ? window.iacDiscountGrants() : []),
        notes: { customer_email: addr.email, customer_phone: addr.phone, customer_name: addr.name },
      }),
    });

    const order = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(order.error || `Order creation failed (${res.status})`);
    // Server is authoritative — use what it returned, not the local cart estimate.
    const amountPaise = order.amount;

    const options = {
      key:         RAZORPAY_KEY,
      amount:      order.amount,
      currency:    order.currency,
      name:        'Ink & Chai',
      description: `${cart.length} book${cart.length > 1 ? 's' : ''}`,
      order_id:    order.id,
      prefill: { name: addr.name, email: addr.email, contact: addr.phone },
      notes: {
        shipping_address: addr.address,
        cart_summary: cart.map(i => `${i.title} x${i.qty}`).join('; ').slice(0, 250),
      },
      theme: { color: '#c9a84c' },

      handler: async function (response) {
        showToast('Verifying payment…');
        try {
          const vRes = await fetch('/.netlify/functions/verify-payment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              razorpay_order_id:   response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature:  response.razorpay_signature,
              cart, customer: addr, amount: amountPaise,
              discount_grants: (window.iacDiscountGrants ? window.iacDiscountGrants() : []),
            }),
          });
          const verifiedOrder = await vRes.json().catch(() => ({}));
          if (!vRes.ok || !verifiedOrder.success) throw new Error('Verification failed');
          clearCart();
          closeCart();
          document.getElementById('unifiedCheckoutModal')?.remove();
          // Auto-create account & send magic link so customer can track order
          if (window.autoLoginAfterOrder) autoLoginAfterOrder(addr.email, addr.name, addr.phone);
          showOrderSuccess(response.razorpay_payment_id, addr.email, cart, Math.round(amountPaise / 100), addr, verifiedOrder.order_id || response.razorpay_order_id);
        } catch (err) {
          console.error(err);
          showToast('Payment received but verification failed. Please contact support.');
        }
      },
      modal: { ondismiss: () => showToast('Payment cancelled.') },
    };

    const rzp = new Razorpay(options);
    rzp.on('payment.failed', r => showToast(`Payment failed: ${r.error.description}`));
    rzp.open();

  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not start checkout. Please try again.');
  }
}

// ── COD submit ────────────────────────────────────────────────────────────
async function submitCOD(addr) {
  const cart   = getCart();
  const amount = cart.reduce((s, i) => s + i.price * i.qty, 0);

  showToast('Placing your order…');

  try {
    const res = await fetch('/.netlify/functions/cod-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cart,
        customer: { name: addr.name, phone: addr.phone, email: addr.email, address: addr.address },
        amount,
        user_id: window.IAC ? IAC.getUserId() : null,
        discount_grants: (window.iacDiscountGrants ? window.iacDiscountGrants() : []),
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');

    document.getElementById('unifiedCheckoutModal')?.remove();
    clearCart();
    closeCart();
    // Auto-create account & send magic link so customer can track order
    if (window.autoLoginAfterOrder) autoLoginAfterOrder(addr.email, addr.name, addr.phone);
    showCODSuccess(data.order_id, addr.name, addr.email, cart, (data.amount || amount), addr);

  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not place order. Please try again.');
  }
}

// ── Success screens ───────────────────────────────────────────────────────
// Shared order-summary block for the success screens: books ordered, the
// amount, and where it's shipping. Rendered from the cart captured BEFORE
// clearCart() runs, so it survives the cart being emptied.
function orderSummaryHtml(cart, amountRs, addr, amountLabel) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const items = Array.isArray(cart) ? cart : [];
  const lines = items.map(i => {
    const qty = Number(i.qty) || 1;
    const line = (Number(i.price) || 0) * qty;
    return `<div style="display:flex;justify-content:space-between;gap:0.8rem;font-size:0.66rem;color:#c8bfae;line-height:1.7;">
        <span style="text-align:left;">${esc(i.title || 'Book')}${qty > 1 ? ` <span style="color:#7a6330;">× ${qty}</span>` : ''}</span>
        <span style="white-space:nowrap;color:#a09080;">₹${line.toLocaleString('en-IN')}</span>
      </div>`;
  }).join('');
  const addrStr = addr ? [addr.address, addr.city, addr.state, addr.pincode].filter(Boolean).join(', ') : '';
  return `
    <div style="background:#1c1916;border:1px solid rgba(201,168,76,0.2);
                padding:1.1rem 1.3rem;margin-bottom:1.4rem;text-align:left;">
      <p style="font-size:0.58rem;color:#7a6330;letter-spacing:0.18em;text-transform:uppercase;margin:0 0 0.7rem;">Your Order</p>
      ${lines || '<div style="font-size:0.66rem;color:#a09080;">Your books</div>'}
      ${amountRs ? `<div style="display:flex;justify-content:space-between;border-top:1px solid rgba(201,168,76,0.18);margin-top:0.7rem;padding-top:0.6rem;">
        <span style="font-size:0.66rem;color:#f0e8d8;letter-spacing:0.06em;">${esc(amountLabel || 'Amount')}</span>
        <span style="font-size:0.8rem;color:#c9a84c;font-weight:600;">₹${Number(amountRs).toLocaleString('en-IN')}</span>
      </div>` : ''}
      ${addrStr ? `<p style="font-size:0.6rem;color:#8a7d68;line-height:1.6;margin:0.75rem 0 0;">
        📍 <span style="color:#a09080;">${esc(addr.name || '')}${addr.name ? ' — ' : ''}${esc(addrStr)}</span>
      </p>` : ''}
    </div>`;
}

/**
 * What we owe the customer at the moment they order: the truth about how long a
 * book can take and what happens if we can't get it.
 *
 * This is the only screen every customer definitely reads. Saying it here costs
 * one paragraph; NOT saying it is where the angry "where is my order / you're a
 * scam" messages come from a week later, because nothing ever told them a
 * listed book is arranged from a publisher rather than pulled off our shelf.
 * The same facts back the WhatsApp bot (SYSTEM_PROMPT → HOW WE SOURCE BOOKS)
 * and the refund policy page — keep the three in step.
 *
 * Deliberately not a scare box: no red, no warning icon, small type, sitting
 * under the order summary rather than above it. It reassures more than it
 * warns, because the headline fact is that nobody can lose money here.
 */
function orderFactsHtml() {
  const item = 'font-size:0.63rem;color:#a09080;line-height:1.75;margin:0 0 0.5rem;';
  return `
    <div style="background:#141210;border:1px solid rgba(201,168,76,0.16);
                padding:1rem 1.3rem;margin-bottom:1.6rem;text-align:left;">
      <p style="font-size:0.58rem;color:#7a6330;letter-spacing:0.18em;text-transform:uppercase;margin:0 0 0.75rem;">
        Good to know
      </p>
      <p style="${item}">
        📚 Many of our titles are arranged from publishers <strong style="color:#c9a84c;">on demand</strong>,
        so a book sometimes has to reach our shelf before it can ship. We'll message you the moment it's dispatched.
      </p>
      <p style="${item}">
        ⏳ If a title is slow to source we try several suppliers — that can add
        <strong style="color:#f0e8d8;">up to about 7 days</strong> before dispatch.
      </p>
      <p style="${item}">
        💚 You can't lose money here. If we still can't arrange it, your order is cancelled
        <strong style="color:#f0e8d8;">automatically within 10 days</strong> and a prepaid order is refunded
        <strong style="color:#f0e8d8;">in full, automatically</strong>, to the same account you paid from.
        Nothing to email, nothing to chase.
      </p>
      <p style="${item}">
        📦 Damaged or wrong book? We replace it. A book missing from your parcel? We send it in the next
        shipment — and if we can't get it, we refund that book.
      </p>
      <p style="font-size:0.63rem;color:#8a7d68;line-height:1.75;margin:0.75rem 0 0;">
        We're a small independent bookshop, not a giant warehouse. Thank you for your patience — and for
        reading with us 💛
      </p>
    </div>`;
}

function showOrderSuccess(paymentId, email, cart, amountRs, addr, surveyOrderId) {
  const modal = document.createElement('div');
  modal.style.cssText = `
    position:fixed; inset:0; background:rgba(13,11,8,0.97);
    display:flex; align-items:flex-start; justify-content:center; z-index:10000; padding:1.5rem;
    overflow-y:auto; -webkit-overflow-scrolling:touch;
  `;
  modal.innerHTML = `
    <div style="text-align:center; padding:3rem 2rem; max-width:500px; margin:auto;">
      <div style="font-size:3rem; margin-bottom:1.5rem;">✦</div>
      <h2 style="font-family:'Cormorant Garamond',serif; font-size:2.4rem;
                 color:#f0e8d8; font-weight:300; margin-bottom:1rem;">Order Confirmed!</h2>
      <p style="font-size:0.78rem; color:#a09080; line-height:1.9; margin-bottom:0.5rem;">
        Thank you for your purchase. Your books are on their way.
      </p>
      <p style="font-size:0.65rem; color:#7a6330; letter-spacing:0.12em; margin-bottom:1rem;">
        Payment ID: ${paymentId}
      </p>
      ${orderSummaryHtml(cart, amountRs, addr, 'Amount paid')}
      ${email ? `
      <div style="background:#1c1916;border:1px solid rgba(201,168,76,0.2);
                  padding:1rem 1.4rem;margin-bottom:1.8rem;text-align:left;">
        <p style="font-size:0.68rem;color:#c9a84c;margin-bottom:0.3rem;letter-spacing:0.08em;">
          📧 Check your email — ${email}
        </p>
        <p style="font-size:0.65rem;color:#a09080;line-height:1.7;margin:0;">
          We've sent your order confirmation and a <strong style="color:#f0e8d8;">one-click login link</strong>
          to track your orders anytime from <strong style="color:#f0e8d8;">My Orders</strong>.
        </p>
      </div>` : ''}
      ${orderFactsHtml()}
      <button onclick="this.closest('div[style*=inset]').remove()"
        style="font-family:'Montserrat',sans-serif; font-size:0.62rem; letter-spacing:0.22em;
               text-transform:uppercase; padding:0.9rem 2rem; background:#c9a84c;
               color:#0d0b08; border:none; cursor:pointer; font-weight:500;">
        Continue Shopping
      </button>
    </div>
  `;
  document.body.appendChild(modal);
  window.IACGoogleCustomerReviews?.render({ orderId: surveyOrderId, email });
}

function showCODSuccess(orderId, name, email, cart, amountRs, addr) {
  const modal = document.createElement('div');
  modal.style.cssText = `
    position:fixed; inset:0; background:rgba(13,11,8,0.97);
    display:flex; align-items:flex-start; justify-content:center; z-index:10000; padding:1.5rem;
    overflow-y:auto; -webkit-overflow-scrolling:touch;
  `;
  modal.innerHTML = `
    <div style="text-align:center; padding:3rem 2rem; max-width:500px; margin:auto;">
      <div style="font-size:3rem; margin-bottom:1.5rem;">🚚</div>
      <h2 style="font-family:'Cormorant Garamond',serif; font-size:2.4rem;
                 color:#f0e8d8; font-weight:300; margin-bottom:1rem;">Order Placed!</h2>
      <p style="font-size:0.82rem; color:#a09080; line-height:1.9; margin-bottom:0.5rem;">
        Hi ${name.split(' ')[0]}, your books are on their way.<br/>
        Pay <strong style="color:#c9a84c;">cash</strong> when they arrive at your door.
      </p>
      <p style="font-size:0.65rem; color:#7a6330; letter-spacing:0.12em; margin-bottom:1rem;">
        Order ID: ${orderId}
      </p>
      ${orderSummaryHtml(cart, amountRs, addr, 'Pay on delivery')}
      ${email ? `
      <div style="background:#1c1916;border:1px solid rgba(201,168,76,0.2);
                  padding:1rem 1.4rem;margin-bottom:1.8rem;text-align:left;">
        <p style="font-size:0.68rem;color:#c9a84c;margin-bottom:0.3rem;letter-spacing:0.08em;">
          📧 Check your email — ${email}
        </p>
        <p style="font-size:0.65rem;color:#a09080;line-height:1.7;margin:0;">
          We've sent your order confirmation and a <strong style="color:#f0e8d8;">one-click login link</strong>
          to track your orders anytime from <strong style="color:#f0e8d8;">My Orders</strong>.
        </p>
      </div>` : ''}
      ${orderFactsHtml()}
      <button onclick="this.closest('div[style*=inset]').remove()"
        style="font-family:'Montserrat',sans-serif; font-size:0.62rem; letter-spacing:0.22em;
               text-transform:uppercase; padding:0.9rem 2rem; background:#c9a84c;
               color:#0d0b08; border:none; cursor:pointer; font-weight:500;">
        Continue Shopping
      </button>
    </div>
  `;
  document.body.appendChild(modal);
  window.IACGoogleCustomerReviews?.render({ orderId, email });
}

// ── Legacy stubs (kept for any old references) ────────────────────────────
function openCODForm() { openCheckoutForm(); }

// ── Old inputField helper (kept for safety) ───────────────────────────────
function inputField(id, type, label, placeholder) {
  return chkField(id, type, label, placeholder);
}
