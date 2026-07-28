(function () {
  'use strict';

  const books = window.IAC_BOOKS || [];

  function text(value) {
    return typeof window.escHtml === 'function'
      ? window.escHtml(String(value || ''))
      : String(value || '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[char]);
  }

  function titleKey(value) {
    return String(value || '').toLowerCase().normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function productToBook(product) {
    if (typeof window.customProductToBook === 'function') return window.customProductToBook(product);
    return {
      t: product.title || '', a: product.author || '', slug: product.slug || '',
      url: '/product/' + product.slug + '/', img: product.image_url || '/images/og-default.jpg',
      p: product.price_inr ? '₹ ' + Number(product.price_inr).toLocaleString('en-IN') : '',
      op: product.original_price_inr ? '₹ ' + Number(product.original_price_inr).toLocaleString('en-IN') : '',
      cat: product.category || 'Books', ts: product.created_at || product.updated_at || '', n: 1,
    };
  }

  function findBook(row) {
    const slug = String(row.slug || '').toLowerCase();
    const wantedTitle = titleKey(row.title);
    return books.find(book => String(book.slug || '').toLowerCase() === slug)
      || books.find(book => titleKey(book.t) === wantedTitle);
  }

  function card(book, badge) {
    const price = Number(String(book.p || '').replace(/[^0-9.]/g, '')) || 0;
    return `<a class="book-card home-merch-card" href="/product/${text(book.slug)}/">
      <div class="book-cover">
        <span class="home-merch-badge">${text(badge)}</span>
        <img src="${text(book.img || '/images/og-default.jpg')}" alt="${text(book.t)}" loading="lazy"
          onerror="this.src='/images/og-default.jpg'">
      </div>
      <div class="book-name">${text(book.t)}</div>
      <div class="book-author">${text(book.a || '')}</div>
      <div class="book-meta">
        <span class="book-price">${text(book.p || '')}${book.op ? `<span class="book-orig-price">${text(book.op)}</span>` : ''}</span>
        <span class="book-category">${text(book.cat || 'Books')}</span>
      </div>
      <button class="btn-add-card" data-url="${text(book.url)}" data-title="${text(book.t)}"
        data-author="${text(book.a || '')}" data-price="${price}" data-img="${text(book.img)}"
        onclick="event.preventDefault();event.stopPropagation();addToCartById(this)">+ Add to Cart</button>
    </a>`;
  }

  function ensureSection() {
    let section = document.getElementById('live-home-merchandising');
    if (section) return section;
    section = document.createElement('section');
    section.id = 'live-home-merchandising';
    section.className = 'home-merchandising';
    section.innerHTML = `
      <div class="home-merch-block">
        <div class="home-merch-heading"><div><div class="section-label">Fresh on Ink &amp; Chai</div>
          <h2 class="section-title">Just <em>Added</em></h2></div><a href="/new-arrivals/" class="btn-ghost">View all</a></div>
        <div class="home-merch-grid" id="home-new-arrivals"></div>
      </div>
      <div class="home-merch-block">
        <div class="home-merch-heading"><div><div class="section-label">Based on actual orders this month</div>
          <h2 class="section-title">Reader <em>Bestsellers</em></h2></div></div>
        <div class="home-merch-grid" id="home-bestsellers"></div>
      </div>`;
    document.getElementById('featured')?.before(section);
    return section;
  }

  function render(newArrivals, bestsellers) {
    ensureSection();
    const newGrid = document.getElementById('home-new-arrivals');
    const bestGrid = document.getElementById('home-bestsellers');
    if (newGrid) newGrid.innerHTML = newArrivals.slice(0, 5).map(book => card(book, 'NEW')).join('');
    if (bestGrid) bestGrid.innerHTML = bestsellers.slice(0, 5)
      .map(book => card(book, `${book.sales_qty || 0} sold`)).join('');
  }

  function staticNewArrivals() {
    return books.filter(book => book.n).sort((a, b) => Date.parse(b.ts || 0) - Date.parse(a.ts || 0));
  }

  async function load() {
    const initialNew = staticNewArrivals();
    if (initialNew.length) render(initialNew, []);
    try {
      const response = await fetch('/.netlify/functions/homepage-merchandising', { cache: 'default' });
      if (!response.ok) throw new Error('Homepage merchandising unavailable');
      const data = await response.json();

      const fresh = [];
      for (const product of data.new_arrivals || []) {
        let book = findBook(product);
        if (!book) {
          book = productToBook(product);
          if (book) books.push(book);
        }
        if (book) {
          book.n = 1;
          book.ts = product.created_at || product.updated_at || book.ts;
          fresh.push(book);
        }
      }

      const sales = new Map();
      const soldBooks = [];
      for (const row of data.bestsellers || []) {
        if (row.slug) sales.set('s:' + String(row.slug).toLowerCase(), Number(row.qty) || 0);
        sales.set('t:' + titleKey(row.title), Number(row.qty) || 0);
        const matched = findBook(row);
        const book = matched || {
          t: row.title, a: row.author || '', slug: row.slug || '', url: row.url || '',
          img: row.img || '/images/og-default.jpg', p: row.price ? '₹ ' + Number(row.price).toLocaleString('en-IN') : '',
          op: '', cat: 'Books', n: 0,
        };
        if (book.slug && book.img) soldBooks.push({ ...book, sales_qty: Number(row.qty) || 0 });
      }
      window.IAC_BESTSELLER_SALES = sales;

      const seen = new Set(fresh.map(book => String(book.slug || '').toLowerCase()));
      const allFresh = fresh.concat(initialNew.filter(book => !seen.has(String(book.slug || '').toLowerCase())));
      render(allFresh, soldBooks);
      if (typeof window.renderBooks === 'function') window.renderBooks();
    } catch (error) {
      console.warn(error.message);
    }
  }

  const style = document.createElement('style');
  style.textContent = `
    .home-merchandising{padding:5rem 6rem 1rem;background:var(--black)}
    .home-merch-block{max-width:1400px;margin:0 auto 5rem}
    .home-merch-heading{display:flex;align-items:end;justify-content:space-between;gap:1rem;margin-bottom:2rem}
    .home-merch-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:1.15rem}
    .home-merch-card{color:inherit;text-decoration:none;display:block;position:relative}
    .home-merch-card .book-cover{position:relative}
    .home-merch-badge{position:absolute;top:.65rem;left:.65rem;z-index:2;padding:.3rem .55rem;border-radius:3px;
      background:#b8382e;color:#fff;font:700 .62rem/1 var(--sans);letter-spacing:.08em;text-transform:uppercase}
    @media(max-width:1100px){.home-merchandising{padding:4rem 2rem 1rem}.home-merch-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
    @media(max-width:760px){.home-merchandising{padding:3rem 1rem 0}.home-merch-block{margin-bottom:3.5rem}
      .home-merch-heading{align-items:center}.home-merch-grid{display:flex;overflow-x:auto;gap:.85rem;padding-bottom:1rem;scroll-snap-type:x mandatory}
      .home-merch-card{flex:0 0 70vw;max-width:230px;scroll-snap-align:start}}
  `;
  document.head.appendChild(style);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, { once: true });
  else load();
})();
