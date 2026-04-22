/**
 * checkout.js — Akshar & Co.
 * Handles Razorpay checkout flow.
 * Depends on cart.js being loaded first.
 */

const RAZORPAY_KEY = window.RAZORPAY_KEY_ID || '';   // injected at build or set here

async function startCheckout() {
  const cart = getCart();
  if (cart.length === 0) {
    showToast('Your cart is empty!');
    return;
  }

  // Collect customer info
  const name    = document.getElementById('co-name')?.value.trim()    || '';
  const email   = document.getElementById('co-email')?.value.trim()   || '';
  const phone   = document.getElementById('co-phone')?.value.trim()   || '';
  const address = document.getElementById('co-address')?.value.trim() || '';

  if (!email || !phone) {
    showToast('Please enter your email and phone number.');
    openCheckoutForm();
    return;
  }

  const amountPaise = Math.round(
    cart.reduce((s, i) => s + i.price * i.qty, 0) * 100
  );

  showToast('Creating order…');

  try {
    // 1 — Create Razorpay order via Netlify function
    const res = await fetch('/.netlify/functions/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount:   amountPaise,
        currency: 'INR',
        receipt:  `akshar_${Date.now()}`,
        notes: { customer_email: email, customer_phone: phone, customer_name: name },
      }),
    });

    if (!res.ok) throw new Error(`Order creation failed (${res.status})`);
    const order = await res.json();

    // 2 — Open Razorpay checkout
    const options = {
      key:         RAZORPAY_KEY,
      amount:      order.amount,
      currency:    order.currency,
      name:        'Akshar & Co.',
      description: `${cart.length} book${cart.length > 1 ? 's' : ''}`,
      image:       '/logo.png',          // add your logo here
      order_id:    order.id,

      prefill: {
        name:    name,
        email:   email,
        contact: phone,
      },

      notes: {
        shipping_address: address,
        cart_summary: cart.map(i => `${i.title} x${i.qty}`).join('; ').slice(0, 250),
      },

      theme: { color: '#c9a84c' },

      // 3 — On successful payment
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
              cart,
              customer: { name, email, phone, address },
              amount:   amountPaise,
            }),
          });

          if (!vRes.ok) throw new Error('Verification failed');

          // Success!
          clearCart();
          closeCart();
          showOrderSuccess(response.razorpay_payment_id);
        } catch (err) {
          console.error(err);
          showToast('Payment received but verification failed. Please contact support.');
        }
      },

      modal: {
        ondismiss: () => showToast('Payment cancelled.'),
      },
    };

    const rzp = new Razorpay(options);
    rzp.on('payment.failed', function (response) {
      console.error('Payment failed:', response.error);
      showToast(`Payment failed: ${response.error.description}`);
    });

    rzp.open();

  } catch (err) {
    console.error(err);
    showToast('Could not start checkout. Please try again.');
  }
}

// ── Order success screen ───────────────────────────────────────────────────
function showOrderSuccess(paymentId) {
  const modal = document.createElement('div');
  modal.style.cssText = `
    position:fixed; inset:0; background:rgba(13,11,8,0.95);
    display:flex; align-items:center; justify-content:center;
    z-index:10000; animation:fadeIn 0.4s ease;
  `;
  modal.innerHTML = `
    <div style="text-align:center; padding:3rem; max-width:480px;">
      <div style="font-size:3rem; margin-bottom:1.5rem;">✦</div>
      <h2 style="font-family:'Cormorant Garamond',serif; font-size:2.2rem; color:#f0e8d8; font-weight:300; margin-bottom:1rem;">
        Order Confirmed
      </h2>
      <p style="font-size:0.78rem; color:#a09080; line-height:1.8; letter-spacing:0.04em; margin-bottom:0.5rem;">
        Thank you for your purchase. Your books are on their way.
      </p>
      <p style="font-size:0.65rem; color:#7a6330; letter-spacing:0.15em; margin-bottom:2.5rem;">
        Payment ID: ${paymentId}
      </p>
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

// ── Checkout form (name/email/phone/address) ──────────────────────────────
function openCheckoutForm() {
  let form = document.getElementById('checkoutFormModal');
  if (form) { form.style.display = 'flex'; return; }

  form = document.createElement('div');
  form.id = 'checkoutFormModal';
  form.style.cssText = `
    position:fixed; inset:0; background:rgba(13,11,8,0.92); backdrop-filter:blur(8px);
    display:flex; align-items:center; justify-content:center; z-index:5000;
  `;
  form.innerHTML = `
    <div style="background:#1c1916; border:1px solid rgba(201,168,76,0.18);
                padding:2.8rem; width:min(480px,90vw); position:relative;">
      <button onclick="document.getElementById('checkoutFormModal').style.display='none'"
        style="position:absolute;top:1rem;right:1rem;background:none;border:none;
               color:#a09080;font-size:1.2rem;cursor:pointer;">✕</button>

      <div style="font-size:0.58rem;letter-spacing:0.35em;text-transform:uppercase;
                  color:#c9a84c;margin-bottom:0.8rem;">Delivery Details</div>
      <h3 style="font-family:'Cormorant Garamond',serif;font-size:1.8rem;font-weight:300;
                 color:#faf7f2;margin-bottom:2rem;">Complete your order</h3>

      ${inputField('co-name',    'text',  'Full Name',        'Your full name')}
      ${inputField('co-email',   'email', 'Email Address *',  'you@example.com')}
      ${inputField('co-phone',   'tel',   'Phone Number *',   '10-digit mobile')}
      ${inputField('co-address', 'text',  'Delivery Address', 'Street, City, PIN')}

      <button onclick="document.getElementById('checkoutFormModal').style.display='none'; startCheckout();"
        style="width:100%;margin-top:1.5rem;font-family:'Montserrat',sans-serif;
               font-size:0.65rem;letter-spacing:0.25em;text-transform:uppercase;
               padding:1rem 2rem;background:#c9a84c;color:#0d0b08;
               border:none;cursor:pointer;font-weight:500;">
        Proceed to Payment →
      </button>
    </div>
  `;
  document.body.appendChild(form);
}

function inputField(id, type, label, placeholder) {
  return `
    <div style="margin-bottom:1.2rem;">
      <label for="${id}" style="display:block;font-size:0.6rem;letter-spacing:0.18em;
             text-transform:uppercase;color:#a09080;margin-bottom:0.5rem;">${label}</label>
      <input id="${id}" type="${type}" placeholder="${placeholder}"
        style="width:100%;background:#141210;border:1px solid rgba(201,168,76,0.18);
               color:#f0e8d8;padding:0.75rem 1rem;font-family:'Montserrat',sans-serif;
               font-size:0.78rem;outline:none;transition:border-color 0.3s;"
        onfocus="this.style.borderColor='rgba(201,168,76,0.5)'"
        onblur="this.style.borderColor='rgba(201,168,76,0.18)'" />
    </div>
  `;
}
