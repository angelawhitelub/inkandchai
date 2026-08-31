/**
 * cart.js — Akshar & Co.
 * Cart state lives in localStorage.
 * Exposes: addToCart, openCart, closeCart, getCart
 */

const CART_KEY = 'akshar_cart';

// ── State ──────────────────────────────────────────────────────────────────
function getCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; }
  catch { return []; }
}

function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  updateCartUI();
}

// ── Add / Remove ───────────────────────────────────────────────────────────
function addToCart(book) {
  const cart = getCart();
  const existing = cart.find(i => i.id === book.id);
  if (existing) {
    existing.qty += 1;
  } else {
    cart.push({ ...book, qty: 1 });
  }
  saveCart(cart);
  // Meta AddToCart. iacMeta is defined by the pixel snippet in the page head,
  // so it is present on every page that loads this file; the guard covers the
  // case where the pixel is blocked by an ad blocker. Not deduped — adding the
  // same book twice is two genuine add-to-cart actions.
  if (window.iacMeta) {
    window.iacMeta('AddToCart', {
      content_ids: [String(book.id || book.url || '')],
      content_type: 'product',
      content_name: String(book.title || ''),
      currency: 'INR',
      value: Number(book.price) || 0,
    });
  }
  openCart();
  showToast(`"${book.title.slice(0, 30)}…" added to cart`);
}

function removeFromCart(id) {
  saveCart(getCart().filter(i => i.id !== id));
}

function updateQty(id, delta) {
  const cart = getCart();
  const item = cart.find(i => i.id === id);
  if (!item) return;
  item.qty = Math.max(1, item.qty + delta);
  saveCart(cart);
}

function clearCart() {
  saveCart([]);
}

// ── Shipping rules (must match server-side cod-order.js / verify-payment.js) ─
const FREE_SHIPPING_THRESHOLD = 499;   // ₹499 → free shipping
const SHIPPING_FEE            = 40;    // Below ₹499 → flat ₹40 Delhivery
window.calcShipping = function(subtotal) {
  return subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE;
};

// ── UI helpers ─────────────────────────────────────────────────────────────
function updateCartUI() {
  const cart  = getCart();
  const total = cart.reduce((s, i) => s + i.qty, 0);
  const sum   = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const shipping = window.calcShipping(sum);
  const grand    = sum + shipping;

  // Nav badge (desktop top + mobile bottom) — bump animation when count changes
  ['cartBadge', 'cartBadgeMobile'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const prev = el._iacPrevCount;
    el.textContent = total > 0 ? total : '';
    el.style.display = total > 0 ? 'inline-flex' : 'none';
    if (total > 0 && prev !== undefined && total !== prev) {
      el.classList.remove('bump');
      void el.offsetWidth;            // restart animation
      el.classList.add('bump');
    }
    el._iacPrevCount = total;
  });

  // Sidebar items
  const itemsEl = document.getElementById('cartItems');
  const emptyEl = document.getElementById('cartEmpty');
  const footerEl = document.getElementById('cartFooter');
  const totalEl  = document.getElementById('cartTotal');

  if (!itemsEl) return;

  if (cart.length === 0) {
    itemsEl.innerHTML = '';
    if (emptyEl)  emptyEl.style.display = 'block';
    if (footerEl) footerEl.style.display = 'none';
    return;
  }

  if (emptyEl)  emptyEl.style.display = 'none';
  if (footerEl) footerEl.style.display = 'flex';
  if (totalEl) {
    if (shipping === 0) {
      totalEl.innerHTML = `₹ ${grand.toLocaleString('en-IN', { minimumFractionDigits: 2 })}<div style="font-size:0.55rem;color:var(--ship-free,#2f6e37);letter-spacing:0.15em;text-transform:uppercase;font-family:'Montserrat',sans-serif;font-weight:500;margin-top:4px;">✓ Free Shipping</div>`;
    } else {
      // The free-shipping gap is stated once, on the progress bar above the
      // add-on rows -- repeating it here just said the same sentence twice.
      totalEl.innerHTML = `₹ ${grand.toLocaleString('en-IN', { minimumFractionDigits: 2 })}<div style="font-size:0.6rem;color:var(--muted,#a09080);font-family:'Montserrat',sans-serif;margin-top:4px;letter-spacing:0.05em;">Subtotal ₹${sum.toLocaleString('en-IN')} + Shipping ₹${shipping}</div>`;
    }
  }

  itemsEl.innerHTML = cart.map(item => `
    <div class="cart-item" data-id="${item.id}">
      <div class="cart-item-img">
        ${item.img
          ? `<img src="${iacImg(item.img,140)}" alt="${esc(item.title)}" loading="lazy" onerror="this.style.display='none'" />`
          : `<div class="cart-item-img-placeholder"></div>`}
      </div>
      <div class="cart-item-info">
        <div class="cart-item-title">${esc(item.title)}</div>
        <div class="cart-item-author">${esc(item.author || '')}</div>
        <div class="cart-item-price">₹ ${(item.price * item.qty).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
        <div class="cart-item-controls">
          <button class="qty-btn" onclick="updateQty('${item.id}', -1); renderCart()">−</button>
          <span class="qty-num">${item.qty}</span>
          <button class="qty-btn" onclick="updateQty('${item.id}', +1); renderCart()">+</button>
          <button class="cart-remove" onclick="removeFromCart('${item.id}'); renderCart()">Remove</button>
        </div>
      </div>
    </div>
  `).join('');

  // Free-delivery progress + add-ons, redrawn whenever the drawer is.
  try { renderCartRecommendations(); } catch (e) { /* never break the cart */ }
}

