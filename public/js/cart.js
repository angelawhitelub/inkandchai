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

// ── UI helpers ─────────────────────────────────────────────────────────────
function updateCartUI() {
  const cart  = getCart();
  const total = cart.reduce((s, i) => s + i.qty, 0);
  const sum   = cart.reduce((s, i) => s + i.price * i.qty, 0);

  // Nav badge
  const badge = document.getElementById('cartBadge');
  if (badge) {
    badge.textContent = total > 0 ? total : '';
    badge.style.display = total > 0 ? 'inline-flex' : 'none';
  }

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
  if (totalEl)  totalEl.textContent = `₹ ${sum.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

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

  // Close cart on overlay click
  const overlay = document.getElementById('cartOverlay');
  if (overlay) overlay.addEventListener('click', closeCart);

  // ESC key closes cart
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeCart();
  });
});
