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

    sb.auth.onAuthStateChange(async (_event, session) => {
      currentUser = session?.user || null;
      if (currentUser) await fetchProfile();
      else currentProfile = null;
      updateNav();
    });
  }

  async function fetchProfile() {
    const sb = getSB();
    if (!sb || !currentUser) return;
    const { data } = await sb.from('profiles').select('*').eq('id', currentUser.id).single();
    currentProfile = data;
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

  // ── Public API ─────────────────────────────────────────────────────────────
  window.IAC = {
    getUser:    () => currentUser,
    getProfile: () => currentProfile,
    getUserId:  () => currentUser?.id,

    // Pre-fill checkout forms with saved details
    prefillCheckout() {
      if (!currentUser && !currentProfile) return;
      const vals = {
        'co-name':    currentProfile?.name,
        'co-email':   currentUser?.email,
        'co-phone':   currentProfile?.phone,
        'co-address': currentProfile?.address,
        'cod-name':   currentProfile?.name,
        'cod-email':  currentUser?.email,
        'cod-phone':  currentProfile?.phone,
        'cod-address':currentProfile?.address,
      };
      Object.entries(vals).forEach(([id, val]) => {
        const el = document.getElementById(id);
        if (el && val && !el.value) el.value = val;
      });
    },

    openAuthModal,
    openAccountModal,
  };

  // ─────────────────────────────────────────────────────────────────────────
  // AUTH MODAL (Login / Sign-up)
  // ─────────────────────────────────────────────────────────────────────────
  function openAuthModal(mode = 'login') {
    removeModal('iacAuthModal');
    const modal = document.createElement('div');
    modal.id = 'iacAuthModal';
    modal.style.cssText = `
      position:fixed;inset:0;background:rgba(13,11,8,0.94);backdrop-filter:blur(10px);
      display:flex;align-items:center;justify-content:center;z-index:9000;
    `;
    modal.innerHTML = `
      <div id="iacAuthBox" style="
        background:#1c1916;border:1px solid rgba(201,168,76,0.22);
        width:min(440px,92vw);padding:2.6rem;position:relative;
      ">
        <button onclick="document.getElementById('iacAuthModal').remove()"
          style="position:absolute;top:1rem;right:1.2rem;background:none;border:none;
                 color:#a09080;font-size:1.3rem;cursor:pointer;line-height:1;">✕</button>

        <div style="font-size:0.58rem;letter-spacing:0.35em;text-transform:uppercase;color:#c9a84c;margin-bottom:0.6rem;">
          Ink &amp; Chai
        </div>
        <h3 id="iacAuthTitle" style="font-family:'Cormorant Garamond',serif;font-size:1.9rem;font-weight:300;
               color:#faf7f2;margin-bottom:1.8rem;">Welcome back</h3>

        <div id="iacAuthFields"></div>

        <button id="iacAuthSubmit" onclick="iacSubmit()"
          style="width:100%;margin-top:0.4rem;font-family:'Montserrat',sans-serif;font-size:0.65rem;
                 letter-spacing:0.25em;text-transform:uppercase;padding:1rem 2rem;
                 background:#c9a84c;color:#0d0b08;border:none;cursor:pointer;font-weight:500;">
          Sign In →
        </button>

        <p id="iacAuthMsg" style="font-size:0.7rem;color:#e06060;margin-top:0.8rem;min-height:1.2em;text-align:center;"></p>

        <p style="text-align:center;margin-top:1.2rem;font-size:0.7rem;color:#a09080;">
          <span id="iacToggleText">Don't have an account?</span>
          <button id="iacToggleBtn" onclick="iacToggleMode()"
            style="background:none;border:none;color:#c9a84c;cursor:pointer;
                   font-family:'Montserrat',sans-serif;font-size:0.7rem;margin-left:0.4rem;
                   text-decoration:underline;">Create account</button>
        </p>
      </div>
    `;
    document.body.appendChild(modal);
    window._iacMode = 'login';
    renderAuthFields('login');
    if (mode === 'signup') iacToggleMode();
  }

  function renderAuthFields(mode) {
    const fields = document.getElementById('iacAuthFields');
    if (!fields) return;
    if (mode === 'signup') {
      fields.innerHTML = `
        ${authInput('iacFullName',  'text',     'Full Name *',     'Your full name')}
        ${authInput('iacEmail',     'email',    'Email *',         'you@example.com')}
        ${authInput('iacPhone',     'tel',      'Phone Number',    '10-digit mobile')}
        ${authInput('iacPassword',  'password', 'Password *',      'Minimum 6 characters')}
      `;
      document.getElementById('iacAuthTitle').textContent  = 'Create account';
      document.getElementById('iacAuthSubmit').textContent = 'Create Account →';
      document.getElementById('iacToggleText').textContent  = 'Already have an account?';
      document.getElementById('iacToggleBtn').textContent   = 'Sign in';
    } else {
      fields.innerHTML = `
        ${authInput('iacEmail',    'email',    'Email *',    'you@example.com')}
        ${authInput('iacPassword', 'password', 'Password *', 'Your password')}
      `;
      document.getElementById('iacAuthTitle').textContent  = 'Welcome back';
      document.getElementById('iacAuthSubmit').textContent = 'Sign In →';
      document.getElementById('iacToggleText').textContent  = 'Don\'t have an account?';
      document.getElementById('iacToggleBtn').textContent   = 'Create account';
    }
    // Focus email
    setTimeout(() => document.getElementById('iacEmail')?.focus(), 50);
  }

  function authInput(id, type, label, placeholder) {
    return `
      <div style="margin-bottom:1rem;">
        <label for="${id}" style="display:block;font-size:0.58rem;letter-spacing:0.18em;
               text-transform:uppercase;color:#a09080;margin-bottom:0.4rem;">${label}</label>
        <input id="${id}" type="${type}" placeholder="${placeholder}" autocomplete="on"
          onkeydown="if(event.key==='Enter')iacSubmit()"
          style="width:100%;background:#141210;border:1px solid rgba(201,168,76,0.18);
                 color:#f0e8d8;padding:0.7rem 1rem;font-family:'Montserrat',sans-serif;
                 font-size:0.78rem;outline:none;"
          onfocus="this.style.borderColor='rgba(201,168,76,0.5)'"
          onblur="this.style.borderColor='rgba(201,168,76,0.18)'"/>
      </div>`;
  }

  window.iacToggleMode = function () {
    window._iacMode = window._iacMode === 'login' ? 'signup' : 'login';
    renderAuthFields(window._iacMode);
    document.getElementById('iacAuthMsg').textContent = '';
  };

  window.iacSubmit = async function () {
    const btn = document.getElementById('iacAuthSubmit');
    const msg = document.getElementById('iacAuthMsg');
    btn.disabled = true;
    btn.textContent = 'Please wait…';
    msg.textContent = '';
    msg.style.color = '#e06060';

    const sb = getSB();
    if (!sb) { msg.textContent = 'Auth not configured.'; btn.disabled = false; return; }

    const email    = document.getElementById('iacEmail')?.value.trim();
    const password = document.getElementById('iacPassword')?.value;

    if (!email || !password) {
      msg.textContent = 'Please fill in all required fields.';
      btn.disabled = false;
      btn.textContent = window._iacMode === 'signup' ? 'Create Account →' : 'Sign In →';
      return;
    }

    if (window._iacMode === 'signup') {
      const name  = document.getElementById('iacFullName')?.value.trim() || '';
      const phone = document.getElementById('iacPhone')?.value.trim()    || '';

      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) {
        msg.textContent = error.message;
        btn.disabled = false;
        btn.textContent = 'Create Account →';
        return;
      }
      // Save profile
      if (data.user) {
        await sb.from('profiles').upsert({ id: data.user.id, name, phone });
        currentUser    = data.user;
        currentProfile = { name, phone };
      }
      msg.style.color = '#6dbf6d';
      msg.textContent = '✓ Account created! Check your email to confirm.';
      setTimeout(() => removeModal('iacAuthModal'), 2000);

    } else {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) {
        msg.textContent = error.message;
        btn.disabled = false;
        btn.textContent = 'Sign In →';
        return;
      }
      currentUser = data.user;
      await fetchProfile();
      msg.style.color = '#6dbf6d';
      msg.textContent = '✓ Signed in!';
      setTimeout(() => removeModal('iacAuthModal'), 800);
    }
    updateNav();
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
      display:flex;align-items:flex-start;justify-content:center;z-index:9000;overflow-y:auto;
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
    currentUser = null;
    currentProfile = null;
    removeModal('iacAccountModal');
    updateNav();
    if (window.showToast) showToast('Signed out.');
  };

  // ── My Orders ──────────────────────────────────────────────────────────────
  async function loadMyOrders() {
    const container = document.getElementById('acct-orders-content');
    if (!container) return;
    const sb = getSB();
    if (!sb || !currentUser) {
      container.innerHTML = '<p style="color:#a09080;font-size:0.78rem;">Please sign in to view your orders.</p>';
      return;
    }

    // Fetch orders where customer_email matches (simple approach without RLS user_id)
    const { data, error } = await sb
      .from('orders')
      .select('*')
      .eq('customer_email', currentUser.email)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error || !data?.length) {
      container.innerHTML = `<p style="color:#a09080;font-size:0.78rem;line-height:1.8;">
        ${error ? 'Could not load orders.' : 'No orders yet. <a href="/" style="color:#c9a84c;">Browse books →</a>'}
      </p>`;
      return;
    }

    container.innerHTML = data.map(o => {
      const date   = new Date(o.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
      const amount = o.amount_paise ? '₹' + (o.amount_paise / 100).toLocaleString('en-IN') : '—';
      const items  = Array.isArray(o.cart_items) ? o.cart_items : [];
      const statusColor = {
        paid: '#6dbf6d', shipped: '#c9a84c', delivered: '#6dbf6d',
        cod_pending: '#e8a030', confirmed: '#a09080', cancelled: '#e06060',
      }[o.status] || '#a09080';

      return `
        <div style="border:1px solid rgba(201,168,76,0.14);margin-bottom:1.2rem;padding:1.4rem;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.8rem;flex-wrap:wrap;gap:0.5rem;">
            <div>
              <div style="font-size:0.6rem;letter-spacing:0.18em;text-transform:uppercase;color:#a09080;margin-bottom:0.2rem;">${date}</div>
              <div style="font-size:0.68rem;color:#7a6330;letter-spacing:0.05em;">${o.razorpay_order_id}</div>
            </div>
            <div style="display:flex;gap:0.8rem;align-items:center;">
              <span style="font-family:'Cormorant Garamond',serif;font-size:1.2rem;color:#c9a84c;">${amount}</span>
              <span style="font-size:0.55rem;letter-spacing:0.2em;text-transform:uppercase;
                     padding:0.3rem 0.7rem;border:1px solid ${statusColor};color:${statusColor};">
                ${o.status?.replace('_', ' ') || 'pending'}
              </span>
            </div>
          </div>
          ${items.slice(0, 3).map(i => `
            <div style="display:flex;gap:0.8rem;align-items:center;padding:0.5rem 0;
                        border-top:1px solid rgba(201,168,76,0.08);">
              ${i.img ? `<img src="${escHtmlAttr(i.img)}" style="width:36px;height:52px;object-fit:cover;opacity:0.9;" alt=""/>` : ''}
              <div style="flex:1;min-width:0;">
                <div style="font-size:0.78rem;color:#f0e8d8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(i.title||'')}</div>
                <div style="font-size:0.6rem;color:#a09080;">Qty: ${i.qty} · ₹${(i.price*i.qty).toLocaleString('en-IN')}</div>
              </div>
            </div>`).join('')}
          ${items.length > 3 ? `<div style="font-size:0.62rem;color:#7a6330;margin-top:0.4rem;">+${items.length - 3} more items</div>` : ''}
        </div>`;
    }).join('');
  }

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
  // Fast delivery zones (example — update with real pin ranges for your city)
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
    // NCR
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
        <span style="color:#a09080;font-size:0.68rem;margin-left:0.5rem;">Estimated delivery: 2-4 days</span>`;
    } else {
      res.innerHTML = `
        <span style="color:#c9a84c;">✓ We deliver to <strong>${pin}</strong>!</span>
        <span style="color:#a09080;font-size:0.68rem;margin-left:0.5rem;">Estimated delivery: 4-7 days via courier</span>`;
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

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