// ── Cart drawer: free-delivery progress + one-tap add-ons ──────────────────
// 84% of orders are a single book, and a single-book order averages Rs 311
// against a Rs 499 free-shipping threshold. So the customer is usually a couple
// of hundred rupees short and is never told what would close the gap. This
// shows the gap, and puts two books that people genuinely bought alongside what
// is already in the basket one tap away from it.
//
// Recommendations come from /frequently-bought, which ranks real co-purchases
// first and units actually sold second, so these are not "similar titles" --
// they are what other customers put in the same parcel.
const IAC_REC_CACHE = new Map();
let _iacRecToken = 0;

function iacCartSlug(item) {
  const m = String((item && (item.url || item.id)) || '').match(/\/product\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : '';
}

function injectCartRecStyles() {
  if (document.getElementById('iacCartRecStyles')) return;
  const style = document.createElement('style');
  style.id = 'iacCartRecStyles';
  style.textContent = `
    .iac-ship-nudge{margin:1rem 0 .2rem;padding:.75rem .85rem;border:1px solid rgba(201,168,76,.28);background:rgba(201,168,76,.07)}
    .iac-ship-nudge.is-free{border-color:rgba(109,191,109,.4);background:rgba(109,191,109,.08)}
    .iac-ship-text{font:600 .58rem Montserrat,sans-serif;letter-spacing:.13em;text-transform:uppercase;color:var(--gold,#c9a84c)}
    .iac-ship-nudge.is-free .iac-ship-text{color:#2f6e37}html:not([data-theme="light"]) .iac-ship-nudge.is-free .iac-ship-text{color:#6dbf6d}
    .iac-ship-bar{height:4px;margin-top:.5rem;background:rgba(138,106,31,.18);overflow:hidden}
    .iac-ship-fill{height:100%;background:var(--gold,#c9a84c);transition:width .35s ease}
    .iac-ship-nudge.is-free .iac-ship-fill{background:#6dbf6d}
    .iac-cart-rec{margin:.9rem 0 .3rem}
    .iac-cart-rec-head{font:600 .56rem Montserrat,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--muted,#a09080);margin-bottom:.6rem}
    .iac-cart-rec-row{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:.6rem;align-items:center;padding:.55rem 0;border-top:1px solid rgba(138,106,31,.14)}
    .iac-cart-rec-img{width:44px;aspect-ratio:2/3;overflow:hidden;background:rgba(138,106,31,.06)}
    .iac-cart-rec-img img{width:100%;height:100%;object-fit:cover;display:block}
    .iac-cart-rec-name{font-family:'Cormorant Garamond',serif;font-size:.88rem;line-height:1.25;color:var(--cream,#f0e8d8);display:-webkit-box;-webkit-line-clamp:2;line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .iac-cart-rec-meta{font:.6rem Montserrat,sans-serif;color:var(--muted,#a09080);margin-top:.15rem}
    .iac-cart-rec-price{font-family:'Cormorant Garamond',serif;font-size:.95rem;color:var(--gold,#c9a84c);font-weight:600}
    .iac-cart-rec-add{display:block;margin-top:.25rem;font:700 .52rem Montserrat,sans-serif;letter-spacing:.12em;text-transform:uppercase;padding:.4rem .55rem;background:transparent;color:var(--gold,#c9a84c);border:1px solid var(--gold,#c9a84c);cursor:pointer;white-space:nowrap;min-height:32px}
    .iac-cart-rec-add:hover{background:var(--gold,#c9a84c);color:var(--bg,#0d0b08)}
    .iac-cart-rec-add[disabled]{opacity:.55;cursor:default}
  `;
  document.head.appendChild(style);
}

function cartRecHost() {
  let host = document.getElementById('iacCartRec');
  if (host) return host;
  const items = document.getElementById('cartItems');
  if (!items || !items.parentNode) return null;
  host = document.createElement('div');
  host.id = 'iacCartRec';
  items.insertAdjacentElement('afterend', host);
  return host;
}

// The free-delivery gap, drawn. Shown even at zero remaining, because "you have
// free delivery" is the reward that makes the next nudge credible.
function shipNudgeHtml(subtotal) {
  const need = Math.max(0, FREE_SHIPPING_THRESHOLD - subtotal);
  const pct = Math.max(0, Math.min(100, Math.round((subtotal / FREE_SHIPPING_THRESHOLD) * 100)));
  if (need <= 0) {
    return `<div class="iac-ship-nudge is-free">
      <div class="iac-ship-text">&#10003; You have free delivery</div>
      <div class="iac-ship-bar"><div class="iac-ship-fill" style="width:100%"></div></div>
    </div>`;
  }
  return `<div class="iac-ship-nudge">
    <div class="iac-ship-text">Add &#8377;${need.toLocaleString('en-IN')} more for FREE delivery</div>
    <div class="iac-ship-bar"><div class="iac-ship-fill" style="width:${pct}%"></div></div>
  </div>`;
}

function recRowHtml(product) {
  const price = Number(product.price) || 0;
  const payload = encodeURIComponent(JSON.stringify({
    id: product.id || product.url, url: product.url, title: product.title,
    author: product.author || '', price, img: product.img || '', qty: 1,
  }));
  return `<div class="iac-cart-rec-row">
    <div class="iac-cart-rec-img">${product.img
      ? `<img src="${iacImg(product.img, 120)}" alt="${esc(product.title)}" loading="lazy" onerror="this.style.display='none'"/>`
      : ''}</div>
    <div>
      <div class="iac-cart-rec-name">${esc(product.title)}</div>
      <div class="iac-cart-rec-meta">${esc(product.author || '')}</div>
    </div>
    <div style="text-align:right;">
      <div class="iac-cart-rec-price">&#8377; ${price.toLocaleString('en-IN')}</div>
      <button class="iac-cart-rec-add" onclick="iacAddRecommended('${payload}', this)">+ Add</button>
    </div>
  </div>`;
}

function iacAddRecommended(payload, btn) {
  let item;
  try { item = JSON.parse(decodeURIComponent(payload)); } catch (e) { return; }
  if (!item || !item.id) return;
  try {
    const cart = getCart();
    const existing = cart.find(i => i.id === item.id);
    if (existing) existing.qty += 1;
    else cart.push(item);
    saveCart(cart);
  } catch (e) { return; }
  if (btn) { btn.textContent = '✓ Added'; btn.disabled = true; }
  // Re-render so the free-delivery bar moves immediately — that movement is the
  // whole point of showing it.
  if (typeof updateCartUI === 'function') updateCartUI();
}

async function renderCartRecommendations() {
  const host = cartRecHost();
  if (!host) return;
  const cart = getCart();
  if (!cart.length) { host.innerHTML = ''; return; }

  const subtotal = cart.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 1), 0);
  injectCartRecStyles();
  host.innerHTML = shipNudgeHtml(subtotal);

  // Seed off the priciest book in the basket: it is the most characteristic of
  // what this customer is shopping for, and its partners are the ones most
  // likely to clear the remaining gap.
  const seedItem = cart.slice().sort((a, b) => (Number(b.price) || 0) - (Number(a.price) || 0))[0];
  const seed = iacCartSlug(seedItem);
  if (!seed) return;

  const inCart = cart.map(iacCartSlug).filter(Boolean);
  const key = seed + '|' + inCart.slice().sort().join(',');
  const token = ++_iacRecToken;

  let data = IAC_REC_CACHE.get(key);
  if (!data) {
    try {
      const res = await fetch(`/.netlify/functions/frequently-bought?slug=${encodeURIComponent(seed)}`
        + `&limit=2&exclude=${encodeURIComponent(inCart.join(','))}`);
      if (!res.ok) return;
      data = await res.json();
      IAC_REC_CACHE.set(key, data);
    } catch (e) { return; }
  }
  // The cart changed while we were fetching — a stale list would be wrong.
  if (token !== _iacRecToken) return;

  const recs = (data.recommendations || []).filter(p => p && p.title && Number(p.price) > 0).slice(0, 2);
  if (!recs.length) return;

  host.innerHTML = shipNudgeHtml(subtotal)
    + `<div class="iac-cart-rec">
        <div class="iac-cart-rec-head">${data.basis === 'co_purchase' ? 'Readers also bought' : 'You may also like'}</div>
        ${recs.map(recRowHtml).join('')}
      </div>`;
}

