/**
 * checkout.js — Ink & Chai
 * Unified checkout modal: address form → Pay Now (Razorpay) or Cash on Delivery.
 * Depends on cart.js being loaded first.
 */

const RAZORPAY_KEY = window.RAZORPAY_KEY_ID || '';

// ── Pincode → City / State (India Post API) ───────────────────────────────
async function fetchPincodeData(pin) {
  try {
    const res = await fetch(`https://api.postalpincode.in/pincode/${pin}`);
    const data = await res.json();
    if (data[0].Status === 'Success' && data[0].PostOffice?.length) {
      const po = data[0].PostOffice[0];
      return { city: po.District || po.Division || po.Name, state: po.State };
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
          ${chkField('ch-email', 'email', 'Email Address', 'you@example.com')}
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
    if (data) {
      const cityEl  = document.getElementById('ch-city');
      const stateEl = document.getElementById('ch-state');
      if (cityEl)  cityEl.value  = data.city;
      if (stateEl) stateEl.value = data.state;
      if (msg) { msg.textContent = '✓ ' + data.city + ', ' + data.state; msg.style.color = '#8fa87a'; }
    } else {
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
  if (!addr) { showToast('Please enter your delivery address.'); return null; }
  if (!pin || pin.length !== 6) { showToast('Please enter a valid 6-digit pincode.'); return null; }

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

  const amountPaise = Math.round(cart.reduce((s, i) => s + i.price * i.qty, 0) * 100);
  showToast('Creating order…');

  try {
    const res = await fetch('/.netlify/functions/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount:   amountPaise,
        currency: 'INR',
        receipt:  `ic_${Date.now()}`,
        notes: { customer_email: addr.email, customer_phone: addr.phone, customer_name: addr.name },
      }),
    });

    if (!res.ok) throw new Error(`Order creation failed (${res.status})`);
    const order = await res.json();

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
            }),
          });
          if (!vRes.ok) throw new Error('Verification failed');
          clearCart();
          closeCart();
          document.getElementById('unifiedCheckoutModal')?.remove();
          // Auto-create account & send magic link so customer can track order
          if (window.autoLoginAfterOrder) autoLoginAfterOrder(addr.email, addr.name, addr.phone);
          showOrderSuccess(response.razorpay_payment_id, addr.email);
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
    showToast('Could not start checkout. Please try again.');
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
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');

    document.getElementById('unifiedCheckoutModal')?.remove();
    clearCart();
    closeCart();
    // Auto-create account & send magic link so customer can track order
    if (window.autoLoginAfterOrder) autoLoginAfterOrder(addr.email, addr.name, addr.phone);
    showCODSuccess(data.order_id, addr.name, addr.email);

  } catch (err) {
    console.error(err);
    showToast('Could not place order. Please try again.');
  }
}

// ── Success screens ───────────────────────────────────────────────────────
function showOrderSuccess(paymentId, email) {
  const modal = document.createElement('div');
  modal.style.cssText = `
    position:fixed; inset:0; background:rgba(13,11,8,0.97);
    display:flex; align-items:center; justify-content:center; z-index:10000; padding:1.5rem;
  `;
  modal.innerHTML = `
    <div style="text-align:center; padding:3rem; max-width:500px;">
      <div style="font-size:3rem; margin-bottom:1.5rem;">✦</div>
      <h2 style="font-family:'Cormorant Garamond',serif; font-size:2.4rem;
                 color:#f0e8d8; font-weight:300; margin-bottom:1rem;">Order Confirmed!</h2>
      <p style="font-size:0.78rem; color:#a09080; line-height:1.9; margin-bottom:0.5rem;">
        Thank you for your purchase. Your books are on their way.
      </p>
      <p style="font-size:0.65rem; color:#7a6330; letter-spacing:0.12em; margin-bottom:1rem;">
        Payment ID: ${paymentId}
      </p>
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
      <button onclick="this.closest('div[style*=inset]').remove()"
        style="font-family:'Montserrat',sans-serif; font-size:0.62rem; letter-spacing:0.22em;
               text-transform:uppercase; padding:0.9rem 2rem; background:#c9a84c;
               color:#0d0b08; border:none; cursor:pointer; font-weight:500;">
        Continue Shopping
      </button>
    </div>
  `;
  document.body.appendChild(modal);
}

function showCODSuccess(orderId, name, email) {
  const modal = document.createElement('div');
  modal.style.cssText = `
    position:fixed; inset:0; background:rgba(13,11,8,0.97);
    display:flex; align-items:center; justify-content:center; z-index:10000; padding:1.5rem;
  `;
  modal.innerHTML = `
    <div style="text-align:center; padding:3rem; max-width:500px;">
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
      <button onclick="this.closest('div[style*=inset]').remove()"
        style="font-family:'Montserrat',sans-serif; font-size:0.62rem; letter-spacing:0.22em;
               text-transform:uppercase; padding:0.9rem 2rem; background:#c9a84c;
               color:#0d0b08; border:none; cursor:pointer; font-weight:500;">
        Continue Shopping
      </button>
    </div>
  `;
  document.body.appendChild(modal);
}

// ── Legacy stubs (kept for any old references) ────────────────────────────
function openCODForm() { openCheckoutForm(); }

// ── Old inputField helper (kept for safety) ───────────────────────────────
function inputField(id, type, label, placeholder) {
  return chkField(id, type, label, placeholder);
}
