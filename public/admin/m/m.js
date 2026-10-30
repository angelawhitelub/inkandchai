/*
 * Ink & Chai mobile admin — /admin/m/ (inkandchai.in/m redirects here).
 *
 * A phone-first front end over the SAME admin functions the desktop admin
 * (/admin/) calls, signed in by the same iac_admin_session cookie. Nothing
 * here has its own server logic: every save goes through the endpoint the
 * desktop uses, so the two can never disagree about what a button does.
 *
 *   Today     daily-profit, admin-support-tickets counts, bot-inbox, returns
 *   Orders    get-orders (?statuses, ?q) → update-order-status
 *   Products  admin-product-search → update-product-override {partial:true},
 *             admin-cod-rules, admin-search-hidden
 *   Care      admin-support-tickets, bot-inbox, get-return-requests
 *
 * Anything not here (refunds, courier booking, bulk tools, catalogue copy)
 * stays on the desktop admin, linked from More.
 */
(function () {
  'use strict';

  const FN = '/.netlify/functions/';
  const app = document.getElementById('app');
  const tabbar = document.getElementById('tabbar');
  const sheetRoot = document.getElementById('sheet-root');
  const toastEl = document.getElementById('toast');

  const state = {
    session: null,
    orders: { filter: 'all', q: '', list: [], page: 0, total: 0, done: false, byRef: new Map(), scroll: 0, loadedAt: 0 },
    products: { q: '', list: [], bySlug: new Map(), scroll: 0 },
    care: { tab: 'tickets', ticketFilter: 'active', tickets: null, counts: null, convs: null, returns: null, scroll: 0 },
    today: null,
    careBadge: 0,
  };

  // ── Utilities ─────────────────────────────────────────────────────────────
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rupees = (n, dp = 0) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    const sign = v < 0 ? '−' : '';
    return sign + '₹' + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: dp, minimumFractionDigits: 0 });
  };
  const compactRupees = (n) => {
    const v = Number(n) || 0;
    const a = Math.abs(v);
    const sign = v < 0 ? '−' : '';
    if (a >= 1e7) return sign + '₹' + (a / 1e7).toFixed(2) + 'Cr';
    if (a >= 1e5) return sign + '₹' + (a / 1e5).toFixed(a >= 1e6 ? 1 : 2) + 'L';
    if (a >= 1e4) return sign + '₹' + (a / 1e3).toFixed(1) + 'k';
    return rupees(v);
  };
  const IST = { timeZone: 'Asia/Kolkata' };
  const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { ...IST, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';
  function ago(iso) {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString('en-IN', { ...IST, day: 'numeric', month: 'short' });
  }
  const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
  function phoneDigits(p) {
    let d = String(p || '').replace(/\D/g, '');
    if (d.length === 10) d = '91' + d;
    if (d.length === 11 && d.startsWith('0')) d = '91' + d.slice(1);
    return d;
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  function toast(msg, bad) {
    toastEl.textContent = msg;
    toastEl.className = 'toast' + (bad ? ' bad' : '');
    toastEl.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toastEl.hidden = true; }, bad ? 5200 : 2600);
  }

  async function api(name, { method = 'GET', query, body } = {}) {
    const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')) : '';
    const res = await fetch(FN + name + qs, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { state.session = null; showLogin(); throw Object.assign(new Error('Signed out'), { quiet: true }); }
    if (res.status === 403) throw new Error(data.error || 'Your role cannot open this.');
    if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  // ── Icons ─────────────────────────────────────────────────────────────────
  const I = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  const ICON = {
    today: I('<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>'),
    orders: I('<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>'),
    products: I('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
    care: I('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
    more: I('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
    search: I('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
    refresh: I('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>'),
    back: I('<path d="M15 18l-6-6 6-6"/>'),
    x: I('<path d="M18 6L6 18M6 6l12 12"/>'),
    phone: I('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>'),
    chat: I('<path d="M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 21l2.1-5.6A8.4 8.4 0 1 1 21 11.5z"/>'),
    copy: I('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    link: I('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/>'),
    truck: I('<path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>'),
    check: I('<path d="M20 6L9 17l-5-5"/>'),
    ban: I('<circle cx="12" cy="12" r="10"/><path d="M4.9 4.9l14.2 14.2"/>'),
    send: I('<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>'),
    edit: I('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>'),
    moon: I('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
    desktop: I('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    out: I('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>'),
    bot: I('<rect x="3" y="8" width="18" height="12" rx="3"/><path d="M12 4v4"/><circle cx="8.5" cy="14" r="1"/><circle cx="15.5" cy="14" r="1"/>'),
    hand: I('<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.3L2.6 16a2 2 0 0 1 2.8-2.8L7 14.8"/>'),
  };

  // ── Order helpers (mirror public/admin/index.html so both read alike) ────
  const STATUS = {
    pending: ['Awaiting payment', ''], pending_phonepe: ['Awaiting payment', ''], pending_partial_phonepe: ['Awaiting payment', ''],
    paid: ['Paid · not shipped', 'blue'], confirmed: ['Confirmed', 'blue'],
    cod_pending: ['COD · not shipped', 'orange'], partial_cod_pending: ['10% paid · not shipped', 'orange'], partial_cod: ['10% paid', 'orange'],
    pickup_scheduled: ['Pickup scheduled', 'purple'], shipped: ['Shipped', 'purple'], in_transit: ['In transit', 'purple'], out_for_delivery: ['Out for delivery', 'purple'],
    delivered: ['Delivered', 'green'],
    cancelled: ['Cancelled', 'red'], refunded: ['Refunded', 'red'], refund_pending: ['Refund pending', 'red'], refund_failed: ['Refund failed', 'red'],
    partially_refunded: ['Part refunded', 'red'], rto: ['RTO', 'red'], undelivered: ['Undelivered', 'red'], lost: ['Lost', 'red'],
  };
  const statusPill = (s) => {
    const [label, tone] = STATUS[s] || [String(s || 'pending').replace(/_/g, ' '), ''];
    return `<span class="pill ${tone}">${esc(label)}</span>`;
  };
  const ORDER_FILTERS = [
    ['all', 'All', null],
    ['toship', 'Not shipped', 'paid,confirmed,cod_pending,partial_cod_pending,partial_cod'],
    ['moving', 'In transit', 'pickup_scheduled,shipped,in_transit,out_for_delivery'],
    ['delivered', 'Delivered', 'delivered'],
    ['problem', 'RTO / lost', 'rto,undelivered,lost'],
    ['cancelled', 'Cancelled', 'cancelled,refunded,refund_pending,refund_failed,partially_refunded'],
    ['unpaid', 'Unpaid', 'pending,pending_phonepe,pending_partial_phonepe'],
  ];
  const items = (o) => (Array.isArray(o && o.cart_items) ? o.cart_items : []).filter(Boolean);
  const itemQty = (i) => { const q = Number(i && i.qty); return Number.isFinite(q) && q > 0 ? q : 1; };
  const payMeta = (o) => (items(o)[0] || {})._payment || {};
  function isPartial(o) {
    const st = String(o.status || '').toLowerCase();
    const meta = payMeta(o);
    return items(o).some((i) => i._payment && i._payment.mode === 'partial_cod') || meta.mode === 'partial_cod'
      || st === 'partial_cod_pending' || st === 'pending_partial_phonepe'
      || (st.includes('partial') && !st.includes('refund')) || Number(meta.balance) > 0;
  }
  const isReplacement = (o) => o.source === 'replacement' || /^IC-R-/i.test(String(o.razorpay_order_id || '')) || items(o).some((i) => i._replacement);
  function payKind(o) {
    if (isPartial(o)) return 'partial';
    const st = String(o.status || '').toLowerCase();
    const ps = String(o.payment_status || '').toLowerCase();
    if (ps === 'paid' || st === 'paid' || (o.razorpay_payment_id && st !== 'cod_pending')) return 'online_paid';
    if (ps === 'prepaid_pending' || st === 'confirmed') return 'prepaid_pending';
    return 'cod';
  }
  function money(o) {
    const list = items(o);
    const itemTotal = list.reduce((s, i) => s + (Number(i.price) || 0) * itemQty(i), 0);
    const paid = o.amount_paise ? o.amount_paise / 100 : 0;
    const meta = payMeta(o);
    if (isPartial(o)) {
      const balance = Number(meta.balance) || Math.max(0, itemTotal - paid);
      return { full: Number(meta.full_total) || (paid + balance) || itemTotal, paid, balance };
    }
    const kind = payKind(o);
    const full = paid || itemTotal;
    if (kind === 'online_paid') return { full, paid: paid || full, balance: 0 };
    return { full, paid: 0, balance: full };
  }
  function payPill(o) {
    if (isReplacement(o)) return '<span class="pill green">Replacement</span>';
    const k = payKind(o);
    if (k === 'partial') return '<span class="pill orange">10% + COD</span>';
    if (k === 'online_paid') return '<span class="pill green">Prepaid</span>';
    if (k === 'prepaid_pending') return '<span class="pill gold">Prepaid · awaiting</span>';
    return '<span class="pill orange">COD</span>';
  }
  const itemTitle = (i) => i.title || i.name || 'Book';
  function itemsSummary(o) {
    const list = items(o);
    if (!list.length) return 'No items';
    const first = itemTitle(list[0]) + (itemQty(list[0]) > 1 ? ' ×' + itemQty(list[0]) : '');
    return list.length > 1 ? `${first} + ${list.length - 1} more` : first;
  }
  const orderRef = (o) => String(o.razorpay_order_id || o.id || '');

  // ── Sheets ────────────────────────────────────────────────────────────────
  function openSheet(html, onMount) {
    closeSheet();
    sheetRoot.innerHTML = `<div class="sheet-backdrop" data-close></div><div class="sheet" role="dialog" aria-modal="true"><div class="inner"><div class="grab"></div>${html}</div></div>`;
    sheetRoot.querySelector('[data-close]').addEventListener('click', closeSheet);
    const sheet = sheetRoot.querySelector('.sheet');
    if (onMount) onMount(sheet);
    return sheet;
  }
  function closeSheet() { sheetRoot.innerHTML = ''; }
  function confirmSheet({ title, lead, ok = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const s = openSheet(`<h2>${esc(title)}</h2>${lead ? `<div class="lead">${lead}</div>` : ''}
        <div class="btn-row"><button class="btn ghost" data-no>Back</button><button class="btn ${danger ? 'danger' : ''}" data-yes>${esc(ok)}</button></div>`);
      s.querySelector('[data-no]').onclick = () => { closeSheet(); resolve(false); };
      s.querySelector('[data-yes]').onclick = () => { closeSheet(); resolve(true); };
      sheetRoot.querySelector('[data-close]').addEventListener('click', () => resolve(false));
    });
  }
  async function busy(btn, fn) {
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = 'Working…';
    try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = label; }
  }

  // ── Layout ────────────────────────────────────────────────────────────────
  const TABS = [['today', 'Today', ICON.today], ['orders', 'Orders', ICON.orders], ['products', 'Products', ICON.products], ['care', 'Care', ICON.care], ['more', 'More', ICON.more]];
  function renderTabbar(active) {
    tabbar.hidden = false;
    tabbar.innerHTML = TABS.map(([id, label, icon]) => `<a href="#/${id}" class="${id === active ? 'on' : ''}" aria-label="${label}">${icon}<span>${label}</span>${id === 'care' && state.careBadge ? `<span class="dot">${state.careBadge > 99 ? '99+' : state.careBadge}</span>` : ''}</a>`).join('');
  }
  function appbar({ title, sub, back, actions = '' }) {
    return `<header class="appbar ${back ? 'compact' : ''}">
      ${back ? `<a class="icon-btn" href="${esc(back)}" aria-label="Back" data-back>${ICON.back}</a>` : ''}
      <div class="grow"><h1>${esc(title)}</h1>${sub != null ? `<div class="sub">${esc(sub)}</div>` : ''}</div>${actions}</header>`;
  }
  const refreshBtn = '<button class="icon-btn" data-refresh aria-label="Refresh">' + ICON.refresh + '</button>';
  function mount(html, { tab, noTabs } = {}) {
    app.innerHTML = `<main class="view ${noTabs ? 'no-tabs' : ''}">${html}</main>`;
    if (noTabs) tabbar.hidden = true; else renderTabbar(tab);
    // Back goes back in history when there is history, so list scroll is kept.
    const back = app.querySelector('[data-back]');
    if (back && history.length > 1 && sessionStorage.getItem('iac_m_nav')) {
      back.addEventListener('click', (e) => { e.preventDefault(); history.back(); });
    }
    return app.firstElementChild;
  }
  const skeletonList = (n = 5, h = 92) => Array.from({ length: n }, () => `<div class="sk" style="height:${h}px;border-radius:18px;margin-top:10px"></div>`).join('');
  const errorBox = (e) => `<div class="card empty"><div class="e">⚠️</div><div>${esc(e.message || e)}</div></div>`;

  // ── Login ─────────────────────────────────────────────────────────────────
  function showLogin() {
    closeSheet();
    tabbar.hidden = true;
    app.innerHTML = `<div class="login"><form class="box" autocomplete="on">
      <div class="mark">I</div><h1>Ink &amp; Chai Admin</h1><p>Sign in to manage the store</p>
      <label class="field"><span>Email</span><input name="email" type="email" inputmode="email" autocomplete="username" required></label>
      <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
      <div class="err" data-err></div>
      <button class="btn block" type="submit">Sign in</button>
      <div class="foot"><a href="/admin/?desktop=1">Use the desktop admin (passkey sign-in)</a></div>
    </form></div>`;
    const form = app.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button');
      const err = form.querySelector('[data-err]');
      err.textContent = '';
      await busy(btn, async () => {
        const res = await fetch(FN + 'admin-login', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: form.email.value, password: form.password.value, remember: true }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { err.textContent = data.error || 'Could not sign in'; return; }
        await start();
      });
    });
  }

  // ── Today ─────────────────────────────────────────────────────────────────
  async function viewToday(force) {
    const root = mount(appbar({ title: greeting(), sub: new Date().toLocaleDateString('en-IN', { ...IST, weekday: 'long', day: 'numeric', month: 'long' }), actions: refreshBtn })
      + '<div data-body>' + (state.today && !force ? '' : `<div class="sk" style="height:150px;border-radius:18px"></div><div class="kpis">${'<div class="sk" style="height:86px;border-radius:18px"></div>'.repeat(4)}</div>${skeletonList(3, 60)}`) + '</div>', { tab: 'today' });
    const body = root.querySelector('[data-body]');
    if (state.today && !force) body.innerHTML = todayHtml(state.today);
    try {
      const [profit, tickets, convs, returns] = await Promise.allSettled([
        api('daily-profit', { query: { days: 7 } }),
        api('admin-support-tickets', { query: { status: 'active' } }),
        api('bot-inbox', { query: { action: 'list' } }),
        api('get-return-requests'),
      ]);
      state.today = { profit, tickets, convs, returns, at: Date.now() };
      if (tickets.status === 'fulfilled') { state.care.tickets = tickets.value.tickets || []; state.care.counts = tickets.value.counts; }
      if (convs.status === 'fulfilled') state.care.convs = convs.value.conversations || [];
      if (returns.status === 'fulfilled') state.care.returns = returns.value.returns || [];
      updateCareBadge();
      if (location.hash.startsWith('#/today') || location.hash === '' || location.hash === '#/') {
        body.innerHTML = todayHtml(state.today);
        renderTabbar('today');
      }
    } catch (e) { if (!e.quiet) body.innerHTML = errorBox(e); }
  }
  function greeting() {
    const h = Number(new Date().toLocaleString('en-IN', { ...IST, hour: 'numeric', hour12: false }));
    return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  }
  function todayHtml(t) {
    let out = '';
    if (t.profit.status === 'fulfilled') {
      const days = t.profit.value.days || [];
      const d0 = days[0] || {};
      const adsGuess = d0.ads_source === 'average';
      const conn = t.profit.value.connected || {};
      out += `<a class="card hero" href="/admin/?desktop=1#profit" style="display:block">
        <div class="label">Expected profit today</div>
        <div class="big ${Number(d0.net) < 0 ? 'neg' : ''}">${rupees(d0.net)}</div>
        <div class="meta"><span><b>${d0.orders || 0}</b> orders</span><span><b>${d0.cod || 0}</b> COD · <b>${d0.prepaid || 0}</b> prepaid</span></div>
      </a>
      <div class="kpis">
        <div class="card kpi"><div class="k">Ordered</div><div class="v">${compactRupees(d0.order_value)}</div><div class="s">expected ${compactRupees(d0.revenue)}</div></div>
        <div class="card kpi"><div class="k">Ad spend${adsGuess ? ' (est.)' : ''}</div><div class="v red">${compactRupees(d0.ads)}</div><div class="s">${adsGuess ? `₹${Math.round(d0.ads_per_order || 0)}/order average` : `Google ${compactRupees(d0.ads_google)} · Meta ${compactRupees(d0.ads_meta)}`}</div></div>
        <div class="card kpi"><div class="k">Shipping</div><div class="v">${compactRupees(d0.shipping)}</div><div class="s">expected</div></div>
        <div class="card kpi"><div class="k">Book cost</div><div class="v">${compactRupees(d0.cogs)}</div><div class="s">expected</div></div>
      </div>`;
      if (adsGuess || !conn.google || !conn.meta) {
        const missing = [!conn.google && 'Google', !conn.meta && 'Meta'].filter(Boolean).join(' and ');
        out += `<div class="note warn" style="margin-top:10px">${missing ? `${missing} ad spend is not connected.` : 'Today has no ad spend figures yet, so an average per order is used.'}</div>`;
      }
      const maxAbs = Math.max(1, ...days.map((d) => Math.abs(Number(d.net) || 0)));
      out += `<div class="section-title">Last 7 days <a href="/admin/?desktop=1#profit">Details</a></div><div class="card days">`
        + days.map((d) => {
          const dt = new Date(d.day + 'T00:00:00+05:30');
          const pct = Math.round((Math.abs(Number(d.net) || 0) / maxAbs) * 100);
          return `<div class="day"><div class="d">${dt.toLocaleDateString('en-IN', { ...IST, weekday: 'short' })}<span>${dt.toLocaleDateString('en-IN', { ...IST, day: 'numeric', month: 'short' })}</span></div>
            <div class="bar"><i class="${Number(d.net) < 0 ? 'neg' : ''}" style="width:${pct}%"></i></div>
            <div class="n">${compactRupees(d.net)}<span>${d.orders} orders</span></div></div>`;
        }).join('') + '</div>';
    } else {
      out += `<div class="note warn">Profit figures could not load: ${esc(t.profit.reason && t.profit.reason.message)}</div>`;
    }
    const c = state.care.counts || {};
    const convs = state.care.convs || [];
    const chatsWaiting = convs.filter(problemChat).length;
    const returnsOpen = (state.care.returns || []).filter(recentOpenReturn).length;
    out += `<div class="section-title">Needs you</div><div class="attn">
      <a class="card ${c.unanswered ? 'hot' : ''}" href="#/care/tickets"><div class="v">${c.unanswered ?? '—'}</div><div class="k">Unanswered tickets</div></a>
      <a class="card ${c.overdue ? 'hot' : ''}" href="#/care/tickets"><div class="v">${c.overdue ?? '—'}</div><div class="k">Overdue tickets</div></a>
      <a class="card ${chatsWaiting ? 'hot' : ''}" href="#/care/chats"><div class="v">${state.care.convs ? chatsWaiting : '—'}</div><div class="k">WhatsApp problem chats</div></a>
      <a class="card" href="#/care/returns"><div class="v">${state.care.returns ? returnsOpen : '—'}</div><div class="k">Open returns · 30 days</div></a>
    </div>`;
    return out;
  }
  // Almost every chat carries an unread count (the bot answers without
  // clearing it), so it is no signal. The inbox classifier's 'top' tier is:
  // missing books, cancellations and refund disputes (utils/conversation-priority).
  const problemChat = (x) => x.status !== 'resolved' && x.category === 'top';
  function updateCareBadge() {
    const c = state.care.counts || {};
    state.careBadge = c.unanswered || 0;
  }

  // ── Orders ────────────────────────────────────────────────────────────────
  async function viewOrders() {
    const o = state.orders;
    const root = mount(appbar({ title: 'Orders', sub: o.total ? ordersSub() : '', actions: refreshBtn })
      + `<label class="search">${ICON.search}<input type="search" placeholder="Order id, name, phone, AWB…" value="${esc(o.q)}" enterkeyhint="search" data-q>${o.q ? `<button data-clear aria-label="Clear">${ICON.x}</button>` : ''}</label>
      <div class="chips">${ORDER_FILTERS.map(([id, label]) => `<button class="chip ${id === o.filter && !o.q ? 'on' : ''}" data-f="${id}">${label}</button>`).join('')}</div>
      <div class="list" data-list></div><div data-more></div>`, { tab: 'orders' });
    const input = root.querySelector('[data-q]');
    const run = debounce(() => { o.q = input.value.trim(); resetOrders(); viewOrders(); }, 450);
    input.addEventListener('input', run);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { input.blur(); } });
    const clear = root.querySelector('[data-clear]');
    if (clear) clear.onclick = () => { o.q = ''; resetOrders(); viewOrders(); };
    root.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { o.filter = b.dataset.f; o.q = ''; resetOrders(); viewOrders(); }; });
    if (!o.list.length && !o.done) await loadOrders();
    drawOrders();
    if (o.scroll) { window.scrollTo(0, o.scroll); o.scroll = 0; }
  }
  function ordersSub() {
    const o = state.orders;
    const what = o.q ? 'found' : o.filter === 'all' ? 'orders' : ORDER_FILTERS.find((f) => f[0] === o.filter)[1].toLowerCase();
    return `${o.total.toLocaleString('en-IN')} ${what}`;
  }
  function resetOrders() { Object.assign(state.orders, { list: [], page: 0, total: 0, done: false, scroll: 0 }); }
  async function loadOrders() {
    const o = state.orders;
    const listEl = app.querySelector('[data-list]');
    if (listEl && !o.list.length) listEl.innerHTML = skeletonList();
    try {
      const statuses = o.q ? null : ORDER_FILTERS.find((f) => f[0] === o.filter)[2];
      const data = await api('get-orders', { query: { page: o.page + 1, limit: 30, statuses, q: o.q || undefined } });
      o.page += 1;
      o.total = data.total || 0;
      for (const row of data.orders || []) { o.list.push(row); o.byRef.set(orderRef(row), row); }
      o.done = (data.orders || []).length < 30;
      o.loadedAt = Date.now();
      const sub = app.querySelector('.appbar .sub');
      if (sub) sub.textContent = ordersSub();
    } catch (e) {
      if (!e.quiet && listEl) listEl.innerHTML = errorBox(e);
      o.done = true;
      throw e;
    }
  }
  function drawOrders() {
    const o = state.orders;
    const listEl = app.querySelector('[data-list]');
    const more = app.querySelector('[data-more]');
    if (!listEl) return;
    if (!o.list.length) {
      listEl.innerHTML = `<div class="empty"><div class="e">📭</div>${o.q ? `Nothing matches “${esc(o.q)}”.` : 'No orders here.'}</div>`;
      more.innerHTML = '';
      return;
    }
    listEl.innerHTML = o.list.map((row) => {
      const m = money(row);
      return `<div class="card"><a class="list-item" href="#/order/${encodeURIComponent(orderRef(row))}">
        <div class="oi-top"><span class="oi-id">${esc(orderRef(row))}</span><span class="oi-when">${esc(ago(row.created_at))}</span></div>
        <div class="oi-name ellipsis">${esc(row.customer_name || 'No name')}</div>
        <div class="oi-items ellipsis">${esc(itemsSummary(row))}</div>
        <div class="oi-bottom"><span class="oi-amt">${rupees(m.full)}</span><span class="row" style="gap:6px">${payPill(row)}${statusPill(row.status)}</span></div>
      </a></div>`;
    }).join('');
    more.innerHTML = o.done ? '' : '<button class="more-btn" data-load>Load more</button>';
    const btn = more.querySelector('[data-load]');
    if (btn) btn.onclick = () => busy(btn, async () => { await loadOrders().catch(() => {}); drawOrders(); });
  }

  async function viewOrder(ref) {
    const o = state.orders;
    let row = o.byRef.get(ref);
    const root = mount(appbar({ title: ref, back: '#/orders', actions: refreshBtn }) + '<div data-body>' + skeletonList(3, 120) + '</div>', { tab: 'orders', noTabs: true });
    const body = root.querySelector('[data-body]');
    try {
      if (!row || Date.now() - o.loadedAt > 60000 || viewOrder.force) {
        const data = await api('get-orders', { query: { q: ref, limit: 5 } });
        row = (data.orders || []).find((x) => orderRef(x) === ref) || row;
        if (row) o.byRef.set(ref, row);
      }
      viewOrder.force = false;
      if (!row) { body.innerHTML = '<div class="empty"><div class="e">🔎</div>Order not found.</div>'; return; }
      body.innerHTML = orderHtml(row);
      wireOrder(body, row);
    } catch (e) { if (!e.quiet) body.innerHTML = errorBox(e); }
  }
  function orderHtml(row) {
    const m = money(row);
    const list = items(row);
    const phone = phoneDigits(row.customer_phone);
    const created = fmtDateTime(row.created_at);
    const timeline = [
      ['Placed', row.created_at], ['Shipped', row.shipped_at], ['Delivered', row.delivered_at], ['Cancelled', row.cancelled_at],
    ].filter(([, t]) => t);
    return `
      <div class="card">
        <div class="row between"><div>${statusPill(row.status)}</div><div>${payPill(row)}</div></div>
        <div style="font-size:2rem;font-weight:800;letter-spacing:-0.04em;margin-top:10px">${rupees(m.full)}</div>
        <div class="small muted">${esc(created)} · ${list.length} item${list.length === 1 ? '' : 's'}</div>
        ${m.balance && m.paid ? `<div class="note" style="margin-top:12px">Paid ${rupees(m.paid)} online · courier collects <b>${rupees(m.balance)}</b></div>`
          : m.balance ? `<div class="note warn" style="margin-top:12px">Courier collects <b>${rupees(m.balance)}</b> on delivery</div>` : ''}
        ${row.cancellation_requested_at && !['cancelled', 'refunded', 'refund_pending'].includes(row.status) ? `<div class="note bad" style="margin-top:10px">Customer asked to cancel ${esc(ago(row.cancellation_requested_at))}${row.cancellation_request_note ? ` — “${esc(row.cancellation_request_note)}”` : ''}</div>` : ''}
        ${row.cancellation_reason ? `<div class="note bad" style="margin-top:10px">${esc(row.cancellation_reason)}</div>` : ''}
        <div class="actions">
          ${phone ? `<a class="act" href="tel:+${esc(phone)}">${ICON.phone}Call</a><a class="act" href="https://wa.me/${esc(phone)}" target="_blank" rel="noopener">${ICON.chat}WhatsApp</a>` : ''}
          <button class="act" data-update>${ICON.edit}Update</button>
        </div>
      </div>

      <div class="section-title">Items</div>
      <div class="card line-items">
        ${list.map((i) => {
          const url = i.url || (i.slug ? `/product/${i.slug}/` : '');
          return `<a class="li" ${url ? `href="${esc(url)}" target="_blank" rel="noopener"` : ''}>
            ${i.img || i.image ? `<img src="${esc(i.img || i.image)}" alt="" loading="lazy">` : '<img alt="">'}
            <div><div class="t clamp2">${esc(itemTitle(i))}</div><div class="q">${i.author ? esc(i.author) + ' · ' : ''}Qty ${itemQty(i)}</div></div>
            <div class="p">${Number(i.price) ? rupees(Number(i.price) * itemQty(i)) : ''}</div></a>`;
        }).join('') || '<div class="muted small">No items recorded.</div>'}
        <div class="total-row"><span>Total</span><span>${rupees(m.full)}</span></div>
      </div>

      <div class="section-title">Customer</div>
      <div class="card">
        <div style="font-weight:800;font-size:1.02rem">${esc(row.customer_name || 'No name')}</div>
        <div class="small muted" style="margin-top:2px">${esc(row.customer_phone || '')}${row.customer_email ? ' · ' + esc(row.customer_email) : ''}</div>
        ${row.customer_address ? `<div style="margin-top:10px;font-size:0.9rem;line-height:1.5;white-space:pre-line">${esc(row.customer_address)}</div>
          <button class="btn ghost block" style="margin-top:12px;height:42px;font-size:0.86rem" data-copy="${esc(row.customer_address)}">${ICON.copy.replace('<svg', '<svg width="16" height="16"')}Copy address</button>` : ''}
      </div>

      ${row.tracking_id ? `<div class="section-title">Shipment</div>
      <div class="card"><dl class="kv">
        <dt>Courier</dt><dd>${esc(row.courier_name || '—')}</dd>
        <dt>AWB</dt><dd class="mono">${esc(row.tracking_id)}</dd>
        ${row.last_nimbuspost_status || row.last_courier_status ? `<dt>Latest</dt><dd>${esc(row.last_courier_status || row.last_nimbuspost_status)}</dd>` : ''}
      </dl>${row.tracking_url ? `<a class="btn ghost block" style="margin-top:12px;height:42px;font-size:0.86rem" href="${esc(row.tracking_url)}" target="_blank" rel="noopener">Track shipment</a>` : ''}</div>` : ''}

      <div class="section-title">Details</div>
      <div class="card"><dl class="kv">
        ${timeline.map(([k, t]) => `<dt>${k}</dt><dd>${esc(fmtDateTime(t))}</dd>`).join('')}
        ${row.razorpay_payment_id ? `<dt>Payment id</dt><dd class="mono">${esc(row.razorpay_payment_id)}</dd>` : ''}
        ${row.refund_utr ? `<dt>Refund UTR</dt><dd class="mono">${esc(row.refund_utr)}</dd>` : ''}
        ${row.coupon_code ? `<dt>Coupon</dt><dd>${esc(row.coupon_code)}</dd>` : ''}
      </dl></div>
      <a class="desk-link" href="/admin/?desktop=1#orders">Refunds, courier booking &amp; more on desktop</a>`;
  }
  function wireOrder(body, row) {
    const copy = body.querySelector('[data-copy]');
    if (copy) copy.onclick = async () => {
      try { await navigator.clipboard.writeText(copy.dataset.copy); toast('Address copied'); } catch { toast('Could not copy', true); }
    };
    body.querySelector('[data-update]').onclick = () => orderActions(row);
  }

  const COURIERS = ['Amazon', 'BlueDart', 'DTDC', 'Delhivery', 'Ekart', 'IndiaPost', 'EcomExpress', 'Shadowfax', 'XpressBees', 'Shiprocket', 'Professional'];
  const CANCEL_REASONS = [
    ['out_of_stock', 'No inventory / out of stock', 'Apologises: the supplier had no stock.'],
    ['incomplete_address', 'Incomplete or wrong address', 'Asks them to order again with the full address.'],
    ['unserviceable_pincode', 'Pincode not serviceable', 'Names their pincode; suggests another address.'],
    ['customer_request', 'Customer asked to cancel', '“Cancelled as you requested.”'],
    ['other', 'Other — write the reason', 'Your note is shown to the customer as-is.'],
  ];
  function orderActions(row) {
    const st = String(row.status || '');
    const closed = ['cancelled', 'refunded', 'refund_pending', 'refund_failed', 'partially_refunded'].includes(st);
    const opts = [
      !closed && st !== 'shipped' && ['ship', ICON.truck, 'Mark shipped', 'Add courier + AWB; the customer is sent tracking', ''],
      !closed && st !== 'out_for_delivery' && ['out_for_delivery', ICON.truck, 'Out for delivery', 'Updates the order status', ''],
      !closed && st !== 'delivered' && ['delivered', ICON.check, 'Delivered', 'Marks the order delivered', 'green'],
      !closed && ['cancel', ICON.ban, 'Cancel order', isReplacement(row) ? 'Replacements are cancelled from the desktop admin' : 'Customer is told why; prepaid is refunded automatically', 'red'],
    ].filter(Boolean);
    if (!opts.length) { toast('Nothing to change on a ' + (STATUS[st] ? STATUS[st][0].toLowerCase() : st) + ' order'); return; }
    const s = openSheet(`<h2>Update ${esc(orderRef(row))}</h2><div class="lead">${esc(row.customer_name || '')} · ${rupees(money(row).full)}</div>
      ${opts.map(([id, ic, t, d, tone]) => `<button class="menu-item" data-a="${id}"><span class="ic ${tone}">${ic}</span><span>${t}<small>${d}</small></span></button>`).join('')}`);
    s.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => {
      const a = b.dataset.a;
      if (a === 'ship') return shipSheet(row);
      if (a === 'cancel') return isReplacement(row) ? (location.href = '/admin/?desktop=1#orders') : cancelSheet(row);
      return simpleStatus(row, a);
    }; });
  }
  async function postStatus(row, payload) {
    const data = await api('update-order-status', { method: 'POST', body: { id: row.id, ...payload } });
    Object.assign(row, { status: payload.status });
    if (payload.tracking_id) row.tracking_id = payload.tracking_id;
    if (payload.courier_name) row.courier_name = payload.courier_name;
    if (data.tracking_url) row.tracking_url = data.tracking_url;
    return data;
  }
  async function simpleStatus(row, status) {
    const label = STATUS[status][0];
    const ok = await confirmSheet({ title: `Mark ${label.toLowerCase()}?`, lead: `${esc(orderRef(row))} · ${esc(row.customer_name || '')}`, ok: `Mark ${label.toLowerCase()}` });
    if (!ok) return;
    try { await postStatus(row, { status }); toast(`Marked ${label.toLowerCase()}`); viewOrder(orderRef(row)); }
    catch (e) { if (!e.quiet) toast('Could not update: ' + e.message, true); }
  }
  function shipSheet(row) {
    const s = openSheet(`<h2>Mark shipped</h2><div class="lead">The customer is emailed the tracking link as soon as you save.</div>
      <label class="field"><span>Courier</span><select data-c>${COURIERS.map((c) => `<option ${c === (row.courier_name || 'Delhivery') ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="field"><span>AWB / tracking number</span><input data-awb inputmode="text" autocapitalize="characters" autocomplete="off" placeholder="e.g. 74372838181" value="${esc(row.tracking_id || '')}"></label>
      <button class="btn block" data-go>Save &amp; notify customer</button>`);
    s.querySelector('[data-awb]').focus();
    s.querySelector('[data-go]').onclick = (e) => busy(e.currentTarget, async () => {
      const awb = s.querySelector('[data-awb]').value.trim();
      if (!awb) { toast('Enter the AWB', true); return; }
      try {
        await postStatus(row, { status: 'shipped', tracking_id: awb, courier_name: s.querySelector('[data-c]').value });
        closeSheet(); toast('Shipped — customer notified'); viewOrder(orderRef(row));
      } catch (err) { if (!err.quiet) toast('Could not update: ' + err.message, true); }
    });
  }
  function cancelSheet(row) {
    const prepaid = payKind(row) === 'online_paid' || payKind(row) === 'partial';
    const s = openSheet(`<h2>Cancel ${esc(orderRef(row))}</h2>
      <div class="lead">The customer is emailed and WhatsApped the reason.${prepaid ? ' <b>Paid online — refunded automatically.</b>' : ''}</div>
      ${CANCEL_REASONS.map(([code, t, d]) => `<label class="radio-card"><input type="radio" name="r" value="${code}"><span><span class="t">${t}</span><br><span class="d">${d}</span></span></label>`).join('')}
      <label class="field" style="margin-top:6px"><span>Note to the customer (needed for Other)</span><textarea data-note maxlength="300" placeholder="Optional"></textarea></label>
      <button class="btn danger block" data-go>Cancel order</button>`);
    s.querySelector('[data-go]').onclick = (e) => busy(e.currentTarget, async () => {
      const picked = s.querySelector('input[name="r"]:checked');
      const note = s.querySelector('[data-note]').value.trim();
      if (!picked) { toast('Pick a reason', true); return; }
      if (picked.value === 'other' && !note) { toast('Write the reason for Other', true); return; }
      try {
        const data = await postStatus(row, { status: 'cancelled', cancel_reason: picked.value, cancel_note: note });
        closeSheet();
        const c = data.courier;
        if (c && c.message && !['cancelled', 'already_cancelled'].includes(c.action)) toast('Cancelled, but the SHIPMENT IS STILL LIVE: ' + c.message, true);
        else toast('Order cancelled');
        viewOrder.force = true;
        viewOrder(orderRef(row));
      } catch (err) { if (!err.quiet) toast('Could not cancel: ' + err.message, true); }
    });
  }

  // ── Products ──────────────────────────────────────────────────────────────
  // Mirrors netlify/functions/utils/scarcity.js PINNED_SCARCE: books that show
  // "Only 4 left" unless their override turns it off.
  const PINNED_SCARCE = new Set([
    'off-campus-complete-5-book-collection-elle-kennedy',
    'the-deal-the-mistake-the-score-elle-kennedy-off-campus-combo',
    'the-off-campus-series-complete-collection-5-books-by-elle-ke-nnedy',
    'the-deal-the-mistake-the-score-by-elle-kennedy-off-campus-se--3-ek',
    'colleen-hoover-3-book-starter-set-it-ends-with-us-verity-rem-ter-3',
    'wealth-starter-pack-299-psychology-of-money-rich-dad-poor-da-k-299',
    'hindi-motivation-big-4-atomic-habits-rich-dad-poor-dad-shakt-big-4',
    'robert-greene-power-trilogy-48-laws-of-power-laws-of-human-n-ogy-3',
  ]);
  async function viewProducts() {
    const p = state.products;
    const root = mount(appbar({ title: 'Products', sub: 'Price, stock and availability' })
      + `<label class="search">${ICON.search}<input type="search" placeholder="Search title or author…" value="${esc(p.q)}" enterkeyhint="search" data-q autocomplete="off"></label>
      <div class="list" data-list style="margin-top:12px"></div>`, { tab: 'products' });
    const input = root.querySelector('[data-q]');
    const run = debounce(async () => {
      p.q = input.value.trim();
      await searchProducts();
    }, 400);
    input.addEventListener('input', run);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    if (!p.q) input.focus();
    drawProducts();
    if (p.scroll) { window.scrollTo(0, p.scroll); p.scroll = 0; }
  }
  async function searchProducts() {
    const p = state.products;
    const listEl = app.querySelector('[data-list]');
    if (p.q.length < 2) { p.list = []; drawProducts(); return; }
    listEl.innerHTML = skeletonList(4, 92);
    const q = p.q;
    try {
      const data = await api('admin-product-search', { query: { q, limit: 30 } });
      if (q !== p.q) return;
      p.list = data.books || [];
      for (const b of p.list) p.bySlug.set(b.slug, b);
      drawProducts();
    } catch (e) { if (!e.quiet) listEl.innerHTML = errorBox(e); }
  }
  function drawProducts() {
    const p = state.products;
    const listEl = app.querySelector('[data-list]');
    if (!listEl) return;
    if (!p.q || p.q.length < 2) { listEl.innerHTML = '<div class="empty"><div class="e">📚</div>Search for a book to change its price, stock or availability.</div>'; return; }
    if (!p.list.length) { listEl.innerHTML = `<div class="empty"><div class="e">🔎</div>No book matches “${esc(p.q)}”.</div>`; return; }
    listEl.innerHTML = '<div class="card" style="padding:0;overflow:hidden">' + p.list.map((b, i) => `<a class="book list-item" style="${i ? 'border-top:1px solid var(--line)' : ''}" href="#/product/${encodeURIComponent(b.slug)}">
      <img class="cover" src="${esc(b.image_url || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div style="min-width:0"><div class="t clamp2">${esc(b.title)}</div><div class="a ellipsis">${esc(b.author || '')}</div></div>
      <div class="p">${b.price_inr ? rupees(b.price_inr) : ''}${Number(b.original_price_inr) > Number(b.price_inr) ? `<s>${rupees(b.original_price_inr)}</s>` : ''}</div></a>`).join('') + '</div>';
  }

  async function viewProduct(slug) {
    const base = state.products.bySlug.get(slug) || { slug, title: slug.replace(/-/g, ' ') };
    const root = mount(appbar({ title: base.title, back: '#/products' }) + '<div data-body>' + skeletonList(3, 120) + '</div>', { tab: 'products', noTabs: true });
    const body = root.querySelector('[data-body]');
    try {
      const [ov, cod, hidden] = await Promise.all([
        // The timestamp skips the edge copy, so a save made a moment ago shows.
        fetch(FN + 'get-product-overrides?slug=' + encodeURIComponent(slug) + '&t=' + Date.now(), { credentials: 'same-origin', cache: 'no-store' }).then((r) => r.json()).catch(() => ({})),
        api('admin-cod-rules', { query: { slug } }).catch((e) => ({ error: e.message })),
        api('admin-search-hidden', { query: { slug } }).catch((e) => ({ error: e.message })),
      ]);
      const o = (ov.overrides || []).find((x) => String(x.slug).toLowerCase() === slug) || null;
      const cur = {
        price: o && o.price_inr != null ? Number(o.price_inr) : (base.price_inr != null ? Number(base.price_inr) : ''),
        mrp: o && o.original_price_inr != null ? Number(o.original_price_inr) : (base.original_price_inr != null ? Number(base.original_price_inr) : ''),
        stock: o && o.stock_qty != null ? Number(o.stock_qty) : '',
        scarcity: o ? o.scarcity === true : PINNED_SCARCE.has(slug),
        cod: !(cod && cod.rule),
        codNote: (cod && cod.default_note) || '',
        searchable: !(hidden && hidden.hidden),
      };
      body.innerHTML = productHtml(base, cur, { codError: cod.error, hiddenError: hidden.error });
      wireProduct(body, base, cur);
    } catch (e) { if (!e.quiet) body.innerHTML = errorBox(e); }
  }
  function productHtml(b, cur, errs) {
    const stockNote = cur.stock === '' ? 'Not counted — always in stock.' : cur.stock <= 0 ? 'Sold out — shows “Coming Soon”.' : `${cur.stock} left — goes down with each order, back up on cancel.`;
    return `
      <div class="card row" style="align-items:flex-start;gap:14px">
        <img class="cover lg" src="${esc(b.image_url || '')}" alt="" onerror="this.style.visibility='hidden'">
        <div class="grow"><div style="font-weight:800;font-size:1.02rem;line-height:1.3">${esc(b.title)}</div>
          <div class="small muted" style="margin-top:3px">${esc(b.author || '')}</div>
          ${b.category ? `<div style="margin-top:8px"><span class="pill">${esc(b.category)}</span></div>` : ''}
          <a class="small" style="display:inline-flex;gap:6px;align-items:center;margin-top:12px;color:var(--accent);font-weight:800" href="/product/${esc(b.slug)}/" target="_blank" rel="noopener">View on site ${ICON.link.replace('<svg', '<svg width="14" height="14"')}</a>
        </div>
      </div>

      <div class="section-title">Price</div>
      <div class="card"><div class="grid2">
        <label class="field" style="margin:0"><span>Selling price</span><div class="money"><input data-k="price" type="number" inputmode="decimal" min="0" step="1" value="${esc(cur.price)}"></div></label>
        <label class="field" style="margin:0"><span>MRP</span><div class="money"><input data-k="mrp" type="number" inputmode="decimal" min="0" step="1" value="${esc(cur.mrp)}"></div></label>
      </div><div class="small muted" data-off style="margin-top:10px"></div></div>

      <div class="section-title">Stock</div>
      <div class="card">
        <label class="field" style="margin:0"><span>Copies in stock</span><input data-k="stock" type="number" inputmode="numeric" min="0" step="1" placeholder="Not counted" value="${esc(cur.stock)}"><small data-stocknote>${esc(stockNote)}</small></label>
        <div class="quick"><button data-stock="">Not counted</button><button data-stock="0">Sold out</button><button data-stock="+5">+5</button><button data-stock="+10">+10</button></div>
      </div>

      <div class="section-title">On the site</div>
      <div class="card" style="padding:4px 16px">
        <label class="toggle-row"><div class="grow"><div class="t">Cash on Delivery</div><div class="d">${errs.codError ? esc(errs.codError) : 'Off: prepaid and 10% COD only for this book'}</div></div><span class="switch"><input type="checkbox" data-k="cod" ${cur.cod ? 'checked' : ''} ${errs.codError ? 'disabled' : ''}><i></i></span></label>
        <label class="toggle-row"><div class="grow"><div class="t">Show in site search</div><div class="d">${errs.hiddenError ? esc(errs.hiddenError) : 'Off: still for sale, but search won’t list it'}</div></div><span class="switch"><input type="checkbox" data-k="searchable" ${cur.searchable ? 'checked' : ''} ${errs.hiddenError ? 'disabled' : ''}><i></i></span></label>
        <label class="toggle-row"><div class="grow"><div class="t">“Only 4 left” badge</div><div class="d">Urgency badge on the product page</div></div><span class="switch"><input type="checkbox" data-k="scarcity" ${cur.scarcity ? 'checked' : ''}><i></i></span></label>
      </div>
      <a class="desk-link" href="/admin/?desktop=1#products">Title, images, delivery &amp; more on desktop</a>
      <div class="sticky-save"><div class="inner"><button class="btn block" data-save disabled>No changes</button></div></div>`;
  }
  function wireProduct(body, b, cur) {
    const el = (k) => body.querySelector(`[data-k="${k}"]`);
    const read = () => ({
      price: el('price').value === '' ? '' : Number(el('price').value),
      mrp: el('mrp').value === '' ? '' : Number(el('mrp').value),
      stock: el('stock').value === '' ? '' : Math.max(0, Math.round(Number(el('stock').value))),
      cod: el('cod').checked,
      searchable: el('searchable').checked,
      scarcity: el('scarcity').checked,
    });
    const save = body.querySelector('[data-save]');
    const off = body.querySelector('[data-off]');
    const stockNote = body.querySelector('[data-stocknote]');
    const changes = () => { const now = read(); return Object.keys(now).filter((k) => String(now[k]) !== String(cur[k])); };
    const refresh = () => {
      const now = read();
      const pct = now.price && now.mrp && now.mrp > now.price ? Math.round((1 - now.price / now.mrp) * 100) : 0;
      off.textContent = pct ? `${pct}% off MRP` : now.price && now.mrp && now.price > now.mrp ? 'Price is above MRP' : '';
      stockNote.textContent = now.stock === '' ? 'Not counted — always in stock.' : now.stock <= 0 ? 'Sold out — shows “Coming Soon”.' : `${now.stock} left — goes down with each order, back up on cancel.`;
      const n = changes().length;
      save.disabled = !n;
      save.textContent = n ? `Save ${n} change${n === 1 ? '' : 's'}` : 'No changes';
    };
    body.addEventListener('input', refresh);
    body.addEventListener('change', refresh);
    body.querySelectorAll('[data-stock]').forEach((btn) => { btn.onclick = () => {
      const v = btn.dataset.stock;
      if (v.startsWith('+')) el('stock').value = (Number(el('stock').value) || 0) + Number(v.slice(1));
      else el('stock').value = v;
      refresh();
    }; });
    save.onclick = () => busy(save, async () => {
      const now = read();
      const changed = changes();
      const errors = [];
      const notes = [];
      const partial = {};
      if (changed.includes('price')) partial.price_inr = now.price;
      if (changed.includes('mrp')) partial.original_price_inr = now.mrp;
      if (changed.includes('stock')) partial.stock_qty = now.stock === '' ? null : now.stock;
      if (changed.includes('scarcity')) partial.scarcity = now.scarcity;
      if (Object.keys(partial).length) {
        try {
          const r = await api('update-product-override', { method: 'POST', body: { slug: b.slug, partial: true, ...partial } });
          if (r.override && r.override.is_active === false && ('stock_qty' in partial || 'scarcity' in partial)) {
            notes.push('this book’s override is switched off on desktop, so stock and the badge won’t show until it is on');
          }
          if (r.warning) notes.push(r.warning);
          Object.assign(cur, { price: now.price, mrp: now.mrp, stock: now.stock, scarcity: now.scarcity });
        } catch (e) { errors.push(e.message); }
      }
      if (changed.includes('cod')) {
        try { await api('admin-cod-rules', { method: 'POST', body: { slug: b.slug, cod_disabled: !now.cod, note: cur.codNote } }); cur.cod = now.cod; }
        catch (e) { errors.push('COD: ' + e.message); }
      }
      if (changed.includes('searchable')) {
        try { await api('admin-search-hidden', { method: 'POST', body: { slug: b.slug, hidden: !now.searchable, title: b.title } }); cur.searchable = now.searchable; }
        catch (e) { errors.push('Search: ' + e.message); }
      }
      if (errors.length) toast('Not saved: ' + errors.join(' · '), true);
      else toast(notes.length ? 'Saved — but ' + notes.join('; ') : 'Saved and live', !!notes.length);
      setTimeout(refresh, 0);
    });
    refresh();
  }

  // ── Care ──────────────────────────────────────────────────────────────────
  // Statuses a return ends in (request-return, process-return, return-tracking).
  const RETURN_DONE = ['refunded', 'wallet_issued', 'rejected', 'rto', 'closed', 'completed', 'cancelled'];
  const returnOpen = (r) => !RETURN_DONE.includes(String(r.status));
  const recentOpenReturn = (r) => returnOpen(r) && Date.now() - new Date(r.created_at).getTime() < 30 * 86400000;
  async function viewCare(tab, force) {
    const c = state.care;
    c.tab = tab || c.tab;
    const counts = c.counts || {};
    const unreadChats = (c.convs || []).filter(problemChat).length;
    const root = mount(appbar({ title: 'Customer care', actions: refreshBtn })
      + `<div class="seg">
        <button class="${c.tab === 'tickets' ? 'on' : ''}" data-t="tickets">Tickets${counts.unanswered ? `<span class="c">${counts.unanswered}</span>` : ''}</button>
        <button class="${c.tab === 'chats' ? 'on' : ''}" data-t="chats">WhatsApp${unreadChats ? `<span class="c">${unreadChats}</span>` : ''}</button>
        <button class="${c.tab === 'returns' ? 'on' : ''}" data-t="returns">Returns</button>
      </div><div data-body style="margin-top:12px">${skeletonList(5, 76)}</div>`, { tab: 'care' });
    root.querySelectorAll('[data-t]').forEach((b) => { b.onclick = () => { location.hash = '#/care/' + b.dataset.t; }; });
    const body = root.querySelector('[data-body]');
    try {
      if (c.tab === 'tickets') {
        if (force || !c.tickets || c.ticketFilterLoaded !== c.ticketFilter) {
          const data = await api('admin-support-tickets', { query: { status: c.ticketFilter } });
          c.tickets = data.tickets || [];
          if (data.counts) c.counts = data.counts;
          c.ticketFilterLoaded = c.ticketFilter;
        }
        body.innerHTML = ticketsHtml();
        body.querySelectorAll('[data-tf]').forEach((b) => { b.onclick = () => { c.ticketFilter = b.dataset.tf; viewCare('tickets'); }; });
      } else if (c.tab === 'chats') {
        if (force || !c.convs) c.convs = (await api('bot-inbox', { query: { action: 'list' } })).conversations || [];
        body.innerHTML = chatsHtml();
      } else {
        if (force || !c.returns) c.returns = (await api('get-return-requests')).returns || [];
        body.innerHTML = returnsHtml();
      }
      updateCareBadge();
      renderTabbar('care');
      if (c.scroll) { window.scrollTo(0, c.scroll); c.scroll = 0; }
    } catch (e) { if (!e.quiet) body.innerHTML = errorBox(e); }
  }
  function ticketsHtml() {
    const c = state.care;
    const counts = c.counts || {};
    const chips = [['active', `Open ${counts.active ?? ''}`], ['waiting', `Waiting ${counts.waiting ?? ''}`], ['closed', 'Closed']];
    const list = (c.tickets || []).slice().sort((a, b) => (b.overdue - a.overdue) || (new Date(b.created_at) - new Date(a.created_at)));
    return `<div class="chips" style="margin-top:0">${chips.map(([id, l]) => `<button class="chip ${id === c.ticketFilter ? 'on' : ''}" data-tf="${id}">${esc(l)}</button>`).join('')}</div>`
      + (list.length ? '<div class="card" style="padding:0;overflow:hidden;margin-top:8px">' + list.map((t, i) => `<a class="list-item" style="${i ? 'border-top:1px solid var(--line)' : ''}" href="#/ticket/${encodeURIComponent(t.id)}">
        <div class="oi-top"><span class="oi-id">${esc(t.ticket_no || 'Ticket')}</span><span class="oi-when">${esc(ago(t.created_at))}</span></div>
        <div class="oi-name ellipsis">${esc(t.customer_name || t.customer_email || t.customer_phone || 'Customer')}</div>
        <div class="oi-items clamp2">${esc(t.subject || t.message || '')}</div>
        <div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap"><span class="pill">${esc(t.category_label || t.category || '')}</span>
          ${t.overdue ? '<span class="pill red">Overdue</span>' : ''}${!t.first_response_at && t.status !== 'closed' ? '<span class="pill orange">Unanswered</span>' : ''}
          ${t.status === 'waiting_customer' ? '<span class="pill blue">Waiting on customer</span>' : ''}${t.order_id ? `<span class="pill gold">${esc(t.order_id)}</span>` : ''}</div>
      </a>`).join('') + '</div>' : '<div class="empty"><div class="e">✨</div>No tickets here.</div>');
  }
  function chatsHtml() {
    const order = { attention: 0, top: 1, low: 2, closed: 3 };
    const list = (state.care.convs || []).slice().sort((a, b) =>
      (problemChat(b) - problemChat(a)) || (new Date(b.last_message_at) - new Date(a.last_message_at)));
    if (!list.length) return '<div class="empty"><div class="e">💬</div>No conversations.</div>';
    return '<div class="card" style="padding:0;overflow:hidden">' + list.map((c, i) => `<a class="conv list-item" style="${i ? 'border-top:1px solid var(--line)' : ''}" href="#/chat/${encodeURIComponent(c.customer_phone)}">
      <div class="avatar">${esc(initials(c.customer_name || c.customer_phone))}</div>
      <div style="min-width:0"><div class="nm ellipsis">${esc(c.customer_name || '+' + c.customer_phone)}</div>
        <div class="lm ellipsis">${c.human_takeover ? '🙋 ' : ''}${esc(c.last_message || '')}</div>
        ${problemChat(c) ? `<span class="pill red" style="margin-top:4px">${esc(c.category_reason || 'Problem')}</span>` : c.status === 'resolved' ? '<span class="pill" style="margin-top:4px">Resolved</span>' : ''}</div>
      <div class="tm">${esc(ago(c.last_message_at))}${c.unread_count ? `<br><span class="badge-n">${c.unread_count}</span>` : ''}</div></a>`).join('') + '</div>';
  }
  function returnsHtml() {
    const list = (state.care.returns || []);
    const open = list.filter(recentOpenReturn);
    const stale = list.filter((r) => returnOpen(r) && !recentOpenReturn(r));
    const done = list.filter((r) => !returnOpen(r)).slice(0, 20);
    const card = (r, i) => `<div class="list-item" style="${i ? 'border-top:1px solid var(--line)' : ''}">
      <div class="oi-top"><a class="oi-id" href="#/order/${encodeURIComponent(r.order_display_id || r.order_id || '')}" style="color:var(--accent)">${esc(r.order_display_id || r.order_id || '')}</a><span class="oi-when">${esc(ago(r.created_at))}</span></div>
      <div class="oi-name ellipsis">${esc(r.customer_name || '')}</div>
      <div class="oi-items clamp2">${esc(r.reason || '')}</div>
      <div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap"><span class="pill ${RETURN_DONE.includes(String(r.status)) ? 'green' : 'blue'}">${esc(String(r.status || '').replace(/_/g, ' '))}</span>
        ${r.refund_method ? `<span class="pill">${r.refund_method === 'wallet' ? 'Store credit' : 'Original payment'}</span>` : ''}
        ${r.refund_amount_paise ? `<span class="pill gold">${rupees(r.refund_amount_paise / 100)}</span>` : ''}
        ${r.tracking_last_scan ? `<span class="pill purple">${esc(r.tracking_last_scan)}</span>` : ''}</div></div>`;
    return `<div class="section-title" style="margin-top:4px">Open · last 30 days · ${open.length}</div>`
      + (open.length ? '<div class="card" style="padding:0;overflow:hidden">' + open.map(card).join('') + '</div>' : '<div class="card empty">Nothing open.</div>')
      + (stale.length ? `<div class="section-title">Older, still open · ${stale.length}</div><div class="card" style="padding:0;overflow:hidden">${stale.slice(0, 30).map(card).join('')}</div>` : '')
      + (done.length ? `<div class="section-title">Recently finished</div><div class="card" style="padding:0;overflow:hidden">${done.map(card).join('')}</div>` : '')
      + '<a class="desk-link" href="/admin/?desktop=1#returns">Approve, push and refund on desktop</a>';
  }

  async function viewTicket(id) {
    const root = mount(appbar({ title: 'Ticket', back: '#/care/tickets', actions: refreshBtn }) + '<div data-body>' + skeletonList(3, 100) + '</div>', { noTabs: true });
    const body = root.querySelector('[data-body]');
    try {
      const { ticket: t, events = [], order } = await api('admin-support-tickets', { query: { id } });
      const h1 = root.querySelector('.appbar h1');
      if (h1) h1.textContent = t.ticket_no || 'Ticket';
      const phone = phoneDigits(t.customer_phone);
      body.innerHTML = `
        <div class="card">
          <div class="row between"><span class="pill">${esc(t.category_label || t.category || '')}</span><span class="pill ${t.status === 'closed' ? 'green' : t.overdue ? 'red' : 'blue'}">${esc(t.status === 'waiting_customer' ? 'Waiting on customer' : t.overdue && t.status !== 'closed' ? 'Overdue' : String(t.status).replace(/_/g, ' '))}</span></div>
          <div style="font-weight:800;font-size:1.05rem;margin-top:10px">${esc(t.customer_name || 'Customer')}</div>
          <div class="small muted">${esc(t.customer_email || '')}${t.customer_phone ? ' · ' + esc(t.customer_phone) : ''}</div>
          ${order ? `<a class="note" href="#/order/${encodeURIComponent(t.order_id || order.id)}" style="margin-top:12px;display:flex;justify-content:space-between"><span><b>${esc(t.order_id || order.id)}</b> · ${esc(String(order.status || '').replace(/_/g, ' '))}${order.awb ? ' · ' + esc(order.courier || '') + ' ' + esc(order.awb) : ''}</span><span>›</span></a>` : ''}
          <div class="actions">
            ${phone ? `<a class="act" href="tel:+${esc(phone)}">${ICON.phone}Call</a><a class="act" href="https://wa.me/${esc(phone)}" target="_blank" rel="noopener">${ICON.chat}WhatsApp</a>` : ''}
            <button class="act" data-more>${ICON.edit}Status</button>
          </div>
        </div>
        <div class="section-title">Conversation</div>
        <div class="thread">
          <div class="msg them">${esc(t.message || '')}<span class="w">${esc(fmtDateTime(t.created_at))}${t.evidence_count ? ` · ${t.evidence_count} attachment${t.evidence_count === 1 ? '' : 's'}` : ''}</span></div>
          ${events.filter((e) => e.kind !== 'created').map((e) => {
            const staff = e.actor && e.actor !== 'customer';
            const cls = e.internal ? 'internal' : e.kind === 'message' ? (staff ? 'me' : 'them') : 'sys';
            const text = e.kind === 'message' || e.internal ? e.body : (e.body || e.kind.replace(/_/g, ' '));
            return `<div class="msg ${cls}">${e.internal ? '<b>Note · </b>' : ''}${esc(text || '')}<span class="w">${esc(fmtDateTime(e.created_at))}${staff && e.actor ? ' · ' + esc(String(e.actor).replace(/^email:/, '')) : ''}</span></div>`;
          }).join('')}
        </div>
        ${t.status === 'closed' ? `<div class="note" style="margin-top:14px">Closed: ${esc(t.resolution || '')}</div>` : ''}
        <div class="composer"><div class="inner">
          <textarea rows="1" data-msg placeholder="${t.status === 'closed' ? 'Reopen to reply' : 'Reply — emails the customer'}" ${t.status === 'closed' ? 'disabled' : ''}></textarea>
          <button class="send-btn" data-send aria-label="Send reply" ${t.status === 'closed' ? 'disabled' : ''}>${ICON.send}</button>
        </div></div>`;
      const ta = body.querySelector('[data-msg]');
      autoGrow(ta);
      body.querySelector('[data-send]').onclick = async (ev) => {
        const message = ta.value.trim();
        if (!message) return;
        const ok = await confirmSheet({ title: 'Send this reply?', lead: `Emailed to ${esc(t.customer_email || 'the customer')}.`, ok: 'Send' });
        if (!ok) return;
        await busy(ev.currentTarget, async () => {
          try { await api('admin-support-tickets', { method: 'POST', body: { action: 'reply', id, message } }); toast('Reply sent'); viewTicket(id); }
          catch (e) { if (!e.quiet) toast('Not sent: ' + e.message, true); }
        });
      };
      body.querySelector('[data-more]').onclick = () => ticketActions(t);
      window.scrollTo(0, document.body.scrollHeight);
    } catch (e) { if (!e.quiet) body.innerHTML = errorBox(e); }
  }
  function ticketActions(t) {
    const closed = t.status === 'closed';
    const s = openSheet(`<h2>${esc(t.ticket_no || 'Ticket')}</h2><div class="lead">${esc(t.customer_name || '')}</div>
      ${closed ? `<button class="menu-item" data-a="reopen"><span class="ic">${ICON.refresh}</span><span>Reopen<small>Back to open</small></span></button>` : `
      <button class="menu-item" data-a="in_progress"><span class="ic">${ICON.edit}</span><span>In progress<small>You are working on it</small></span></button>
      <button class="menu-item" data-a="waiting_customer"><span class="ic">${ICON.chat}</span><span>Waiting on customer<small>Pauses the reply clock</small></span></button>
      <button class="menu-item" data-a="note"><span class="ic">${ICON.edit}</span><span>Add internal note<small>Never shown to the customer</small></span></button>
      <button class="menu-item" data-a="close"><span class="ic green">${ICON.check}</span><span>Close with resolution<small>Emails the customer the resolution</small></span></button>`}`);
    s.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => {
      const a = b.dataset.a;
      if (a === 'note' || a === 'close') return textSheet(t, a);
      busy(b, async () => {
        try {
          await api('admin-support-tickets', { method: 'POST', body: a === 'reopen' ? { action: 'reopen', id: t.id } : { action: 'status', id: t.id, status: a } });
          closeSheet(); toast('Updated'); state.care.tickets = null; viewTicket(t.id);
        } catch (e) { if (!e.quiet) toast(e.message, true); }
      });
    }; });
  }
  function textSheet(t, kind) {
    const close = kind === 'close';
    const s = openSheet(`<h2>${close ? 'Close ticket' : 'Internal note'}</h2><div class="lead">${close ? 'The customer is emailed this resolution.' : 'Only staff see this.'}</div>
      <label class="field"><span>${close ? 'Resolution' : 'Note'}</span><textarea data-t maxlength="2000"></textarea></label>
      <button class="btn block ${close ? '' : 'ghost'}" data-go>${close ? 'Close &amp; email customer' : 'Save note'}</button>`);
    s.querySelector('[data-t]').focus();
    s.querySelector('[data-go]').onclick = (e) => busy(e.currentTarget, async () => {
      const text = s.querySelector('[data-t]').value.trim();
      if (!text) { toast('Write something first', true); return; }
      try {
        await api('admin-support-tickets', { method: 'POST', body: close ? { action: 'close', id: t.id, resolution: text } : { action: 'note', id: t.id, body: text } });
        closeSheet(); toast(close ? 'Ticket closed' : 'Note saved'); state.care.tickets = null; viewTicket(t.id);
      } catch (err) { if (!err.quiet) toast(err.message, true); }
    });
  }

  async function viewChat(phone) {
    const conv = (state.care.convs || []).find((c) => c.customer_phone === phone) || { customer_phone: phone };
    const root = mount(appbar({ title: conv.customer_name || '+' + phone, back: '#/care/chats', actions: `<button class="icon-btn" data-menu aria-label="Chat actions">${ICON.more}</button>` })
      + '<div data-body>' + skeletonList(4, 54) + '</div>', { noTabs: true });
    const body = root.querySelector('[data-body]');
    root.querySelector('[data-menu]').onclick = () => chatActions(conv);
    let messages = [];
    let nextOffset = null;
    const draw = () => {
      body.innerHTML = `${nextOffset != null ? '<button class="more-btn" data-older style="margin:0 0 12px">Load earlier messages</button>' : ''}
        <div class="row" style="gap:6px;margin-bottom:12px;flex-wrap:wrap">${conv.human_takeover ? '<span class="pill gold">🙋 You are handling this</span>' : '<span class="pill">🤖 Bot is replying</span>'}${conv.status === 'resolved' ? '<span class="pill green">Resolved</span>' : ''}<a class="pill" href="tel:+${esc(phoneDigits(phone))}">📞 Call</a></div>
        <div class="thread">${messages.map((m) => `<div class="msg ${m.role === 'user' ? 'them' : m.role === 'admin' ? 'me' : 'bot'}">${esc(m.message || '')}<span class="w">${m.role === 'bot' ? 'Bot · ' : m.role === 'admin' ? 'You · ' : ''}${esc(fmtDateTime(m.created_at))}</span></div>`).join('') || '<div class="empty">No messages.</div>'}</div>
        <div class="composer"><div class="inner"><textarea rows="1" data-msg placeholder="Message on WhatsApp…"></textarea><button class="send-btn" data-send aria-label="Send">${ICON.send}</button></div></div>`;
      const older = body.querySelector('[data-older]');
      if (older) older.onclick = () => busy(older, async () => {
        const data = await api('bot-inbox', { query: { action: 'thread', phone, offset: nextOffset } });
        messages = (data.messages || []).concat(messages);
        nextOffset = data.next_offset;
        draw();
        window.scrollTo(0, 0);
      });
      const ta = body.querySelector('[data-msg]');
      autoGrow(ta);
      body.querySelector('[data-send]').onclick = (ev) => {
        const text = ta.value.trim();
        if (!text) return;
        busy(ev.currentTarget, async () => {
          try {
            await api('bot-inbox', { method: 'POST', body: { action: 'send', phone, text } });
            messages.push({ role: 'admin', message: text, created_at: new Date().toISOString() });
            conv.human_takeover = true;
            draw();
            window.scrollTo(0, document.body.scrollHeight);
          } catch (e) {
            if (!e.quiet) toast(/24|window|re-?engage/i.test(e.message) ? 'Not sent: more than 24 h since they last wrote — WhatsApp only allows templates now.' : 'Not sent: ' + e.message, true);
          }
        });
      };
    };
    try {
      const data = await api('bot-inbox', { query: { action: 'thread', phone } });
      messages = data.messages || [];
      nextOffset = data.next_offset;
      draw();
      window.scrollTo(0, document.body.scrollHeight);
      if (conv.unread_count) {
        api('bot-inbox', { method: 'POST', body: { action: 'mark_read', phone } }).then(() => { conv.unread_count = 0; updateCareBadge(); }).catch(() => {});
      }
    } catch (e) { if (!e.quiet) body.innerHTML = errorBox(e); }
  }
  function chatActions(conv) {
    const phone = conv.customer_phone;
    const s = openSheet(`<h2>${esc(conv.customer_name || '+' + phone)}</h2><div class="lead">WhatsApp conversation</div>
      ${conv.human_takeover
        ? `<button class="menu-item" data-a="release"><span class="ic">${ICON.bot}</span><span>Hand back to the bot<small>The bot answers new messages again</small></span></button>`
        : `<button class="menu-item" data-a="takeover"><span class="ic">${ICON.hand}</span><span>Take over<small>The bot stops replying to this customer</small></span></button>`}
      ${conv.status === 'resolved'
        ? `<button class="menu-item" data-a="reopen"><span class="ic">${ICON.refresh}</span><span>Reopen<small>Back to the open list</small></span></button>`
        : `<button class="menu-item" data-a="resolve"><span class="ic green">${ICON.check}</span><span>Mark resolved<small>Clears unread and hands back to the bot</small></span></button>`}
      <a class="menu-item" href="https://wa.me/${esc(phoneDigits(phone))}" target="_blank" rel="noopener"><span class="ic">${ICON.link}</span><span>Open in WhatsApp<small>From your own phone</small></span></a>`);
    s.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => busy(b, async () => {
      const a = b.dataset.a;
      try {
        await api('bot-inbox', { method: 'POST', body: { action: a, phone } });
        if (a === 'takeover') conv.human_takeover = true;
        if (a === 'release') conv.human_takeover = false;
        if (a === 'resolve') Object.assign(conv, { status: 'resolved', human_takeover: false, unread_count: 0 });
        if (a === 'reopen') conv.status = 'active';
        closeSheet(); toast('Done'); updateCareBadge(); viewChat(phone);
      } catch (e) { if (!e.quiet) toast(e.message, true); }
    }); });
  }
  function autoGrow(ta) {
    if (!ta) return;
    const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; };
    ta.addEventListener('input', fit);
  }

  // ── More ──────────────────────────────────────────────────────────────────
  function viewMore() {
    const theme = document.documentElement.getAttribute('data-theme') || 'system';
    const who = state.session ? String(state.session.sub || '').replace(/^email:/, '') : '';
    const desk = [
      ['orders', 'All orders & bulk tools'], ['profit', 'Net profit'], ['products', 'Full product editor'], ['coupons', 'Coupons'],
      ['returns', 'Returns & refunds'], ['notpicked', 'Not picked up'], ['reports', 'Reports'], ['bot', 'Bot settings'],
    ];
    const root = mount(appbar({ title: 'More', sub: who ? `Signed in as ${who}${state.session.role && state.session.role !== 'owner' ? ' · ' + state.session.role : ''}` : '' }) + `
      <div class="section-title">Appearance</div>
      <div class="seg" data-theme-seg>${[['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([id, l]) => `<button class="${theme === id ? 'on' : ''}" data-th="${id}">${l}</button>`).join('')}</div>
      <div class="section-title">Desktop admin</div>
      <div class="links">${desk.map(([id, l]) => `<a class="menu-item" href="/admin/?desktop=1#${id}"><span class="ic">${ICON.desktop}</span><span>${l}</span></a>`).join('')}</div>
      <div class="section-title">Store</div>
      <div class="links"><a class="menu-item" href="/" target="_blank" rel="noopener"><span class="ic">${ICON.link}</span><span>Open inkandchai.in</span></a>
      <button class="menu-item" data-out><span class="ic red">${ICON.out}</span><span>Sign out</span></button></div>
      <div class="foot">Ink &amp; Chai mobile admin</div>`, { tab: 'more' });
    root.querySelectorAll('[data-th]').forEach((b) => { b.onclick = () => {
      const v = b.dataset.th;
      try { if (v === 'system') localStorage.removeItem('iac_m_theme'); else localStorage.setItem('iac_m_theme', v); } catch (e) {}
      if (v === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', v);
      viewMore();
    }; });
    root.querySelector('[data-out]').onclick = async () => {
      if (!(await confirmSheet({ title: 'Sign out?', ok: 'Sign out', danger: true }))) return;
      await fetch(FN + 'admin-logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
      state.session = null;
      showLogin();
    };
  }

  // ── Router ────────────────────────────────────────────────────────────────
  function rememberScroll() {
    const h = location.hash;
    if (h.startsWith('#/orders')) state.orders.scroll = window.scrollY;
    else if (h.startsWith('#/products')) state.products.scroll = window.scrollY;
    else if (h.startsWith('#/care')) state.care.scroll = window.scrollY;
  }
  function route(force) {
    if (!state.session) return;
    closeSheet();
    const parts = (location.hash.replace(/^#\/?/, '') || 'today').split('/');
    const [view, arg] = [parts[0], parts.slice(1).map(decodeURIComponent).join('/')];
    if (!force) window.scrollTo(0, 0);
    switch (view) {
      case 'orders': return viewOrders();
      case 'order': return viewOrder(arg);
      case 'products': return viewProducts();
      case 'product': return viewProduct(arg);
      case 'care': return viewCare(arg || undefined);
      case 'ticket': return viewTicket(arg);
      case 'chat': return viewChat(arg);
      case 'more': return viewMore();
      default: return viewToday();
    }
  }
  window.addEventListener('hashchange', () => {
    sessionStorage.setItem('iac_m_nav', '1');
    route();
  });
  // Lists keep their scroll position when you open an item and come back.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#/"]');
    if (a) rememberScroll();
  }, true);
  document.addEventListener('click', (e) => {
    const r = e.target.closest('[data-refresh]');
    if (!r) return;
    r.classList.add('spin');
    const h = location.hash.replace(/^#\/?/, '') || 'today';
    if (h.startsWith('orders')) { resetOrders(); viewOrders(); }
    else if (h.startsWith('order/')) { viewOrder.force = true; route(true); }
    else if (h.startsWith('care')) viewCare(undefined, true);
    else if (h.startsWith('today') || h === '') viewToday(true);
    else route(true);
  });

  async function start() {
    try {
      const res = await fetch(FN + 'admin-session', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) { showLogin(); return; }
      state.session = await res.json();
    } catch (e) {
      app.innerHTML = `<div class="login"><div class="box">${errorBox(new Error('No connection. Pull down or reopen to try again.'))}</div></div>`;
      return;
    }
    route();
    // Fill the Care badge in the background when the first screen is not Today.
    if (!/^#\/?(today)?$/.test(location.hash || '#/today')) {
      Promise.allSettled([api('admin-support-tickets', { query: { status: 'active' } }), api('bot-inbox', { query: { action: 'list' } })]).then(([t, c]) => {
        if (t.status === 'fulfilled') { state.care.counts = t.value.counts; state.care.tickets = t.value.tickets || []; state.care.ticketFilterLoaded = 'active'; }
        if (c.status === 'fulfilled') state.care.convs = c.value.conversations || [];
        updateCareBadge();
        if (!tabbar.hidden) renderTabbar((location.hash.replace(/^#\/?/, '').split('/')[0]) || 'today');
      });
    }
  }
  start();
})();