function renderCart() { updateCartUI(); }

function openCart() {
  const sidebar = document.getElementById('cartSidebar');
  const overlay = document.getElementById('cartOverlay');
  if (sidebar) sidebar.classList.add('open');
  if (overlay) overlay.classList.add('show');
  document.body.style.overflow = 'hidden';
  updateCartUI();
}

function closeCart() {
  const sidebar = document.getElementById('cartSidebar');
  const overlay = document.getElementById('cartOverlay');
  if (sidebar) sidebar.classList.remove('open');
  if (overlay) overlay.classList.remove('show');
  document.body.style.overflow = '';
}

// Route same-site covers through Netlify Image CDN (resize + webp) to cut image
// bandwidth. Leaves data:, external, and legacy image-proxy URLs untouched.
function iacImg(src, w) {
  var s = String(src || '');
  if (!s || s.startsWith('data:')) return s;
  var p = s.replace(/^https?:\/\/inkandchai\.in/i, '');
  if (!(p.startsWith('/images/') || p.startsWith('/spimg/') || p.startsWith('/.netlify/functions/image-proxy'))) return s;
  return '/.netlify/images?url=' + encodeURIComponent(p) + '&w=' + w + '&fm=webp&q=72';
}

function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Toast ──────────────────────────────────────────────────────────────────
function showToast(msg) {
  let t = document.getElementById('toastEl');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toastEl';
    t.style.cssText = `
      position:fixed; bottom:2rem; left:50%; transform:translateX(-50%) translateY(20px);
      background:#c9a84c; color:#0d0b08; padding:0.8rem 1.6rem;
      font-family:'Montserrat',sans-serif; font-size:0.72rem; letter-spacing:0.08em;
      opacity:0; transition:all 0.3s; z-index:9999; pointer-events:none;
      white-space:nowrap; max-width:90vw; text-overflow:ellipsis; overflow:hidden;
    `;
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  t.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateX(-50%) translateY(20px)';
  }, 2800);
}

