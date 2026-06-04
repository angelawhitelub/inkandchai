/**
 * auth.js — Ink & Chai user accounts
 * Requires: window.SUPABASE_URL, window.SUPABASE_ANON_KEY
 *           @supabase/supabase-js loaded from CDN before this file
 */

(function () {
  'use strict';

  // ── Supabase client ────────────────────────────────────────────────────────
  let _sb = null;
  function getSB() {
    if (_sb) return _sb;
    if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY || !window.supabase) return null;
    _sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    return _sb;
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let currentUser    = null;
  let currentProfile = null;

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    const sb = getSB();
    if (!sb) { updateNav(); return; }

    const { data: { session } } = await sb.auth.getSession();
    currentUser = session?.user || null;
    if (currentUser) await fetchProfile();
    updateNav();
    openOrdersFromEmailLink();

    sb.auth.onAuthStateChange(async (_event, session) => {
      currentUser = session?.user || null;
      if (currentUser) await fetchProfile();
      else currentProfile = null;
      updateNav();
      openOrdersFromEmailLink();
    });
  }

  const PROFILE_CACHE_KEY = 'iac_profile_cache';

  async function fetchProfile() {
    const sb = getSB();
    if (!sb || !currentUser) return;

    // Show cached profile instantly — fills checkout fields immediately
    try {
      const cached = JSON.parse(sessionStorage.getItem(PROFILE_CACHE_KEY) || 'null');
      if (cached && cached.id === currentUser.id) {
        currentProfile = cached;
        window.IACAuth?.prefillCheckout?.();  // fill checkout immediately
      }
    } catch(e) {}

    // Fetch fresh from Supabase in background
    const { data } = await sb.from('profiles').select('*').eq('id', currentUser.id).maybeSingle();
    if (data) {
      currentProfile = data;
      try { sessionStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(data)); } catch(e) {}
      return;
    }

    const meta = currentUser.user_metadata || {};
    const fallbackProfile = {
      id: currentUser.id,
      name: meta.name || meta.full_name || '',
      phone: meta.phone || '',
      updated_at: new Date().toISOString(),
    };
    if (fallbackProfile.name || fallbackProfile.phone) {
      const { data: created } = await sb
        .from('profiles')
        .upsert(fallbackProfile)
        .select('*')
        .maybeSingle();
      currentProfile = created || fallbackProfile;
      try { sessionStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(currentProfile)); } catch(e) {}
    } else {
      currentProfile = null;
    }
  }

  // ── Nav button ─────────────────────────────────────────────────────────────
  function updateNav() {
    document.querySelectorAll('.auth-nav-btn').forEach(btn => {
      if (currentUser) {
        const first = currentProfile?.name?.split(' ')[0] || currentUser.email?.split('@')[0] || 'Account';
        btn.textContent = '👤 ' + first;
        btn.onclick = openAccountModal;
      } else {
        btn.textContent = '👤 Sign In';
        btn.onclick = openAuthModal;
      }
    });
  }

  function openOrdersFromEmailLink() {
    if (!currentUser) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('orders') !== '1') return;
    params.delete('orders');
    const next = `${window.location.pathname}${params.toString() ? '?' + params.toString() : ''}${window.location.hash}`;
    window.history.replaceState({}, '', next);
    setTimeout(() => {
      openAccountModal();
      window.iacSwitchTab?.('acct-orders-tab');
    }, 250);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.IAC = {
    getUser:    () => currentUser,
    getProfile: () => currentProfile,
    getUserId:  () => currentUser?.id,

    // Pre-fill checkout forms with saved profile details
    // Handles both old field IDs (co-*, cod-*) and new unified form (ch-*)
    prefillCheckout() {
      if (!currentUser && !currentProfile) return;
      const p = currentProfile || {};
      const vals = {
        // Unified checkout form — ALL fields including pincode/city/state
        'ch-name':  p.name,
        'ch-email': currentUser?.email,
        'ch-phone': p.phone,
        'ch-addr':  p.address,
        'ch-pin':   p.pincode,
        'ch-city':  p.city,
        'ch-state': p.state,
        // Legacy field IDs (kept for safety)
        'co-name':    p.name,  'co-email':   currentUser?.email,
        'co-phone':   p.phone, 'co-address': p.address,
        'cod-name':   p.name,  'cod-email':  currentUser?.email,
        'cod-phone':  p.phone, 'cod-address':p.address,
      };
      Object.entries(vals).forEach(([id, val]) => {
        const el = document.getElementById(id);
        if (el && val && !el.value) el.value = val;
      });
      // Update pincode display label if city/state filled
      if (p.pincode && p.city && p.state) {
        const pinMsg = document.getElementById('pinMsg');
        if (pinMsg && !pinMsg.textContent) {
          pinMsg.textContent = '✓ ' + p.city + ', ' + p.state;
          pinMsg.style.color = '#8fa87a';
        }
      }
      // Show saved address banner in checkout if user has full address
      if (p.name && p.phone && p.address && p.pincode) {
        showSavedAddressBanner(currentUser?.email, p);
      }
    },

    openAuthModal,
    openAccountModal,
    openMyOrders,
  };

  // ── Auto-login after order (called from checkout.js) ──────────────────────
  // Disabled intentionally: a customer must verify via Supabase email/password
  // or an emailed magic link before we create a browser session.
  window.autoLoginAfterOrder = async function (email, name, phone) {
    return;
  };

  // ── My Orders entry point ─────────────────────────────────────────────────
  // Logged-in: opens account modal on Orders tab
  // Guest: shows email-entry modal → sends magic link
  function openMyOrders() {
    if (currentUser) {
      openAccountModal();
      setTimeout(() => window.iacSwitchTab?.('acct-orders-tab'), 300);
    } else {
      openGuestOrdersModal();
    }
  }

  function openGuestOrdersModal() {
    removeModal('iacGuestOrdersModal');
    const modal = document.createElement('div');
    modal.id = 'iacGuestOrdersModal';
    modal.style.cssText = `
      position:fixed;inset:0;background:rgba(13,11,8,0.94);backdrop-filter:blur(10px);
      display:flex;align-items:center;justify-content:center;z-index:10010;padding:1.5rem;
    `;
    modal.innerHTML = `
      <div style="background:#1c1916;border:1px solid rgba(201,168,76,0.22);
                  width:min(420px,100%);padding:2.6rem;position:relative;">
        <button onclick="document.getElementById('iacGuestOrdersModal').remove()"
          style="position:absolute;top:1rem;right:1.2rem;background:none;border:none;
                 color:#a09080;font-size:1.3rem;cursor:pointer;line-height:1;">✕</button>

        <div style="font-size:0.55rem;letter-spacing:0.35em;text-transform:uppercase;
                    color:#c9a84c;margin-bottom:0.6rem;">My Orders</div>
        <h3 style="font-family:'Cormorant Garamond',serif;font-size:1.8rem;font-weight:300;
                   color:#faf7f2;margin-bottom:0.6rem;">Track your orders</h3>
        <p style="font-size:0.72rem;color:#a09080;margin-bottom:1.8rem;line-height:1.7;">
          Enter the email you used when placing your order. We'll send you a one-click login link.
        </p>

        <div style="margin-bottom:1rem;">
          <label for="guestOrderEmail" style="display:block;font-size:0.58rem;letter-spacing:0.18em;
                 text-transform:uppercase;color:#a09080;margin-bottom:0.45rem;">Email Address</label>
          <input id="guestOrderEmail" type="email" placeholder="you@example.com"
            style="width:100%;background:#141210;border:1px solid rgba(201,168,76,0.18);
                   color:#f0e8d8;padding:0.75rem 1rem;font-family:'Montserrat',sans-serif;
                   font-size:0.78rem;outline:none;"
            onfocus="this.style.borderColor='rgba(201,168,76,0.5)'"
            onblur="this.style.borderColor='rgba(201,168,76,0.18)'"
            onkeydown="if(event.key==='Enter') sendOrdersLink()" />
        </div>

        <button onclick="sendOrdersLink()"
          style="width:100%;font-family:'Montserrat',sans-serif;font-size:0.65rem;
                 letter-spacing:0.25em;text-transform:uppercase;padding:1rem;
                 background:#c9a84c;color:#0d0b08;border:none;cursor:pointer;font-weight:500;">
          Send Login Link →
        </button>
        <p id="guestOrderMsg" style="font-size:0.7rem;margin-top:0.9rem;min-height:1.2em;
           text-align:center;color:#6dbf6d;"></p>

        <p style="text-align:center;margin-top:1.4rem;font-size:0.7rem;color:#a09080;">
          Have a password?
          <button onclick="removeModal('iacGuestOrdersModal');openAuthModal()"
            style="background:none;border:none;color:#c9a84c;cursor:pointer;
                   font-family:'Montserrat',sans-serif;font-size:0.7rem;text-decoration:underline;margin-left:0.3rem;">
            Sign in instead
          </button>
        </p>
      </div>
    `;
    document.body.appendChild(modal);
    setTimeout(() => document.getElementById('guestOrderEmail')?.focus(), 80);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  }

  window.sendOrdersLink = async function () {
    const email = document.getElementById('guestOrderEmail')?.value.trim();
    const msg   = document.getElementById('guestOrderMsg');
    if (!email) { if (msg) { msg.style.color = '#e06060'; msg.textContent = 'Please enter your email.'; } return; }

    const sb = getSB();
    if (!sb) { if (msg) { msg.style.color = '#e06060'; msg.textContent = 'Auth not configured.'; } return; }

    if (msg) { msg.style.color = '#a09080'; msg.textContent = 'Sending 6-digit code…'; }
    try {
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/?orders=1`,
          shouldCreateUser: true,
        },
      });
      if (error) throw error;

      _otpEmail = email;
      // Replace the email input with OTP boxes inline
      const container = document.getElementById('guestOrderEmail')?.closest('div') || null;
      if (container) {
        container.innerHTML = `
          <p style="font-size:.7rem;color:#a09080;margin-bottom:.8rem;">Enter the 6-digit code sent to <strong style="color:#c9a84c">${email}</strong></p>
          <div style="display:flex;gap:.5rem;margin-bottom:.8rem;">
            ${[0,1,2,3,4,5].map(i => `
              <input id="guestOtp${i}" type="text" inputmode="numeric" maxlength="1"
                style="width:40px;height:48px;text-align:center;font-size:1.3rem;font-weight:600;
                       background:var(--bg3,#1c1916);border:1px solid rgba(201,168,76,0.25);
                       color:var(--cream,#f0e8d8);font-family:'Montserrat',sans-serif;outline:none;"
                onfocus="this.style.borderColor='rgba(201,168,76,0.7)'"
                onblur="this.style.borderColor='rgba(201,168,76,0.25)'"
                oninput="(function(el,i){el.value=el.value.replace(/\\D/g,'').slice(-1);if(el.value&&i<5)document.getElementById('guestOtp'+(i+1))?.focus();const c=[0,1,2,3,4,5].map(j=>document.getElementById('guestOtp'+j)?.value||'').join('');if(c.length===6)verifyGuestOtp();})(this,${i})"
                onkeydown="if(event.key==='Backspace'&&!this.value&&${i}>0)document.getElementById('guestOtp'+(${i}-1))?.focus()"/>
            `).join('')}
          </div>
          <button onclick="verifyGuestOtp()"
            style="width:100%;padding:.8rem;background:#c9a84c;color:#0d0b08;
                   font-family:'Montserrat',sans-serif;font-size:.62rem;letter-spacing:.2em;
                   text-transform:uppercase;border:none;cursor:pointer;font-weight:600;">
            Verify Code →
          </button>
          <p id="guestOtpMsg" style="font-size:.68rem;color:#e06060;margin-top:.5rem;min-height:1em;"></p>`;
        document.getElementById('guestOtp0')?.focus();

        window.verifyGuestOtp = async function() {
          const code = [0,1,2,3,4,5].map(i => document.getElementById('guestOtp'+i)?.value||'').join('');
          const gmsg = document.getElementById('guestOtpMsg');
          if (code.length < 6) { if(gmsg){gmsg.textContent='Enter all 6 digits.';} return; }
          const { data, error: vErr } = await sb.auth.verifyOtp({ email: _otpEmail, token: code, type: 'email' });
          if (vErr) { if(gmsg){gmsg.textContent=vErr.message||'Invalid code. Try again.';} return; }
          currentUser = data.user;
          await fetchProfile();
          updateNav();
          removeModal('iacGuestOrderModal');
          openAccountModal();
          setTimeout(() => window.iacSwitchTab?.('acct-orders-tab'), 300);
        };
      } else if (msg) {
        msg.style.color = '#6dbf6d';
        msg.textContent = 'Code sent! Check your email.';
      }

    } catch (e) {
      if (msg) { msg.style.color = '#e06060'; msg.textContent = e.message || 'Could not send login link. Please try again.'; }
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // AUTH MODAL — OTP-based (passwordless)
  // Step 1: enter email → send 6-digit code
  // Step 2: enter code → verified & signed in
  // ─────────────────────────────────────────────────────────────────────────

  // Shared state across steps
  let _otpEmail = '';

  function openAuthModal() {
    removeModal('iacAuthModal');
    const modal = document.createElement('div');
    modal.id = 'iacAuthModal';
    modal.style.cssText = `
      position:fixed;inset:0;background:rgba(13,11,8,0.94);backdrop-filter:blur(10px);
      display:flex;align-items:center;justify-content:center;z-index:10010;padding:1rem;
    `;
    modal.innerHTML = `
      <div id="iacAuthBox" style="
        background:#1c1916;border:1px solid rgba(201,168,76,0.22);
        width:min(420px,100%);padding:2.4rem;position:relative;
      ">
        <button onclick="document.getElementById('iacAuthModal').remove()"
          style="position:absolute;top:1rem;right:1.2rem;background:none;border:none;
                 color:#a09080;font-size:1.3rem;cursor:pointer;line-height:1;">✕</button>
        <div id="iacAuthInner"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    renderPasswordStep();
  }

  function renderOtpStep1() {
    const inner = document.getElementById('iacAuthInner');
    if (!inner) return;
    inner.innerHTML = `
      <div style="font-size:.55rem;letter-spacing:.35em;text-transform:uppercase;color:#c9a84c;margin-bottom:.5rem;">Ink &amp; Chai</div>
      <h3 style="font-family:'Cormorant Garamond',serif;font-size:1.9rem;font-weight:300;color:#faf7f2;margin-bottom:.4rem;">Sign in</h3>
      <p style="font-size:.68rem;color:#a09080;margin-bottom:1.8rem;line-height:1.6;">We'll send a 6-digit code to your email. No password needed.</p>

      <label for="iacOtpEmail" style="display:block;font-size:.55rem;letter-spacing:.18em;text-transform:uppercase;color:#a09080;margin-bottom:.4rem;">Email address</label>
      <input id="iacOtpEmail" type="email" placeholder="you@example.com" autocomplete="email"
        onkeydown="if(event.key==='Enter')iacSendOtp()"
        style="width:100%;background:#141210;border:1px solid rgba(201,168,76,0.18);color:#f0e8d8;
               padding:.75rem 1rem;font-family:'Montserrat',sans-serif;font-size:16px;outline:none;
               margin-bottom:1rem;"
        onfocus="this.style.borderColor='rgba(201,168,76,0.5)'"
        onblur="this.style.borderColor='rgba(201,168,76,0.18)'"/>

      <button onclick="iacSendOtp()" id="iacOtpSendBtn"
        style="width:100%;padding:.95rem;background:#c9a84c;color:#0d0b08;font-family:'Montserrat',sans-serif;
               font-size:.65rem;letter-spacing:.25em;text-transform:uppercase;border:none;cursor:pointer;font-weight:600;">
        Send Code →
      </button>
      <p id="iacOtpMsg" style="font-size:.7rem;color:#e06060;margin-top:.75rem;min-height:1.1em;text-align:center;line-height:1.5;"></p>

      <p style="text-align:center;margin-top:.6rem;font-size:.66rem;color:#a09080;">
        Have a password?
        <button onclick="renderPasswordStep()" style="background:none;border:none;color:#c9a84c;cursor:pointer;
          font-family:'Montserrat',sans-serif;font-size:.66rem;text-decoration:underline;margin-left:.3rem;">
          Sign in with password →
        </button>
      </p>
    `;
    setTimeout(() => document.getElementById('iacOtpEmail')?.focus(), 50);
  }

  function renderPasswordStep() {
    const inner = document.getElementById('iacAuthInner');
    if (!inner) return;
    inner.innerHTML = `
      <div style="font-size:.55rem;letter-spacing:.35em;text-transform:uppercase;color:#c9a84c;margin-bottom:.5rem;">Ink &amp; Chai</div>
      <h3 style="font-family:'Cormorant Garamond',serif;font-size:1.9rem;font-weight:300;color:#faf7f2;margin-bottom:.4rem;">Sign in</h3>
      <p style="font-size:.68rem;color:#a09080;margin-bottom:1.6rem;line-height:1.6;">Welcome back. Enter your email and password to continue.</p>

      <label for="iacPwEmail" style="display:block;font-size:.55rem;letter-spacing:.18em;text-transform:uppercase;color:#a09080;margin-bottom:.4rem;">Email address</label>
      <input id="iacPwEmail" type="email" placeholder="you@example.com" autocomplete="email"
        onkeydown="if(event.key==='Enter')document.getElementById('iacPwPassword')?.focus()"
        style="width:100%;background:#141210;border:1px solid rgba(201,168,76,0.18);color:#f0e8d8;
               padding:.75rem 1rem;font-family:'Montserrat',sans-serif;font-size:16px;outline:none;
               margin-bottom:.85rem;"
        onfocus="this.style.borderColor='rgba(201,168,76,0.5)'"
        onblur="this.style.borderColor='rgba(201,168,76,0.18)'"/>

      <label for="iacPwPassword" style="display:block;font-size:.55rem;letter-spacing:.18em;text-transform:uppercase;color:#a09080;margin-bottom:.4rem;">Password</label>
      <input id="iacPwPassword" type="password" placeholder="Your password" autocomplete="current-password"
        onkeydown="if(event.key==='Enter')iacSignInWithPassword()"
        style="width:100%;background:#141210;border:1px solid rgba(201,168,76,0.18);color:#f0e8d8;
               padding:.75rem 1rem;font-family:'Montserrat',sans-serif;font-size:16px;outline:none;
               margin-bottom:1rem;"
        onfocus="this.style.borderColor='rgba(201,168,76,0.5)'"
        onblur="this.style.borderColor='rgba(201,168,76,0.18)'"/>

      <button onclick="iacSignInWithPassword()" id="iacPwSignInBtn"
        style="width:100%;padding:.95rem;background:#c9a84c;color:#0d0b08;font-family:'Montserrat',sans-serif;
               font-size:.65rem;letter-spacing:.25em;text-transform:uppercase;border:none;cursor:pointer;font-weight:600;">
        Sign In →
      </button>
      <p id="iacPwMsg" style="font-size:.7rem;color:#e06060;margin-top:.75rem;min-height:1.1em;text-align:center;line-height:1.5;"></p>

      <p style="text-align:center;margin-top:.6rem;font-size:.66rem;color:#a09080;">
        <button onclick="iacForgotPassword()" style="background:none;border:none;color:#c9a84c;cursor:pointer;
          font-family:'Montserrat',sans-serif;font-size:.66rem;text-decoration:underline;">
          Forgot password?
        </button>
        &nbsp;·&nbsp;
        <button onclick="renderOtpStep1()" style="background:none;border:none;color:#c9a84c;cursor:pointer;
          font-family:'Montserrat',sans-serif;font-size:.66rem;text-decoration:underline;">
          Use OTP instead
        </button>
      </p>
    `;
    setTimeout(() => document.getElementById('iacPwEmail')?.focus(), 50);
  }

  // Expose render helpers to global scope (called from inline onclick)
  window.renderPasswordStep = function () { renderPasswordStep(); };
  window.renderOtpStep1     = function () { renderOtpStep1(); };

  window.iacSignInWithPassword = async function () {
    const email    = document.getElementById('iacPwEmail')?.value.trim() || '';
    const password = document.getElementById('iacPwPassword')?.value || '';
    const msg      = document.getElementById('iacPwMsg');
    const btn      = document.getElementById('iacPwSignInBtn');

    if (!email || !/\S+@\S+\.\S+/.test(email)) {
      if (msg) { msg.style.color = '#e06060'; msg.textContent = 'Please enter a valid email address.'; }
      return;
    }
    if (!password) {
      if (msg) { msg.style.color = '#e06060'; msg.textContent = 'Please enter your password.'; }
      return;
    }

    const sb = getSB();
    if (!sb) { if (msg) { msg.style.color = '#e06060'; msg.textContent = 'Auth not available.'; } return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
    if (msg) { msg.textContent = ''; }

    try {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;

      currentUser = data.user;
      await fetchProfile();
      updateNav();

      const box = document.getElementById('iacAuthBox');
      if (box) {
        box.innerHTML = `
          <div style="text-align:center;padding:2rem 1rem;">
            <div style="font-size:2.5rem;margin-bottom:1rem;">✓</div>
            <h3 style="font-family:'Cormorant Garamond',serif;font-size:1.8rem;font-weight:300;color:#faf7f2;margin-bottom:.5rem;">
              ${currentProfile?.name ? 'Welcome, ' + currentProfile.name.split(' ')[0] + '!' : 'Signed in!'}
            </h3>
            <p style="font-size:.7rem;color:#a09080;">Redirecting…</p>
          </div>`;
      }
      setTimeout(() => removeModal('iacAuthModal'), 1200);

    } catch (e) {
      if (msg) {
        msg.style.color = '#e06060';
        msg.textContent = /invalid|credentials|wrong/i.test(e.message)
          ? 'Incorrect email or password. Try again.'
          : (e.message || 'Sign in failed. Please try again.');
      }
      if (btn) { btn.disabled = false; btn.textContent = 'Sign In →'; }
    }
  };

  window.iacForgotPassword = async function() {
    const email = document.getElementById('iacPwEmail')?.value.trim() || '';
    const msg   = document.getElementById('iacPwMsg');
    if (!email || !/\S+@\S+\.\S+/.test(email)) {
      if (msg) { msg.style.color='#e06060'; msg.textContent='Enter your email above first, then click Forgot password.'; }
      return;
    }
    const sb = getSB();
    if (!sb) return;
    if (msg) { msg.style.color='#a09080'; msg.textContent='Sending reset link…'; }
    try {
      const { error } = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: 'https://inkandchai.in/account/',
      });
      if (error) throw error;
      if (msg) { msg.style.color='#6dbf6d'; msg.textContent='✓ Password reset link sent! Check your inbox (and spam folder).'; }
    } catch(e) {
      if (msg) { msg.style.color='#e06060'; msg.textContent = e.message || 'Could not send reset email. Try OTP login instead.'; }
    }
  };

  function renderOtpStep2(email) {
    const inner = document.getElementById('iacAuthInner');
    if (!inner) return;
    inner.innerHTML = `
      <div style="font-size:.55rem;letter-spacing:.35em;text-transform:uppercase;color:#c9a84c;margin-bottom:.5rem;">Ink &amp; Chai</div>
      <h3 style="font-family:'Cormorant Garamond',serif;font-size:1.9rem;font-weight:300;color:#faf7f2;margin-bottom:.4rem;">Enter code</h3>
      <p style="font-size:.68rem;color:#a09080;margin-bottom:.3rem;line-height:1.6;">We sent a 6-digit code to</p>
      <p style="font-size:.75rem;color:#c9a84c;margin-bottom:1.8rem;font-weight:500;">${email}</p>

      <div id="iacOtpBoxes" style="display:flex;gap:.6rem;justify-content:center;margin-bottom:1.4rem;">
        ${[0,1,2,3,4,5].map(i => `
          <input id="iacOtp${i}" type="text" inputmode="numeric" maxlength="1"
            style="width:48px;height:56px;text-align:center;font-size:1.4rem;font-weight:600;
                   background:#141210;border:1px solid rgba(201,168,76,0.25);color:#f0e8d8;
                   font-family:'Montserrat',sans-serif;outline:none;border-radius:0;"
            onfocus="this.style.borderColor='rgba(201,168,76,0.7)'"
            onblur="this.style.borderColor='rgba(201,168,76,0.25)'"
            oninput="iacOtpInput(this,${i})"
            onkeydown="iacOtpKey(event,${i})"/>`
        ).join('')}
      </div>

      <button onclick="iacVerifyOtp()" id="iacOtpVerifyBtn"
        style="width:100%;padding:.95rem;background:#c9a84c;color:#0d0b08;font-family:'Montserrat',sans-serif;
               font-size:.65rem;letter-spacing:.25em;text-transform:uppercase;border:none;cursor:pointer;font-weight:600;">
        Verify →
      </button>
      <p id="iacOtpMsg" style="font-size:.7rem;color:#e06060;margin-top:.75rem;min-height:1.1em;text-align:center;"></p>
      <p style="text-align:center;margin-top:1rem;font-size:.66rem;color:#a09080;">
        Wrong email?
        <button onclick="renderOtpStep1()" style="background:none;border:none;color:#c9a84c;cursor:pointer;
          font-family:'Montserrat',sans-serif;font-size:.66rem;text-decoration:underline;margin-left:.3rem;">
          Go back
        </button>
        &nbsp;·&nbsp;
        <button id="iacOtpResendBtn" onclick="iacSendOtp(true)" style="background:none;border:none;color:#c9a84c;cursor:pointer;
          font-family:'Montserrat',sans-serif;font-size:.66rem;text-decoration:underline;">
          Resend
        </button>
      </p>
    `;
    setTimeout(() => {
      document.getElementById('iacOtp0')?.focus();
      // Start cooldown immediately — code was just sent to get here
      startOtpCooldown('iacOtpResendBtn', 'iacOtpMsg');
    }, 50);
  }

  // OTP box keyboard handling — auto-advance, backspace, paste
  window.iacOtpInput = function(el, idx) {
    el.value = el.value.replace(/\D/g, '').slice(-1);
    if (el.value && idx < 5) document.getElementById('iacOtp' + (idx + 1))?.focus();
    // Auto-verify when all 6 filled
    const code = [0,1,2,3,4,5].map(i => document.getElementById('iacOtp'+i)?.value||'').join('');
    if (code.length === 6) iacVerifyOtp();
  };

  window.iacOtpKey = function(e, idx) {
    if (e.key === 'Backspace' && !e.target.value && idx > 0) {
      document.getElementById('iacOtp' + (idx - 1))?.focus();
    }
    // Handle paste on any box
    if (e.key === 'v' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      navigator.clipboard?.readText().then(text => {
        const digits = text.replace(/\D/g,'').slice(0,6);
        digits.split('').forEach((d,i) => {
          const box = document.getElementById('iacOtp'+i);
          if (box) box.value = d;
        });
        document.getElementById('iacOtp5')?.focus();
        if (digits.length === 6) iacVerifyOtp();
      });
    }
  };

  // Track last OTP send time to enforce client-side cooldown
  let _otpLastSentAt = 0;
  const OTP_COOLDOWN_SEC = 60;

  function startOtpCooldown(btnId, msgId) {
    const end = Date.now() + OTP_COOLDOWN_SEC * 1000;
    const tick = () => {
      const btn = document.getElementById(btnId);
      const msg = document.getElementById(msgId);
      const secsLeft = Math.ceil((end - Date.now()) / 1000);
      if (secsLeft <= 0) {
        if (btn) { btn.disabled = false; btn.textContent = btnId === 'iacOtpSendBtn' ? 'Send Code →' : 'Resend'; }
        if (msg && msg.dataset.cooldown) { msg.textContent = ''; delete msg.dataset.cooldown; }
        return;
      }
      if (btn) { btn.disabled = true; btn.textContent = `Wait ${secsLeft}s`; }
      if (msg) { msg.dataset.cooldown = '1'; msg.style.color = '#a09080'; msg.textContent = `Code sent — check your inbox. You can resend in ${secsLeft}s.`; }
      setTimeout(tick, 1000);
    };
    tick();
  }

  window.iacSendOtp = async function(resend = false) {
    const emailEl = resend ? null : document.getElementById('iacOtpEmail');
    const email   = resend ? _otpEmail : (emailEl?.value.trim() || '');
    const msg     = document.getElementById('iacOtpMsg');
    const btn     = document.getElementById(resend ? 'iacOtpResendBtn' : 'iacOtpSendBtn');

    if (!email || !/\S+@\S+\.\S+/.test(email)) {
      if (msg) { msg.style.color='#e06060'; msg.textContent='Please enter a valid email address.'; }
      return;
    }

    // Client-side cooldown — prevent spam clicking
    const secsSinceLast = (Date.now() - _otpLastSentAt) / 1000;
    if (secsSinceLast < OTP_COOLDOWN_SEC) {
      const wait = Math.ceil(OTP_COOLDOWN_SEC - secsSinceLast);
      if (msg) { msg.style.color='#e06060'; msg.textContent=`Please wait ${wait}s before requesting another code.`; }
      return;
    }

    const sb = getSB();
    if (!sb) { if (msg) { msg.style.color='#e06060'; msg.textContent='Auth not available.'; } return; }

    if (btn) { btn.disabled=true; btn.textContent='Sending…'; }
    if (msg) { msg.style.color='#a09080'; msg.textContent=''; }

    try {
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true },
      });
      if (error) throw error;

      _otpEmail = email;
      _otpLastSentAt = Date.now();

      if (!resend) {
        renderOtpStep2(email); // step 2 render starts its own cooldown on Resend
      } else {
        // Clear boxes and start cooldown on resend button
        [0,1,2,3,4,5].forEach(i => { const b = document.getElementById('iacOtp'+i); if(b) b.value=''; });
        document.getElementById('iacOtp0')?.focus();
        startOtpCooldown('iacOtpResendBtn', 'iacOtpMsg');
      }
    } catch(e) {
      const isRateLimit = /rate.limit|too.many|wait/i.test(e.message || '');
      if (msg) {
        msg.style.color='#e06060';
        msg.textContent = isRateLimit
          ? 'Too many attempts. Please wait a minute before trying again.'
          : (e.message || 'Could not send code. Try again.');
      }
      if (btn) { btn.disabled=false; btn.textContent = resend ? 'Resend' : 'Send Code →'; }
    }
  };

  window.iacVerifyOtp = async function() {
    const code = [0,1,2,3,4,5].map(i => document.getElementById('iacOtp'+i)?.value||'').join('');
    const msg  = document.getElementById('iacOtpMsg');
    const btn  = document.getElementById('iacOtpVerifyBtn');

    if (code.length < 6) {
      if (msg) { msg.style.color='#e06060'; msg.textContent='Please enter all 6 digits.'; }
      return;
    }

    const sb = getSB();
    if (!sb || !_otpEmail) return;

    if (btn) { btn.disabled=true; btn.textContent='Verifying…'; }
    if (msg) { msg.textContent=''; }

    try {
      const { data, error } = await sb.auth.verifyOtp({
        email: _otpEmail,
        token: code,
        type: 'email',
      });
      if (error) throw error;

      currentUser = data.user;
      await fetchProfile();
      updateNav();

      // Success animation
      const box = document.getElementById('iacAuthBox');
      if (box) {
        box.innerHTML = `
          <div style="text-align:center;padding:2rem 1rem;">
            <div style="font-size:2.5rem;margin-bottom:1rem;">✓</div>
            <h3 style="font-family:'Cormorant Garamond',serif;font-size:1.8rem;font-weight:300;color:#faf7f2;margin-bottom:.5rem;">
              ${currentProfile?.name ? 'Welcome, ' + currentProfile.name.split(' ')[0] + '!' : 'Signed in!'}
            </h3>
            <p style="font-size:.7rem;color:#a09080;">Redirecting…</p>
          </div>`;
      }
      setTimeout(() => removeModal('iacAuthModal'), 1200);

    } catch(e) {
      const isExpired = /expired|invalid/i.test(e.message || '');
      if (msg) {
        msg.style.color='#e06060';
        msg.textContent = isExpired ? 'Code expired or invalid. Request a new one.' : (e.message || 'Verification failed.');
      }
      if (btn) { btn.disabled=false; btn.textContent='Verify →'; }
      // Shake the boxes
      [0,1,2,3,4,5].forEach(i => {
        const b = document.getElementById('iacOtp'+i);
        if(b) { b.style.borderColor='rgba(220,80,80,0.7)'; b.value=''; }
      });
      document.getElementById('iacOtp0')?.focus();
    }
  };

  // Keep iacToggleMode as no-op for any lingering references
  window.iacToggleMode = function() {};
  window.iacSubmit     = function() {};
  window.iacResendSignupEmail = function() {};

  window.iacResendSignupEmail = async function () {
    const sb = getSB();
    const msg = document.getElementById('iacAuthMsg');
    const email = document.getElementById('iacEmail')?.value.trim();
    const password = document.getElementById('iacPassword')?.value || '';
    const name = document.getElementById('iacFullName')?.value.trim() || '';
    const phone = document.getElementById('iacPhone')?.value.trim() || '';
    if (!sb || !email) {
      if (msg) {
        msg.style.color = '#e06060';
        msg.textContent = 'Please enter your email first.';
      }
      return;
    }
    if (!password || password.length < 6) {
      if (msg) {
        msg.style.color = '#e06060';
        msg.textContent = 'Please enter your password first so we can send the secure account link.';
      }
      return;
    }
    if (msg) {
      msg.style.color = '#a09080';
      msg.textContent = 'Sending confirmation email again...';
    }
    let error = null;
    let message = 'Confirmation email sent again. Please check inbox and spam.';
    try {
      const res = await fetch('/.netlify/functions/signup-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          name,
          phone,
          redirectTo: `${window.location.origin}/`,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not resend confirmation email.');
      message = json.message || message;
    } catch (e) {
      error = e;
    }
    if (msg) {
      if (error) {
        msg.style.color = '#e06060';
        msg.textContent = error.message || 'Could not resend confirmation email.';
      } else {
        msg.style.color = '#6dbf6d';
        msg.textContent = message;
      }
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // ACCOUNT MODAL (Profile + Order History)
  // ─────────────────────────────────────────────────────────────────────────
  function openAccountModal() {
    removeModal('iacAccountModal');
    const modal = document.createElement('div');
    modal.id = 'iacAccountModal';
    modal.style.cssText = `
      position:fixed;inset:0;background:rgba(13,11,8,0.94);backdrop-filter:blur(10px);
      display:flex;align-items:flex-start;justify-content:center;z-index:10010;overflow-y:auto;
      padding:4rem 1rem;
    `;
    const email = currentUser?.email || '';
    const name  = currentProfile?.name  || '';
    const phone = currentProfile?.phone || '';
    const addr  = currentProfile?.address || '';

    modal.innerHTML = `
      <div style="
        background:#1c1916;border:1px solid rgba(201,168,76,0.22);
        width:min(600px,96vw);padding:2.6rem;position:relative;
      ">
        <button onclick="document.getElementById('iacAccountModal').remove()"
          style="position:absolute;top:1rem;right:1.2rem;background:none;border:none;
                 color:#a09080;font-size:1.3rem;cursor:pointer;">✕</button>

        <div style="font-size:0.58rem;letter-spacing:0.35em;text-transform:uppercase;color:#c9a84c;margin-bottom:0.5rem;">
          My Account
        </div>
        <h3 style="font-family:'Cormorant Garamond',serif;font-size:1.9rem;font-weight:300;
               color:#faf7f2;margin-bottom:2rem;">
          ${name || email}
        </h3>

        <!-- Tabs -->
        <div style="display:flex;gap:0;border-bottom:1px solid rgba(201,168,76,0.18);margin-bottom:2rem;">
          ${acctTab('acct-profile-tab', 'Profile',   true)}
          ${acctTab('acct-orders-tab',  'My Orders', false)}
        </div>

        <!-- Profile panel -->
        <div id="acct-profile-panel">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
            <div style="grid-column:span 2">
              ${acctField('acct-name',    'text',  'Full Name',         name)}
            </div>
            ${acctField('acct-phone',   'tel',   'Phone Number',      phone)}
            ${acctField('acct-email',   'email', 'Email',             email, true)}
            <div style="grid-column:span 2">
              ${acctField('acct-address','text',  'Default Address',   addr)}
            </div>
          </div>
          <button onclick="iacSaveProfile()"
            style="margin-top:1.2rem;font-family:'Montserrat',sans-serif;font-size:0.62rem;
                   letter-spacing:0.22em;text-transform:uppercase;padding:0.85rem 2rem;
                   background:#c9a84c;color:#0d0b08;border:none;cursor:pointer;font-weight:500;">
            Save Details →
          </button>
          <p id="acct-profile-msg" style="font-size:0.7rem;margin-top:0.8rem;min-height:1.2em;"></p>
          <div style="margin-top:2rem;padding-top:1.5rem;border-top:1px solid rgba(201,168,76,0.12);">
            <button onclick="iacSignOut()"
              style="font-family:'Montserrat',sans-serif;font-size:0.58rem;letter-spacing:0.2em;
                     text-transform:uppercase;padding:0.65rem 1.4rem;border:1px solid rgba(160,144,128,0.3);
                     color:#a09080;background:transparent;cursor:pointer;">
              Sign Out
            </button>
          </div>
        </div>

        <!-- Orders panel -->
        <div id="acct-orders-panel" style="display:none;">
          <div id="acct-orders-content">
            <p style="color:#a09080;font-size:0.78rem;">Loading your orders…</p>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  }

  function acctTab(id, label, active) {
    return `
      <button id="${id}" onclick="iacSwitchTab('${id}')"
        style="font-family:'Montserrat',sans-serif;font-size:0.62rem;letter-spacing:0.18em;
               text-transform:uppercase;padding:0.5rem 1.4rem 0.8rem;cursor:pointer;
               border:none;border-bottom:2px solid ${active ? '#c9a84c' : 'transparent'};
               color:${active ? '#c9a84c' : '#a09080'};background:none;margin-bottom:-1px;
               transition:all 0.2s;">${label}</button>`;
  }

  function acctField(id, type, label, value, disabled = false) {
    return `
      <div>
        <label for="${id}" style="display:block;font-size:0.58rem;letter-spacing:0.18em;
               text-transform:uppercase;color:#a09080;margin-bottom:0.4rem;">${label}</label>
        <input id="${id}" type="${type}" value="${escHtmlAttr(value)}" ${disabled ? 'disabled' : ''}
          style="width:100%;background:${disabled ? '#111' : '#141210'};border:1px solid rgba(201,168,76,0.18);
                 color:${disabled ? '#7a6330' : '#f0e8d8'};padding:0.7rem 1rem;
                 font-family:'Montserrat',sans-serif;font-size:0.78rem;outline:none;"
          onfocus="this.style.borderColor='rgba(201,168,76,0.5)'"
          onblur="this.style.borderColor='rgba(201,168,76,0.18)'"/>
      </div>`;
  }

  window.iacSwitchTab = function (tabId) {
    document.querySelectorAll('#iacAccountModal button[id^="acct-"]').forEach(b => {
      b.style.borderBottomColor = 'transparent';
      b.style.color = '#a09080';
    });
    const tab = document.getElementById(tabId);
    if (tab) { tab.style.borderBottomColor = '#c9a84c'; tab.style.color = '#c9a84c'; }

    document.getElementById('acct-profile-panel').style.display = tabId === 'acct-profile-tab' ? '' : 'none';
    document.getElementById('acct-orders-panel').style.display  = tabId === 'acct-orders-tab'  ? '' : 'none';

    if (tabId === 'acct-orders-tab') loadMyOrders();
  };

  window.iacSaveProfile = async function () {
    const sb = getSB();
    if (!sb || !currentUser) return;

    const name    = document.getElementById('acct-name')?.value.trim()    || '';
    const phone   = document.getElementById('acct-phone')?.value.trim()   || '';
    const address = document.getElementById('acct-address')?.value.trim() || '';
    const msg     = document.getElementById('acct-profile-msg');

    const { error } = await sb.from('profiles').upsert({
      id: currentUser.id, name, phone, address, updated_at: new Date().toISOString(),
    });

    if (error) {
      msg.style.color = '#e06060';
      msg.textContent = 'Could not save: ' + error.message;
    } else {
      currentProfile = { ...currentProfile, name, phone, address };
      msg.style.color = '#6dbf6d';
      msg.textContent = '✓ Details saved!';
      updateNav();
      setTimeout(() => { if (msg) msg.textContent = ''; }, 3000);
    }
  };

  window.iacSignOut = async function () {
    const sb = getSB();
    if (sb) await sb.auth.signOut();
    try { sessionStorage.removeItem(PROFILE_CACHE_KEY); sessionStorage.removeItem(ORDERS_CACHE_KEY); } catch(e) {}
    currentUser = null;
    currentProfile = null;
    removeModal('iacAccountModal');
    updateNav();
    if (window.showToast) showToast('Signed out.');
  };

  // ── My Orders (loads orders via Netlify function to bypass RLS) ──────────
  const ORDERS_CACHE_KEY = 'iac_orders_cache';
  const ORDERS_CACHE_TTL = 60_000; // 60 seconds

  async function loadMyOrders() {
    const container = document.getElementById('acct-orders-content');
    if (!container) return;
    const sb = getSB();
    if (!sb || !currentUser) {
      container.innerHTML = '<p style="color:#a09080;font-size:0.78rem;">Please sign in to view your orders.</p>';
      return;
    }

    // Show cached orders instantly while fetching fresh data
    let orders = [];
    try {
      const cached = JSON.parse(sessionStorage.getItem(ORDERS_CACHE_KEY) || 'null');
      if (cached && cached.uid === currentUser.id && Date.now() - cached.ts < ORDERS_CACHE_TTL) {
        orders = cached.orders;
        // Render immediately from cache — still fetches fresh in background
        renderOrders(container, orders);
      }
    } catch(e) {}

    if (!orders.length) {
      container.innerHTML = `
        <div style="text-align:center;padding:2rem;">
          <div style="font-size:1.5rem;margin-bottom:0.8rem;opacity:0.5;">⟳</div>
          <p style="color:#a09080;font-size:0.75rem;letter-spacing:0.08em;">Loading orders…</p>
        </div>`;
    }

    // Get current access token to pass to the function
    const { data: { session } } = await sb.auth.getSession();
    const token = session?.access_token || '';

    try {
      const res = await fetch(
        `/.netlify/functions/get-my-orders`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load orders');
      orders = json.orders || [];
      // Cache for next open
      try { sessionStorage.setItem(ORDERS_CACHE_KEY, JSON.stringify({ uid: currentUser.id, ts: Date.now(), orders })); } catch(e) {}
    } catch (err) {
      if (!orders.length) {
        container.innerHTML = `<p style="color:#e06060;font-size:0.78rem;">Could not load orders: ${err.message}</p>`;
      }
      return;
    }

    renderOrders(container, orders);
  }

  function renderOrders(container, data) {
    if (!data?.length) {
      container.innerHTML = `
        <div style="text-align:center;padding:3rem 1rem;">
          <div style="font-size:2.5rem;margin-bottom:1rem;opacity:0.4;">📚</div>
          <p style="color:#a09080;font-size:0.78rem;line-height:1.8;">No orders yet.<br/>
            <a href="/" style="color:#c9a84c;">Browse books →</a>
          </p>
        </div>`;
      return;
    }

    container.innerHTML = data.map(o => {
      const date   = new Date(o.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
      const amount = o.amount_paise ? '₹' + (o.amount_paise / 100).toLocaleString('en-IN') : '—';
      const items  = Array.isArray(o.cart_items) ? o.cart_items : [];

      // Complete status colour map — covers every status the NimbusPost webhook can set
      const statusColor = {
        // Payment states
        pending:              '#a09080',
        paid:                 '#6dbf6d',
        confirmed:            '#c9a84c',
        cod_pending:          '#e8a030',
        partial_cod_pending:  '#e8a030',
        pending_phonepe:      '#a09080',
        // Shipping progression
        shipped:              '#c9a84c',
        out_for_delivery:     '#4db8ff',   // bright blue — action needed for COD
        delivered:            '#6dbf6d',
        // Problem states
        undelivered:          '#e8a030',
        rto:                  '#e06060',
        lost:                 '#e06060',
        cancelled:            '#e06060',
        refunded:             '#a09080',
      }[o.status] || '#a09080';

      // Human-readable label — replace ALL underscores, add emoji for key states
      const STATUS_LABEL = {
        pending:              'Pending',
        paid:                 '✅ Paid',
        confirmed:            'Confirmed',
        cod_pending:          'COD — Pay on Delivery',
        partial_cod_pending:  'Partial COD — Pay Balance on Delivery',
        pending_phonepe:      'Awaiting Payment',
        shipped:              '📦 Shipped',
        out_for_delivery:     '🚚 Out for Delivery',
        delivered:            '✅ Delivered',
        undelivered:          '⚠️ Delivery Attempted',
        rto:                  '↩ Returning to Sender',
        lost:                 '⚠️ Lost in Transit',
        cancelled:            '✕ Cancelled',
        refunded:             '↩ Refunded',
      };
      const statusLabel = STATUS_LABEL[o.status] || (o.status || 'Pending').replace(/_/g, ' ');

      return `
        <div style="border:1px solid rgba(201,168,76,0.14);margin-bottom:1.2rem;padding:1.4rem;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;
                      margin-bottom:1rem;flex-wrap:wrap;gap:0.5rem;">
            <div>
              <div style="font-size:0.6rem;letter-spacing:0.18em;text-transform:uppercase;
                          color:#a09080;margin-bottom:0.2rem;">${date}</div>
              <div style="font-size:0.65rem;color:#7a6330;letter-spacing:0.04em;
                          font-family:'Montserrat',sans-serif;">${o.razorpay_order_id}</div>
            </div>
            <div style="display:flex;gap:0.8rem;align-items:center;flex-wrap:wrap;">
              <span style="font-family:'Cormorant Garamond',serif;font-size:1.3rem;color:#c9a84c;">
                ${amount}
              </span>
              <span style="font-size:0.52rem;letter-spacing:0.2em;text-transform:uppercase;
                     padding:0.3rem 0.75rem;border:1px solid ${statusColor};color:${statusColor};">
                ${statusLabel}
              </span>
            </div>
          </div>
          ${items.slice(0, 4).map(i => `
            <div style="display:flex;gap:0.9rem;align-items:center;padding:0.6rem 0;
                        border-top:1px solid rgba(201,168,76,0.08);">
              ${i.img
                ? `<img src="${escHtmlAttr(i.img)}" style="width:40px;height:58px;object-fit:cover;
                         border:1px solid rgba(201,168,76,0.12);flex-shrink:0;" alt="" />`
                : `<div style="width:40px;height:58px;background:#141210;flex-shrink:0;
                               border:1px solid rgba(201,168,76,0.1);"></div>`}
              <div style="flex:1;min-width:0;">
                <div style="font-size:0.8rem;color:#f0e8d8;white-space:nowrap;overflow:hidden;
                            text-overflow:ellipsis;margin-bottom:0.2rem;">${escHtml(i.title || '')}</div>
                <div style="font-size:0.62rem;color:#a09080;">
                  Qty: ${i.qty} &nbsp;·&nbsp; ₹${(i.price * i.qty).toLocaleString('en-IN')}
                </div>
              </div>
            </div>`).join('')}
          ${items.length > 4
            ? `<div style="font-size:0.62rem;color:#7a6330;margin-top:0.5rem;padding-top:0.5rem;
                           border-top:1px solid rgba(201,168,76,0.08);">
                 +${items.length - 4} more item${items.length - 4 > 1 ? 's' : ''}
               </div>` : ''}
          ${o.customer_address
            ? `<div style="margin-top:0.8rem;padding-top:0.8rem;border-top:1px solid rgba(201,168,76,0.08);
                           font-size:0.62rem;color:#a09080;line-height:1.6;">
                 <span style="color:#7a6330;text-transform:uppercase;letter-spacing:0.1em;
                              font-size:0.55rem;">Deliver to</span><br/>
                 ${escHtml(o.customer_address)}
               </div>` : ''}
          ${orderTrackingBlock(o)}
          ${cancelOrderBlock(o)}
          ${returnRequestBlock(o)}
          ${invoiceDownloadBlock(o)}
        </div>`;
    }).join('');
  }

  // ── Saved address banner in checkout ──────────────────────────────────────
  // Shows a one-tap "Use saved address" card above the checkout form
  function showSavedAddressBanner(email, profile) {
    // Only show on checkout page
    const form = document.getElementById('checkoutForm') || document.getElementById('ch-name');
    if (!form) return;
    if (document.getElementById('iac-saved-addr-banner')) return; // already shown

    const banner = document.createElement('div');
    banner.id = 'iac-saved-addr-banner';
    banner.style.cssText = `
      background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.25);
      padding:0.9rem 1.1rem;margin-bottom:1.2rem;display:flex;align-items:center;
      justify-content:space-between;gap:0.8rem;flex-wrap:wrap;
    `;
    const addrShort = [profile.address, profile.city, profile.pincode].filter(Boolean).join(', ');
    banner.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div style="font-size:0.6rem;letter-spacing:0.18em;text-transform:uppercase;color:#c9a84c;margin-bottom:0.2rem;">📍 Saved Address</div>
        <div style="font-size:0.78rem;color:#f0e8d8;font-weight:500;">${escHtml(profile.name || '')} · ${escHtml(profile.phone || '')}</div>
        <div style="font-size:0.7rem;color:#a09080;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(addrShort)}</div>
      </div>
      <button onclick="iacUseSavedAddress()" style="
        background:#c9a84c;color:#0d0b08;border:none;padding:0.5rem 1.1rem;
        font-family:'Montserrat',sans-serif;font-size:0.6rem;letter-spacing:0.18em;
        text-transform:uppercase;cursor:pointer;flex-shrink:0;font-weight:600;">
        Use This →
      </button>
    `;

    // Insert before first form field
    const firstField = document.querySelector('#ch-name, [id^="ch-"]');
    if (firstField) {
      const parent = firstField.closest('.form-group, .field-row, div') || firstField.parentNode;
      parent?.parentNode?.insertBefore(banner, parent);
    }

    window.iacUseSavedAddress = function() {
      const fill = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
      fill('ch-name',  profile.name);
      fill('ch-email', email);
      fill('ch-phone', profile.phone);
      fill('ch-addr',  profile.address);
      fill('ch-pin',   profile.pincode);
      fill('ch-city',  profile.city);
      fill('ch-state', profile.state);
      // Update pincode display
      if (profile.pincode && profile.city && profile.state) {
        const pinMsg = document.getElementById('pinMsg');
        if (pinMsg) { pinMsg.textContent = '✓ ' + profile.city + ', ' + profile.state; pinMsg.style.color = '#8fa87a'; }
      }
      banner.innerHTML = `<div style="color:#6dbf6d;font-size:0.72rem;padding:0.2rem 0;">✓ Address filled in</div>`;
      setTimeout(() => banner.remove(), 2000);
    };
  }

  // ── Tracking / shipping progress block ────────────────────────────────────
  function orderTrackingBlock(order) {
    const status = String(order.status || '').toLowerCase();
    const shippingStatuses = ['shipped','out_for_delivery','delivered','undelivered','rto','lost'];
    if (!shippingStatuses.includes(status)) return '';

    // Progress steps
    const STEPS = ['shipped', 'out_for_delivery', 'delivered'];
    const stepLabels = { shipped: 'Shipped', out_for_delivery: 'Out for Delivery', delivered: 'Delivered' };
    const activeIdx = STEPS.indexOf(status);  // -1 for rto/undelivered/lost

    const stepsHtml = STEPS.map((s, i) => {
      const done    = activeIdx >= 0 && i <= activeIdx;
      const current = i === activeIdx;
      const dotColor = done ? '#c9a84c' : 'rgba(201,168,76,0.2)';
      const lineColor = (activeIdx >= 0 && i < activeIdx) ? '#c9a84c' : 'rgba(201,168,76,0.15)';
      return `
        <div style="display:flex;flex-direction:column;align-items:center;flex:1;position:relative;">
          ${i > 0 ? `<div style="position:absolute;top:6px;right:50%;width:100%;height:2px;background:${lineColor};z-index:0;"></div>` : ''}
          <div style="width:14px;height:14px;border-radius:50%;background:${dotColor};
                      border:2px solid ${current ? '#c9a84c' : dotColor};
                      z-index:1;flex-shrink:0;${current ? 'box-shadow:0 0 0 3px rgba(201,168,76,0.25);' : ''}"></div>
          <div style="font-size:0.5rem;letter-spacing:0.08em;text-transform:uppercase;margin-top:0.35rem;
                      color:${done ? '#c9a84c' : '#5a4a38'};text-align:center;line-height:1.3;">
            ${stepLabels[s]}
          </div>
        </div>`;
    }).join('');

    // Courier + AWB info
    const courierLine = [
      order.courier_name,
      order.tracking_id ? `AWB: ${order.tracking_id}` : null,
    ].filter(Boolean).join(' · ');

    // Track button
    const trackUrl = order.tracking_url
      || `https://inkandchai.in/track/?id=${encodeURIComponent(order.razorpay_order_id || order.id)}&q=${encodeURIComponent(order.customer_email || order.customer_phone || '')}`;

    const issueNote = {
      undelivered: '⚠️ Delivery was attempted but unsuccessful. Please ensure someone is available or contact us.',
      rto:         '↩ Your package is being returned to us. Please contact support for a refund or re-delivery.',
      lost:        '⚠️ Package marked lost in transit. Please contact our support team immediately.',
    }[status] || '';

    return `
      <div style="margin-top:1rem;padding-top:1rem;border-top:1px solid rgba(201,168,76,0.1);">
        ${STEPS.includes(status) ? `
        <div style="display:flex;align-items:flex-start;padding:0 0.5rem;margin-bottom:0.9rem;">
          ${stepsHtml}
        </div>` : ''}
        ${issueNote ? `<div style="font-size:0.65rem;color:#e8a030;margin-bottom:0.7rem;line-height:1.5;">${escHtml(issueNote)}</div>` : ''}
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.6rem;">
          ${courierLine ? `<div style="font-size:0.58rem;color:#7a6330;letter-spacing:0.05em;">${escHtml(courierLine)}</div>` : '<div></div>'}
          <a href="${escHtmlAttr(trackUrl)}" target="_blank" rel="noopener"
             style="font-size:0.55rem;letter-spacing:0.18em;text-transform:uppercase;
                    padding:0.35rem 0.85rem;background:transparent;
                    border:1px solid rgba(201,168,76,0.45);color:#c9a84c;text-decoration:none;
                    transition:all 0.2s;">Track Package →</a>
        </div>
      </div>`;
  }

  // ── Invoice download block ────────────────────────────────────────────────
  function invoiceDownloadBlock(order) {
    // Only show for paid / confirmed / shipped / delivered orders
    const paid = ['paid','confirmed','cod_pending','partial_cod_pending','shipped',
                  'out_for_delivery','delivered'].includes(order.status);
    if (!paid) return '';
    const oid = escHtmlAttr(JSON.stringify(order).replace(/'/g,"&#39;"));
    return `
      <div style="margin-top:0.8rem;padding-top:0.8rem;border-top:1px solid rgba(201,168,76,0.08);">
        <button onclick='iacDownloadInvoice(${oid})'
          style="background:none;border:1px solid rgba(201,168,76,0.3);color:#c9a84c;
                 font-family:'Montserrat',sans-serif;font-size:0.6rem;letter-spacing:0.16em;
                 text-transform:uppercase;padding:0.45rem 1rem;cursor:pointer;display:inline-flex;
                 align-items:center;gap:0.4rem;">
          ⬇ Download Invoice
        </button>
      </div>`;
  }

  window.iacDownloadInvoice = function(order) {
    const o     = typeof order === 'string' ? JSON.parse(order) : order;
    const date  = new Date(o.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const items = Array.isArray(o.cart_items) ? o.cart_items : [];
    const subtotal = items.reduce((s, i) => s + (i.price * (i.qty || 1)), 0);
    const total  = o.amount_paise ? o.amount_paise / 100 : subtotal;
    const shipping = Math.max(0, Math.round(total - subtotal));
    const orderId = o.razorpay_order_id || o.id || '—';

    const payMethod = {
      paid: 'Prepaid (Online)',
      confirmed: 'Prepaid (Online)',
      cod_pending: 'Cash on Delivery',
      partial_cod_pending: 'Partial COD',
      shipped: o.status === 'cod_pending' ? 'Cash on Delivery' : 'Prepaid (Online)',
      out_for_delivery: 'Prepaid / COD',
      delivered: 'Paid',
    }[o.status] || 'Online';

    const rows = items.map((i, idx) => `
      <tr style="${idx % 2 ? 'background:#f9f7f4;' : ''}">
        <td style="padding:10px 12px;font-size:13px;color:#2a1a08;">${escHtml(i.title || 'Book')}</td>
        <td style="padding:10px 12px;text-align:center;font-size:13px;">${i.qty || 1}</td>
        <td style="padding:10px 12px;text-align:right;font-size:13px;">₹${Number(i.price).toLocaleString('en-IN')}</td>
        <td style="padding:10px 12px;text-align:right;font-size:13px;font-weight:600;">
          ₹${(i.price * (i.qty || 1)).toLocaleString('en-IN')}
        </td>
      </tr>`).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Invoice ${orderId} — Ink &amp; Chai</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #fff; color: #2a1a08; font-size: 14px; }
  .page { max-width: 760px; margin: 0 auto; padding: 40px 36px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; border-bottom: 2px solid #c9a84c; padding-bottom: 20px; }
  .logo { font-family: Georgia, serif; font-size: 28px; color: #8a6a1f; font-weight: 700; letter-spacing: 0.02em; }
  .logo span { font-weight: 300; color: #a09080; }
  .invoice-meta { text-align: right; }
  .invoice-meta h2 { font-size: 22px; color: #8a6a1f; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600; margin-bottom: 6px; }
  .invoice-meta p { font-size: 12px; color: #888; line-height: 1.6; }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 28px; }
  .party-box { background: #fdf8ef; border: 1px solid #e8d9b0; padding: 16px 18px; border-radius: 4px; }
  .party-box h4 { font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; color: #8a6a1f; margin-bottom: 8px; font-weight: 600; }
  .party-box p { font-size: 13px; line-height: 1.7; color: #2a1a08; }
  .party-box strong { font-weight: 600; font-size: 14px; }
  .order-info { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  .info-chip { background: #fdf8ef; border: 1px solid #e8d9b0; padding: 10px 16px; border-radius: 4px; font-size: 12px; }
  .info-chip span { display: block; font-size: 10px; color: #8a6a1f; letter-spacing: 0.15em; text-transform: uppercase; margin-bottom: 3px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 0; }
  thead th { background: #8a6a1f; color: #fff; padding: 11px 12px; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; text-align: left; font-weight: 600; }
  thead th:nth-child(2), thead th:nth-child(3), thead th:nth-child(4) { text-align: center; }
  thead th:nth-child(3), thead th:nth-child(4) { text-align: right; }
  tbody tr:last-child td { border-bottom: 2px solid #c9a84c; }
  .totals { display: flex; justify-content: flex-end; margin-top: 0; }
  .totals-box { min-width: 240px; }
  .totals-row { display: flex; justify-content: space-between; padding: 7px 12px; font-size: 13px; border-bottom: 1px solid #f0e8d0; }
  .totals-row.grand { background: #8a6a1f; color: #fff; font-weight: 700; font-size: 15px; padding: 10px 12px; border-radius: 0 0 4px 4px; }
  .footer { margin-top: 36px; border-top: 1px solid #e8d9b0; padding-top: 18px; display: flex; justify-content: space-between; align-items: flex-end; }
  .footer-note { font-size: 11px; color: #a09080; line-height: 1.7; }
  .thanks { font-family: Georgia, serif; font-size: 18px; color: #8a6a1f; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .no-print { display: none !important; }
  }
</style>
</head>
<body>
<div class="page">

  <!-- Print / Save button (hidden on print) -->
  <div class="no-print" style="text-align:right;margin-bottom:20px;">
    <button onclick="window.print()"
      style="background:#8a6a1f;color:#fff;border:none;padding:10px 24px;font-size:13px;
             letter-spacing:0.1em;text-transform:uppercase;cursor:pointer;border-radius:3px;">
      🖨 Print / Save as PDF
    </button>
  </div>

  <!-- Header -->
  <div class="header">
    <div>
      <div class="logo">Ink &amp; <span>Chai</span></div>
      <p style="font-size:12px;color:#a09080;margin-top:4px;">inkandchai.in</p>
    </div>
    <div class="invoice-meta">
      <h2>Tax Invoice</h2>
      <p>${orderId}<br/>${date}</p>
    </div>
  </div>

  <!-- Sold By / Ship To -->
  <div class="parties">
    <div class="party-box">
      <h4>Sold By</h4>
      <p>
        <strong>Ink &amp; Chai</strong><br/>
        211, Gali Arya Samaj Wali<br/>
        Sitaram Bazar, Delhi – 110002<br/>
        India<br/>
        <span style="color:#8a6a1f;">support@inkandchai.in</span>
      </p>
    </div>
    <div class="party-box">
      <h4>Ship To</h4>
      <p>
        <strong>${escHtml(o.customer_name || '—')}</strong><br/>
        ${escHtml(o.customer_address || '—')}<br/>
        ${o.customer_phone ? `<span style="color:#555;">📞 ${escHtml(o.customer_phone)}</span>` : ''}
      </p>
    </div>
  </div>

  <!-- Order chips -->
  <div class="order-info">
    <div class="info-chip"><span>Order ID</span>${orderId}</div>
    <div class="info-chip"><span>Order Date</span>${date}</div>
    <div class="info-chip"><span>Payment</span>${payMethod}</div>
    ${o.tracking_id ? `<div class="info-chip"><span>AWB / Tracking</span>${escHtml(o.tracking_id)}</div>` : ''}
  </div>

  <!-- Items table -->
  <table>
    <thead>
      <tr>
        <th>Description</th>
        <th style="text-align:center;">Qty</th>
        <th style="text-align:right;">Unit Price</th>
        <th style="text-align:right;">Amount</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <!-- Totals -->
  <div class="totals">
    <div class="totals-box">
      <div class="totals-row"><span>Subtotal</span><span>₹${subtotal.toLocaleString('en-IN')}</span></div>
      <div class="totals-row"><span>Shipping</span><span>${shipping > 0 ? '₹' + shipping.toLocaleString('en-IN') : 'FREE'}</span></div>
      <div class="totals-row grand"><span>Total</span><span>₹${total.toLocaleString('en-IN')}</span></div>
    </div>
  </div>

  <!-- Footer -->
  <div class="footer">
    <div class="footer-note">
      Books are non-returnable after 7 days of delivery.<br/>
      For support: support@inkandchai.in · +91 92171 75546<br/>
      This is a computer-generated invoice.
    </div>
    <div class="thanks">Thank you! 📚☕</div>
  </div>

</div>
</body>
</html>`;

    const win = window.open('', '_blank');
    if (win) {
      win.document.write(html);
      win.document.close();
    } else {
      // Fallback: blob download
      const blob = new Blob([html], { type: 'text/html' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `invoice-${orderId}.html`;
      a.click();
    }
  };

  // ── Cancel order block (COD + prepaid within 30 min) ─────────────────────
  const PREPAID_CANCEL_WINDOW = 30 * 60 * 1000; // 30 minutes

  function cancelOrderBlock(order) {
    const status = String(order.status || '').toLowerCase();

    // Hard block: once shipped/dispatched, no cancellation under any circumstance
    const SHIPPED_STATUSES = ['shipped', 'out_for_delivery', 'delivered', 'cancelled',
                               'refunded', 'refund_pending', 'rto', 'undelivered', 'lost'];
    if (SHIPPED_STATUSES.includes(status)) return '';

    // Also block if a tracking ID is already assigned — courier has collected the parcel
    if (order.tracking_id) return '';

    const isCOD      = ['cod_pending', 'partial_cod_pending', 'confirmed'].includes(status);
    const isPrepaid  = status === 'paid';

    if (!isCOD && !isPrepaid) return '';

    if (isPrepaid) {
      const createdAt = order.created_at ? new Date(order.created_at).getTime() : 0;
      const msLeft    = PREPAID_CANCEL_WINDOW - (Date.now() - createdAt);
      if (msLeft <= 0) return ''; // window expired — don't show button
      const mins = String(Math.floor(msLeft / 60000)).padStart(2, '0');
      const secs = String(Math.floor((msLeft % 60000) / 1000)).padStart(2, '0');
      return `
        <div style="margin-top:0.9rem;padding-top:0.9rem;border-top:1px solid rgba(201,168,76,0.08);
                    display:flex;align-items:center;justify-content:space-between;gap:0.8rem;flex-wrap:wrap;">
          <div style="font-size:0.6rem;color:#a09080;line-height:1.5;">
            Cancellation window:
            <span id="cancel-timer-${escJs(order.id)}"
                  data-deadline="${createdAt + PREPAID_CANCEL_WINDOW}"
                  style="color:#e8a030;font-weight:600;">${mins}:${secs}</span>
          </div>
          <button onclick="iacCancelOrder('${escJs(order.id)}', true)"
            id="cancel-btn-${escJs(order.id)}"
            style="font-family:'Montserrat',sans-serif;font-size:0.56rem;letter-spacing:0.16em;text-transform:uppercase;
                   padding:0.65rem 1rem;background:transparent;border:1px solid rgba(232,112,112,0.4);
                   color:#e87070;cursor:pointer;transition:all 0.2s;">
            Cancel &amp; Refund
          </button>
        </div>`;
    }

    // COD
    return `
      <div style="margin-top:0.9rem;padding-top:0.9rem;border-top:1px solid rgba(201,168,76,0.08);
                  display:flex;align-items:center;justify-content:space-between;gap:0.8rem;flex-wrap:wrap;">
        <div style="font-size:0.6rem;color:#a09080;line-height:1.5;">
          COD order · not yet dispatched
        </div>
        <button onclick="iacCancelOrder('${escJs(order.id)}', false)"
          id="cancel-btn-${escJs(order.id)}"
          style="font-family:'Montserrat',sans-serif;font-size:0.56rem;letter-spacing:0.16em;text-transform:uppercase;
                 padding:0.65rem 1rem;background:transparent;border:1px solid rgba(232,112,112,0.4);
                 color:#e87070;cursor:pointer;transition:all 0.2s;">
          Cancel Order
        </button>
      </div>`;
  }

  // Tick countdown timers for prepaid cancel windows
  (function startCancelTimers() {
    setInterval(() => {
      document.querySelectorAll('[id^="cancel-timer-"]').forEach(el => {
        const deadline = parseInt(el.dataset.deadline, 10);
        const msLeft = deadline - Date.now();
        if (msLeft <= 0) {
          // Hide the whole cancel row
          const row = el.closest('div[style*="border-top"]');
          if (row) row.style.display = 'none';
          return;
        }
        const mins = String(Math.floor(msLeft / 60000)).padStart(2, '0');
        const secs = String(Math.floor((msLeft % 60000) / 1000)).padStart(2, '0');
        el.textContent = `${mins}:${secs}`;
      });
    }, 1000);
  })();

  window.iacCancelOrder = async function (orderId, isPrepaid) {
    const confirmMsg = isPrepaid
      ? 'Cancel this prepaid order and request a refund? Refund takes 5–7 business days. This cannot be undone.'
      : 'Are you sure you want to cancel this order? This cannot be undone.';
    if (!confirm(confirmMsg)) return;

    const btn = document.getElementById(`cancel-btn-${orderId}`);
    if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }

    try {
      const sb = getSB();
      const { data: { session } } = await sb.auth.getSession();
      const token = session?.access_token || '';

      const res = await fetch('/.netlify/functions/cancel-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ order_id: orderId }),
      });
      const json = await res.json();

      if (!res.ok) throw new Error(json.error || 'Cancellation failed');

      alert(json.message || 'Order cancelled successfully.');
      await openMyOrders();
    } catch (err) {
      alert('Could not cancel order: ' + err.message);
      if (btn) { btn.disabled = false; btn.textContent = isPrepaid ? 'Cancel & Refund' : 'Cancel Order'; }
    }
  };

  function returnWindowInfo(order) {
    const status = String(order.status || '').toLowerCase();
    // Returns only allowed AFTER delivery — not for shipped/in-transit orders
    if (status !== 'delivered') return { eligible: false, daysLeft: 0, reason: 'not_delivered' };
    if (['cancelled', 'refunded'].includes(status)) return { eligible: false, daysLeft: 0, reason: 'cancelled' };
    // Window starts from delivery date
    const anchorTime = order.delivered_at ? new Date(order.delivered_at).getTime() : NaN;
    if (!Number.isFinite(anchorTime)) return { eligible: false, daysLeft: 0, reason: 'no_delivery_date' };
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const msLeft = anchorTime + sevenDays - Date.now();
    const eligible = msLeft >= 0;
    return { eligible, daysLeft: Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000))), reason: eligible ? 'ok' : 'expired' };
  }

  function returnRequestBlock(order) {
    const status = String(order.status || '').toLowerCase();

    // ── Return already submitted ─────────────────────────────────────────────
    if (order.return_request_status) {
      const rstatus = order.return_request_status;
      const statusLabel = rstatus.replace(/_/g, ' ');
      const isPending = rstatus === 'pending';

      const statusColors = { pending: '#e8a030', approved: '#6dbf6d', rejected: '#e06060', processing: '#4db8ff' };
      const badgeColor = statusColors[rstatus] || '#a09080';

      return `
        <div style="margin-top:0.9rem;padding-top:0.9rem;border-top:1px solid rgba(201,168,76,0.08);">
          <div style="display:flex;align-items:center;gap:0.7rem;flex-wrap:wrap;margin-bottom:${isPending ? '0.7rem' : '0'};">
            <span style="font-size:0.56rem;letter-spacing:0.14em;text-transform:uppercase;
                         padding:0.28rem 0.7rem;border:1px solid ${badgeColor}44;color:${badgeColor};">
              ↩ Return ${statusLabel}
            </span>
            <span style="font-size:0.62rem;color:#a09080;line-height:1.5;">
              ${rstatus === 'pending' ? 'Our team will review and be in touch. Keep the package ready.' : ''}
              ${rstatus === 'approved' ? 'Pickup has been arranged. Keep the package ready.' : ''}
              ${rstatus === 'rejected' ? 'Return was not approved. Contact support for details.' : ''}
              ${rstatus === 'processing' ? 'Pickup scheduled — handover to courier when they arrive.' : ''}
            </span>
          </div>
          ${isPending ? `
          <button onclick="iacCancelReturn('${escJs(order.id)}')"
            style="font-family:'Montserrat',sans-serif;font-size:0.52rem;letter-spacing:0.14em;text-transform:uppercase;
                   padding:0.4rem 0.8rem;background:transparent;border:1px solid rgba(224,96,96,0.4);
                   color:#e06060;cursor:pointer;">
            Cancel Return Request
          </button>` : ''}
        </div>`;
    }

    // ── Not delivered yet — no return option ────────────────────────────────
    if (status !== 'delivered') {
      // Only show a note for shipped/in-transit orders (not for pending/paid which are pre-shipment)
      if (['shipped', 'out_for_delivery'].includes(status)) {
        return `
          <div style="margin-top:0.9rem;padding-top:0.8rem;border-top:1px solid rgba(201,168,76,0.08);
                      font-size:0.58rem;color:#7a6330;letter-spacing:0.06em;line-height:1.6;">
            Return option available after delivery
          </div>`;
      }
      return '';
    }

    // ── Delivered — check window ─────────────────────────────────────────────
    const info = returnWindowInfo(order);
    if (!info.eligible) {
      return `
        <div style="margin-top:0.9rem;padding-top:0.8rem;border-top:1px solid rgba(201,168,76,0.08);
                    font-size:0.58rem;color:#7a6330;letter-spacing:0.08em;line-height:1.6;text-transform:uppercase;">
          Return window closed
        </div>`;
    }

    return `
      <div style="margin-top:0.9rem;padding-top:0.9rem;border-top:1px solid rgba(201,168,76,0.08);
                  display:flex;align-items:center;justify-content:space-between;gap:0.8rem;flex-wrap:wrap;">
        <div style="font-size:0.6rem;color:#a09080;line-height:1.5;">
          7-day return window · ${info.daysLeft} day${info.daysLeft === 1 ? '' : 's'} left
        </div>
        <button onclick="iacOpenReturnModal('${escJs(order.id)}')"
          style="font-family:'Montserrat',sans-serif;font-size:0.56rem;letter-spacing:0.16em;text-transform:uppercase;
                 padding:0.65rem 1rem;background:transparent;border:1px solid rgba(201,168,76,0.35);
                 color:#c9a84c;cursor:pointer;">
          Initiate Return
        </button>
      </div>`;
  }

  window.iacOpenReturnModal = function (orderId) {
    removeModal('iacReturnModal');
    const modal = document.createElement('div');
    modal.id = 'iacReturnModal';
    modal.style.cssText = `
      position:fixed;inset:0;background:rgba(13,11,8,0.94);backdrop-filter:blur(10px);
      display:flex;align-items:center;justify-content:center;z-index:9100;padding:1rem;
    `;
    modal.innerHTML = `
      <div style="background:#1c1916;border:1px solid rgba(201,168,76,0.22);width:min(460px,96vw);padding:2rem;position:relative;">
        <button onclick="document.getElementById('iacReturnModal')?.remove()"
          style="position:absolute;top:1rem;right:1.1rem;background:none;border:none;color:#a09080;font-size:1.2rem;cursor:pointer;">✕</button>
        <div style="font-size:0.58rem;letter-spacing:0.3em;text-transform:uppercase;color:#c9a84c;margin-bottom:0.6rem;">Return Request</div>
        <h3 style="font-family:'Cormorant Garamond',serif;font-size:1.7rem;font-weight:300;color:#faf7f2;margin-bottom:0.8rem;">Tell us what went wrong</h3>
        <p style="font-size:0.72rem;color:#a09080;line-height:1.7;margin-bottom:1rem;">Return requests are available within 7 days. We will review and email you the next steps.</p>
        <textarea id="iacReturnReason" rows="4" placeholder="Reason for return"
          style="width:100%;background:#141210;border:1px solid rgba(201,168,76,0.18);color:#f0e8d8;padding:0.8rem 1rem;font-family:'Montserrat',sans-serif;font-size:0.78rem;outline:none;resize:vertical;"></textarea>
        <button id="iacReturnSubmit" onclick="iacSubmitReturn('${escJs(orderId)}')"
          style="width:100%;margin-top:1rem;font-family:'Montserrat',sans-serif;font-size:0.62rem;letter-spacing:0.22em;text-transform:uppercase;padding:0.95rem;background:#c9a84c;color:#0d0b08;border:none;cursor:pointer;font-weight:500;">
          Submit Return Request
        </button>
        <p id="iacReturnMsg" style="font-size:0.7rem;margin-top:0.85rem;min-height:1.2em;text-align:center;"></p>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    setTimeout(() => document.getElementById('iacReturnReason')?.focus(), 80);
  };

  window.iacSubmitReturn = async function (orderId) {
    const sb = getSB();
    const btn = document.getElementById('iacReturnSubmit');
    const msg = document.getElementById('iacReturnMsg');
    const reason = document.getElementById('iacReturnReason')?.value.trim() || '';
    if (!sb || !currentUser) {
      if (msg) { msg.style.color = '#e06060'; msg.textContent = 'Please sign in again.'; }
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Submitting...';
    if (msg) { msg.style.color = '#a09080'; msg.textContent = 'Sending request...'; }
    try {
      const { data: { session } } = await sb.auth.getSession();
      const res = await fetch('/.netlify/functions/request-return', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token || ''}`,
        },
        body: JSON.stringify({ order_id: orderId, reason }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (json.already_submitted) {
          // Show inline message and close modal — no re-submit possible
          if (msg) { msg.style.color = '#c9a84c'; msg.textContent = json.error; }
          btn.disabled = true;
          btn.textContent = 'Already Submitted';
          setTimeout(() => { removeModal('iacReturnModal'); loadMyOrders(); }, 3000);
          return;
        }
        throw new Error(json.error || 'Could not submit return request.');
      }
      if (msg) { msg.style.color = '#6dbf6d'; msg.textContent = json.message || 'Return request submitted.'; }
      setTimeout(() => { removeModal('iacReturnModal'); loadMyOrders(); }, 1500);
    } catch (err) {
      if (msg) { msg.style.color = '#e06060'; msg.textContent = err.message || 'Could not submit return request.'; }
      btn.disabled = false;
      btn.textContent = 'Submit Return Request';
    }
  };

  // ── Cancel Return Request ──────────────────────────────────────────────────
  window.iacCancelReturn = async function (orderId) {
    if (!confirm('Cancel your return request?\n\nYou can submit a new one anytime within the 7-day window.')) return;
    const sb = getSB();
    if (!sb || !currentUser) return;

    try {
      const { data: { session } } = await sb.auth.getSession();
      const res = await fetch('/.netlify/functions/cancel-return', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token || ''}`,
        },
        body: JSON.stringify({ order_id: orderId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not cancel return request.');
      loadMyOrders();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };

  // ── Wishlist ───────────────────────────────────────────────────────────────
  const WISH_KEY = 'iac_wishlist';

  window.getWishlist = function () {
    try { return JSON.parse(localStorage.getItem(WISH_KEY) || '[]'); } catch { return []; }
  };

  window.toggleWishlist = function (book) {
    const list = getWishlist();
    const idx  = list.findIndex(b => b.url === book.url);
    if (idx >= 0) {
      list.splice(idx, 1);
      if (window.showToast) showToast('Removed from wishlist');
    } else {
      list.push({ url: book.url, title: book.title || book.t, img: book.img, price: book.price || book.p });
      if (window.showToast) showToast('Added to wishlist ♥');
    }
    localStorage.setItem(WISH_KEY, JSON.stringify(list));
    updateWishBtns(book.url);
  };

  window.isWishlisted = function (url) {
    return getWishlist().some(b => b.url === url);
  };

  function updateWishBtns(url) {
    document.querySelectorAll(`.wish-btn[data-url="${CSS.escape(url)}"]`).forEach(btn => {
      btn.classList.toggle('wishlisted', isWishlisted(url));
      btn.title = isWishlisted(url) ? 'Remove from wishlist' : 'Save to wishlist';
    });
  }

  // ── Pincode checker ────────────────────────────────────────────────────────
  const EXPRESS_PINCODES = new Set([
    '110001','110002','110003','110004','110005','110006','110007','110008','110009','110010',
    '110011','110012','110013','110014','110015','110016','110017','110018','110019','110020',
    '110021','110022','110023','110024','110025','110026','110027','110028','110029','110030',
    '110031','110032','110033','110034','110035','110036','110037','110038','110039','110040',
    '110041','110042','110043','110044','110045','110046','110047','110048','110049','110050',
    '110051','110052','110053','110054','110055','110056','110057','110058','110059','110060',
    '110061','110062','110063','110064','110065','110066','110067','110068','110069','110070',
    '110071','110072','110073','110074','110075','110076','110077','110078','110079','110080',
    '110081','110082','110083','110084','110085','110086','110087','110088','110089','110090',
    '110091','110092','110093','110094','110095','110096','110097',
    '201301','201302','201303','201304','201305','201306','201307','201308','201309','201310',
    '122001','122002','122003','122004','122010','122011','122015','122016','122017','122018',
    '122022','122051','122052','122053','122054',
  ]);

  window.checkPincode = function () {
    const pin = (document.getElementById('pincodeInput')?.value || '').replace(/\D/g, '');
    const res = document.getElementById('pincodeResult');
    if (!res) return;
    if (pin.length !== 6) {
      res.innerHTML = '<span style="color:#e06060;">Please enter a valid 6-digit pincode.</span>';
      return;
    }
    if (EXPRESS_PINCODES.has(pin)) {
      res.innerHTML = `
        <span style="color:#6dbf6d;">✓ We deliver to <strong>${pin}</strong>!</span>
        <span style="color:#a09080;font-size:0.68rem;margin-left:0.5rem;">Estimated delivery: 1–3 days</span>`;
    } else {
      res.innerHTML = `
        <span style="color:#c9a84c;">✓ We deliver to <strong>${pin}</strong>!</span>
        <span style="color:#a09080;font-size:0.68rem;margin-left:0.5rem;">Estimated delivery: 4–7 days via courier</span>`;
    }
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  function removeModal(id) {
    document.getElementById(id)?.remove();
  }

  function escHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escHtmlAttr(s) {
    return escHtml(s).replace(/"/g, '&quot;');
  }

  function escJs(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
