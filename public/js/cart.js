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

  // Nav badge (desktop top + mobile bottom)
  ['cartBadge', 'cartBadgeMobile'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = total > 0 ? total : '';
    el.style.display = total > 0 ? 'inline-flex' : 'none';
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
      totalEl.innerHTML = `₹ ${grand.toLocaleString('en-IN', { minimumFractionDigits: 2 })}<div style="font-size:0.55rem;color:#6dbf6d;letter-spacing:0.15em;text-transform:uppercase;font-family:'Montserrat',sans-serif;font-weight:500;margin-top:4px;">✓ Free Shipping</div>`;
    } else {
      const need = FREE_SHIPPING_THRESHOLD - sum;
      totalEl.innerHTML = `₹ ${grand.toLocaleString('en-IN', { minimumFractionDigits: 2 })}<div style="font-size:0.6rem;color:#a09080;font-family:'Montserrat',sans-serif;margin-top:4px;letter-spacing:0.05em;">Subtotal ₹${sum.toLocaleString('en-IN')} + Shipping ₹${shipping}</div><div style="font-size:0.55rem;color:#c9a84c;letter-spacing:0.15em;text-transform:uppercase;font-family:'Montserrat',sans-serif;font-weight:500;margin-top:4px;">Add ₹${need} more for free shipping</div>`;
    }
  }

  itemsEl.innerHTML = cart.map(item => `
    <div class="cart-item" data-id="${item.id}">
      <div class="cart-item-img">
        ${item.img
          ? `<img src="${item.img}" alt="${esc(item.title)}" loading="lazy" onerror="this.style.display='none'" />`
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
  initFrequentlyBoughtTogether();

  // Close cart on overlay click
  const overlay = document.getElementById('cartOverlay');
  if (overlay) overlay.addEventListener('click', closeCart);

  // ESC key closes cart
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeCart();
  });
});

// ── Frequently Bought Together ─────────────────────────────────────────────
function isProductDetailPage() {
  const parts = location.pathname.split('/').filter(Boolean);
  return parts[0] === 'product' && Boolean(parts[1]);
}

function getProductPageSlug() {
  const parts = location.pathname.split('/').filter(Boolean);
  return parts[0] === 'product' && parts[1] ? parts[1].toLowerCase() : '';
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
          ${item.img ? `<img src="${esc(item.img)}" alt="${esc(item.title)} cover" loading="lazy">` : ''}
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

  const main = document.querySelector('main.wrap') || document.querySelector('main') || document.getElementById('productContent');
  if (main && main.parentNode) main.insertAdjacentElement('afterend', section);
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