// ── Init on DOM ready ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  updateCartUI();
  initAplusContent();
  initProductCouponBadge();
  initFrequentlyBoughtTogether();

  // Close cart on overlay click
  const overlay = document.getElementById('cartOverlay');
  if (overlay) overlay.addEventListener('click', closeCart);

  // ESC key closes cart
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeCart();
  });
});

async function initProductCouponBadge() {
  if (!isProductDetailPage()) return;
  const slug = getProductPageSlug();
  if (!slug || document.getElementById('iacProductCouponBadge')) return;
  try {
    const res = await fetch(`/.netlify/functions/product-coupons?slugs=${encodeURIComponent(slug)}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const coupon = data.coupons?.[0];
    if (!coupon) return;
    const offer = coupon.discount_type === 'percent'
      ? `${Number(coupon.discount_value)}% off`
      : `₹${Number(coupon.discount_value).toLocaleString('en-IN')} off`;
    const badge = document.createElement('div');
    badge.id = 'iacProductCouponBadge';
    badge.setAttribute('role', 'note');
    badge.style.cssText = 'display:inline-flex;align-items:center;gap:.45rem;margin:.65rem 0;padding:.55rem .75rem;border:1px solid rgba(201,168,76,.45);border-radius:8px;background:rgba(201,168,76,.09);color:var(--gold,#c9a84c);font-size:.72rem;line-height:1.4;font-weight:700;';
    badge.innerHTML = `🏷️ <span>${esc(coupon.label || offer)} · Use <strong>${esc(coupon.code)}</strong> at checkout</span>`;
    const price = document.querySelector('[data-product-price], .price');
    const stock = document.querySelector('.stock');
    const anchor = stock || price?.parentElement;
    if (anchor) anchor.insertAdjacentElement('afterend', badge);
  } catch (err) {
    console.warn('Product offer unavailable:', err.message);
  }
}

// ── Frequently Bought Together ─────────────────────────────────────────────
function isProductDetailPage() {
  const parts = location.pathname.split('/').filter(Boolean);
  return parts[0] === 'product' && Boolean(parts[1]);
}

function getProductPageSlug() {
  const parts = location.pathname.split('/').filter(Boolean);
  return parts[0] === 'product' && parts[1] ? parts[1].toLowerCase() : '';
}

// ── A+ Content ─────────────────────────────────────────────────────────────
// Insert the A+ host synchronously BEFORE the existing reels anchor. The reels
// implementation stays untouched, and FBT keeps inserting after the anchor,
// giving a stable order: A+ → reels → frequently bought together.
function initAplusContent() {
  if (!isProductDetailPage()) return;
  let host = document.querySelector('[data-iac-aplus]');
  const reelsAnchor = document.querySelector('[data-iac-reels], #bookstagramContent');
  const main = document.querySelector('main.wrap') || document.querySelector('main') || document.getElementById('productContent');
  if (!host) {
    host = document.createElement('section');
    host.setAttribute('data-iac-aplus', '');
    host.hidden = true;
    if (reelsAnchor && reelsAnchor.parentNode) reelsAnchor.insertAdjacentElement('beforebegin', host);
    else if (main && main.parentNode) main.insertAdjacentElement('afterend', host);
  }
  if (document.getElementById('iac-aplus-js')) {
    if (window.IACAplus) window.IACAplus.init();
    return;
  }
  const script = document.createElement('script');
  script.id = 'iac-aplus-js';
  script.src = '/js/aplus-content.js';
  script.defer = true;
  document.head.appendChild(script);
}

function getCurrentProductItem() {
  try {
    if (typeof currentItem !== 'undefined' && currentItem && currentItem.title) return currentItem;
  } catch {}
  return null;
}

function formatFbtPrice(value) {
  const n = Number(value) || 0;
  return '₹ ' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function itemFromFbtProduct(product) {
  return {
    id: product.id || product.url || `/product/${product.slug}/`,
    title: product.title || '',
    author: product.author || '',
    price: Number(product.price) || 0,
    img: product.img || '',
    url: product.url || `/product/${product.slug}/`,
    sku: product.sku || '',
    qty: 1,
  };
}

function injectFbtStyles() {
  if (document.getElementById('iacFbtStyles')) return;
  const style = document.createElement('style');
  style.id = 'iacFbtStyles';
  style.textContent = `
    .iac-fbt{max-width:1260px;margin:1.7rem auto 0;padding:0 1rem}
    .iac-fbt-inner{border:1px solid var(--border,rgba(138,106,31,.28));background:var(--panel,#fff);padding:1.2rem}
    .iac-fbt-head{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;margin-bottom:.85rem}
    .iac-fbt-title{font-family:"Cormorant Garamond",serif;font-size:1.45rem;line-height:1.1;color:var(--cream,#2a2018);font-weight:500}
    .iac-fbt-sub{font-size:.62rem;letter-spacing:.16em;text-transform:uppercase;color:var(--muted,#5a4a38);margin-top:.25rem}
    .iac-fbt-list{display:grid;gap:.65rem}
    .iac-fbt-row{display:grid;grid-template-columns:auto 52px minmax(0,1fr) auto;gap:.75rem;align-items:center;border-top:1px solid var(--border,rgba(138,106,31,.22));padding-top:.65rem}
    .iac-fbt-check{width:20px;height:20px;accent-color:var(--gold,#8a6a1f);cursor:pointer}
    .iac-fbt-img{width:52px;aspect-ratio:2/3;border:1px solid var(--border,rgba(138,106,31,.22));background:rgba(138,106,31,.06);overflow:hidden}
    .iac-fbt-img img{width:100%;height:100%;object-fit:cover;display:block}
    .iac-fbt-name{font-family:"Cormorant Garamond",serif;font-size:1rem;line-height:1.2;color:var(--cream,#2a2018);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .iac-fbt-author{font-size:.64rem;letter-spacing:.06em;color:var(--muted,#5a4a38);margin-top:.15rem}
    .iac-fbt-pill{display:inline-block;margin-left:.45rem;font:600 .52rem Montserrat,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--gold,#8a6a1f);border:1px solid var(--border,rgba(138,106,31,.28));padding:.12rem .35rem;vertical-align:middle}
    .iac-fbt-price{text-align:right;font-family:"Cormorant Garamond",serif;font-size:1.08rem;color:var(--gold,#8a6a1f);font-weight:600;white-space:nowrap}
    .iac-fbt-orig{display:block;font:.68rem Montserrat,sans-serif;color:var(--muted,#5a4a38);text-decoration:line-through;font-weight:400}
    .iac-fbt-foot{display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-top:1rem;padding-top:1rem;border-top:1px dashed var(--border,rgba(138,106,31,.28));flex-wrap:wrap}
    .iac-fbt-total-label{display:block;font-size:.58rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted,#5a4a38)}
    .iac-fbt-total{font-family:"Cormorant Garamond",serif;font-size:1.55rem;color:var(--gold,#8a6a1f);font-weight:600}
    .iac-fbt-btn{font:700 .62rem Montserrat,sans-serif;letter-spacing:.2em;text-transform:uppercase;padding:.95rem 1.4rem;background:var(--gold,#8a6a1f);color:var(--bg,#fff);border:1px solid var(--gold,#8a6a1f);cursor:pointer}
    .iac-fbt-btn:hover{filter:brightness(1.05);transform:translateY(-1px)}
    @media(max-width:760px){
      .iac-fbt{margin:1.2rem auto 0;padding:0 1rem 0}
      .iac-fbt-inner{padding:1rem}
      .iac-fbt-row{grid-template-columns:auto 44px minmax(0,1fr);gap:.6rem}
      .iac-fbt-img{width:44px}
      .iac-fbt-price{grid-column:3;text-align:left;font-size:.95rem}
      .iac-fbt-foot{display:block}
      .iac-fbt-btn{width:100%;margin-top:.8rem}
    }
  `;
  document.head.appendChild(style);
}

function updateInjectedFbtTotal() {
  const rows = document.querySelectorAll('[data-iac-fbt-row]');
  let total = 0;
  let count = 0;
  rows.forEach((row) => {
    const check = row.querySelector('.iac-fbt-check');
    if (!check || !check.checked) return;
    total += Number(row.dataset.price) || 0;
    count += 1;
  });
  const totalEl = document.getElementById('iacFbtTotal');
  const countEl = document.getElementById('iacFbtCount');
  if (totalEl) totalEl.textContent = formatFbtPrice(total);
  if (countEl) countEl.textContent = `${count} selected`;
}

function addInjectedFbtToCart(button) {
  const rows = document.querySelectorAll('[data-iac-fbt-row]');
  const selected = [];
  rows.forEach((row) => {
    const check = row.querySelector('.iac-fbt-check');
    if (!check || !check.checked) return;
    try {
      selected.push(JSON.parse(row.dataset.item || '{}'));
    } catch {}
  });
  if (!selected.length) {
    showToast('Select at least one book');
    return;
  }

  if (button) {
    button.disabled = true;
    button.textContent = 'Adding...';
  }
  localStorage.removeItem('iac_buy_now_cart');
  const cart = getCart();
  selected.forEach((item) => {
    const clean = { ...item, qty: 1 };
    const existing = cart.find((cartItem) => cartItem.id === clean.id);
    if (existing) existing.qty = (existing.qty || 1) + 1;
    else cart.push(clean);
  });
  saveCart(cart);
  setTimeout(() => {
    if (button) {
      button.disabled = false;
      button.textContent = '+ Add selected bundle';
    }
    openCart();
    showToast(`${selected.length} books added to cart`);
  }, 180);
}

function renderInjectedFbt(data) {
  const current = getCurrentProductItem();
  const recommendations = Array.isArray(data.recommendations) ? data.recommendations.slice(0, 3) : [];
  if (!current || !recommendations.length) return;

  const existing = document.getElementById('iacFbtSection');
  if (existing) existing.remove();

  injectFbtStyles();
  const currentItemForCart = {
    ...current,
    id: current.id || current.url || location.pathname,
    url: current.url || location.pathname,
    price: Number(current.price) || 0,
    qty: 1,
  };
  const items = [currentItemForCart, ...recommendations.map(itemFromFbtProduct)];
  const rows = items.map((item, index) => {
    const original = index > 0 ? recommendations[index - 1]?.originalPrice || 0 : 0;
    const href = item.url || '#';
    const encoded = esc(JSON.stringify(item));
    return `
      <div class="iac-fbt-row" data-iac-fbt-row data-price="${Number(item.price) || 0}" data-item="${encoded}">
        <input class="iac-fbt-check" type="checkbox" checked onchange="updateInjectedFbtTotal()" aria-label="Select ${esc(item.title)}">
        <a class="iac-fbt-img" href="${esc(href)}" ${index === 0 ? 'onclick="event.preventDefault()"' : ''}>
          ${item.img ? `<img src="${esc(iacImg(item.img,140))}" alt="${esc(item.title)} cover" loading="lazy">` : ''}
        </a>
        <div>
          <div class="iac-fbt-name">${esc(item.title)}${index === 0 ? '<span class="iac-fbt-pill">This item</span>' : ''}</div>
          <div class="iac-fbt-author">${esc(item.author || '')}</div>
        </div>
        <div class="iac-fbt-price">
          ${formatFbtPrice(item.price)}
          ${original > item.price ? `<span class="iac-fbt-orig">${formatFbtPrice(original)}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');

  const section = document.createElement('section');
  section.id = 'iacFbtSection';
  section.className = 'iac-fbt';
  section.innerHTML = `
    <div class="iac-fbt-inner">
      <div class="iac-fbt-head">
        <div>
          <div class="iac-fbt-title">Frequently bought together</div>
          <div class="iac-fbt-sub">Smart picks based on this book, category, author and price range</div>
        </div>
        <div class="iac-fbt-sub" id="iacFbtCount">0 selected</div>
      </div>
      <div class="iac-fbt-list">${rows}</div>
      <div class="iac-fbt-foot">
        <div>
          <span class="iac-fbt-total-label">Bundle total</span>
          <span class="iac-fbt-total" id="iacFbtTotal">₹ 0</span>
        </div>
        <button class="iac-fbt-btn" onclick="addInjectedFbtToCart(this)">+ Add selected bundle</button>
      </div>
    </div>
  `;

  // Place the FBT bar directly BELOW the #InkAndChaiBookstagram reels so the
  // reels always sit above it. The reels container ([data-iac-reels] on static
  // pages, #bookstagramContent on the dynamic template) is server-rendered and
  // present in the DOM even before reels.js finishes, so it's a stable anchor.
  // Fall back to just-after-<main> when no reels strip exists on the page.
  const reelsAnchor = document.querySelector('[data-iac-reels], #bookstagramContent');
  const main = document.querySelector('main.wrap') || document.querySelector('main') || document.getElementById('productContent');
  if (reelsAnchor && reelsAnchor.parentNode) {
    reelsAnchor.insertAdjacentElement('afterend', section);
  } else if (main && main.parentNode) {
    main.insertAdjacentElement('afterend', section);
  }
  updateInjectedFbtTotal();
}

async function initFrequentlyBoughtTogether() {
  if (!isProductDetailPage()) return;
  if (document.getElementById('fbtContent')) return;
  const slug = getProductPageSlug();
  if (!slug) return;

  try {
    const res = await fetch(`/.netlify/functions/frequently-bought?slug=${encodeURIComponent(slug)}`, { cache: 'force-cache' });
    if (!res.ok) return;
    const data = await res.json();
    renderInjectedFbt(data);
  } catch (err) {
    console.warn('Frequently bought together unavailable:', err.message);
  }
}
