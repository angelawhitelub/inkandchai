/**
 * eBooks on the storefront.
 *
 * Three jobs, one file, because they share the buy flow:
 *   1. On a product page, show the eBook price, a free sample, and a buy button.
 *   2. On /ebooks/, render the shop and the customer's own library.
 *   3. Buy, then open the book in the reader.
 *
 * NOTHING HERE HANDS OVER A FILE
 * Books are read at /ebooks/read/, which streams the PDF through an endpoint
 * that checks the buyer's entitlement on every request. There is deliberately
 * no download: a saved PDF is one forward away from being everywhere, and a
 * link to one is worse. See netlify/functions/ebook-file.js.
 *
 * WHY THERE IS NO CART
 * A digital sale needs no address, no shipping, no COD and no courier, and
 * mixing one into the existing cart would drag it through partial-COD deposits,
 * coupon maths and the NimbusPost push — code that moves real money for real
 * parcels. A paperback and a PDF are bought separately, on purpose.
 *
 * WHY SIGNING IN IS REQUIRED
 * Whatever identifies the buyer is the key to the file forever. An email
 * address is not a secret, so entitlements hang off an authenticated account.
 */
(function () {
  'use strict';

  var FN = '/.netlify/functions/';
  var WA = 'https://wa.me/917678400508';

  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (html != null) n.innerHTML = html;
    return n;
  }

  // Said before payment on purpose: an eBook is delivered the instant it is
  // paid for, so it is non-refundable, and that only holds up if the buyer
  // was told first. See utils/refund-guard.js for the enforcement.
  var NON_REFUNDABLE = 'Instant access · <strong>non-refundable</strong>. '
    + '<a href="/refund-policy/" target="_blank" rel="noopener">Why</a>';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function token() {
    return (window.IAC && window.IAC.getToken) ? window.IAC.getToken() : Promise.resolve('');
  }

  function signedIn() { return !!(window.IAC && window.IAC.getUser && window.IAC.getUser()); }

  /**
   * Whether this page can sign a customer in at all.
   *
   * The 2,740 crawlable book pages deliberately do not load auth.js -- it is
   * 152 KB, and generate_site.py keeps it off pages that do not need it. So on
   * those pages the button cannot open a sign-in box, and pretending otherwise
   * would dead-end with an alert. It hands off to /ebooks/ instead, which
   * carries auth and picks the purchase back up from the query string.
   */
  function canAuthHere() { return !!(window.IAC && window.IAC.openAuthModal); }

  function handoffUrl(slug) { return '/ebooks/?buy=' + encodeURIComponent(slug); }

  function askToSignIn(msg) {
    if (window.IAC && window.IAC.openAuthModal) {
      window.IAC.openAuthModal();
    } else {
      alert(msg || 'Please sign in first.');
    }
  }

  // ── Styles ───────────────────────────────────────────────────────────────
  var CSS = ''
    + '.eb-buy{display:flex;align-items:center;gap:.7rem;flex-wrap:wrap;margin:1rem 0;padding:.9rem 1rem;'
    + 'border:1px solid var(--gold-dim,#7a6428);border-radius:4px;background:rgba(201,168,76,.06)}'
    + '.eb-buy .eb-t{flex:1;min-width:160px;font-size:.78rem;line-height:1.5;color:var(--cream,#efe6d2)}'
    + '.eb-buy .eb-p{font-family:"Cormorant Garamond",serif;font-size:1.2rem;color:var(--gold,#c9a84c)}'
    + '.eb-buy .eb-p s{font-size:.8rem;color:var(--cream-dim,#9b917f);opacity:.6;margin-right:.4rem}'
    + '.eb-btn{font-family:Inter,sans-serif;font-size:.58rem;letter-spacing:.16em;text-transform:uppercase;'
    + 'padding:.7rem 1.2rem;border:1px solid var(--gold,#c9a84c);background:var(--gold,#c9a84c);color:#1a1410;'
    + 'cursor:pointer;border-radius:3px;transition:opacity .2s}'
    + '.eb-btn:hover{opacity:.85}.eb-btn[disabled]{opacity:.5;cursor:default}'
    + '.eb-btn-ghost{background:transparent;color:var(--gold,#c9a84c)}'
    + '.eb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:1.4rem}'
    + '.eb-card{display:flex;flex-direction:column;gap:.5rem}'
    + '.eb-card img{width:100%;aspect-ratio:2/3;object-fit:cover;border-radius:3px;background:rgba(255,255,255,.05)}'
    + '.eb-card .eb-ti{font-size:.75rem;line-height:1.4;color:var(--cream,#efe6d2)}'
    + '.eb-card .eb-au{font-size:.62rem;color:var(--cream-dim,#9b917f)}'
    + '.eb-note{font-size:.66rem;color:var(--cream-dim,#9b917f);line-height:1.6}'
    + '.eb-empty{padding:2rem 0;text-align:center;color:var(--cream-dim,#9b917f);font-size:.75rem}'
    + '.eb-nr{font-size:.6rem;line-height:1.35;color:var(--cream-dim,#9b917f);margin:.35rem 0 0}'
    + '.eb-nr a{color:inherit;text-decoration:underline}'
    // The format strip. Chips wrap on a phone rather than scrolling sideways,
    // because a format you cannot see is a format you will not buy.
    + '.fmt-strip{margin:1.1rem 0 .9rem}'
    + '.fmt-lab{font-size:.56rem;letter-spacing:.2em;text-transform:uppercase;color:var(--cream-dim,#9b917f);margin-bottom:.45rem}'
    + '.fmt-row{display:flex;flex-wrap:wrap;gap:.5rem}'
    + '.fmt{display:flex;flex-direction:column;align-items:flex-start;gap:.15rem;min-width:104px;'
    + 'padding:.55rem .8rem;border:1px solid rgba(155,145,127,.38);border-radius:4px;background:transparent;'
    + 'color:var(--cream,#efe6d2);font-family:inherit;text-align:left;cursor:pointer;text-decoration:none;'
    + 'text-transform:none;letter-spacing:normal;'
    + 'transition:border-color .15s,background .15s}'
    + '.fmt:hover{border-color:var(--gold,#c9a84c)}'
    + '.fmt.is-on{border-color:var(--gold,#c9a84c);background:rgba(201,168,76,.1);box-shadow:inset 0 0 0 1px var(--gold,#c9a84c)}'
    + '.fmt .fmt-n{font-size:.68rem;letter-spacing:.06em}'
    + '.fmt .fmt-p{font-size:.74rem;color:var(--gold,#c9a84c);font-weight:600}'
    + '.fmt .fmt-p s{font-size:.62rem;color:var(--cream-dim,#9b917f);opacity:.65;font-weight:400;margin-right:.25rem}'
    + '.fmt-panel{margin:.2rem 0 1rem}'
    + '.fmt-price{font-family:"Cormorant Garamond",serif;font-size:2.7rem;color:var(--gold,#c9a84c);font-weight:600;line-height:1.1}'
    + '.fmt-price s{font-size:1rem;color:var(--cream-dim,#9b917f);opacity:.6;font-weight:400;margin-right:.5rem}'
    + '.fmt-meta{font-size:.7rem;color:var(--cream-dim,#9b917f);margin:.3rem 0 .9rem}'
    + '.fmt-acts{display:flex;flex-wrap:wrap;gap:.6rem}';

  var cssIn = false;
  function injectCss() {
    if (cssIn) return;
    cssIn = true;
    var st = document.createElement('style');
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  // ── Buying ───────────────────────────────────────────────────────────────

  function loadRazorpay() {
    if (window.Razorpay) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load the payment window.')); };
      document.head.appendChild(s);
    });
  }

  async function buy(slug, title, btn) {
    if (!signedIn()) {
      askToSignIn();
      return;
    }
    var original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Please wait…'; }

    try {
      await loadRazorpay();
      var tok = await token();
      var res = await fetch(FN + 'ebook-create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
        body: JSON.stringify({ slug: slug }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start the payment.');

      if (data.already_owned) {
        if (btn) { btn.disabled = false; btn.textContent = original; }
        return read(slug);
      }

      var rzp = new window.Razorpay({
        key: data.key_id,
        amount: data.amount,
        currency: data.currency,
        order_id: data.order_id,
        name: 'Ink & Chai',
        description: (data.title || title || 'eBook') + ' — eBook (non-refundable)',
        prefill: { email: data.email || '' },
        theme: { color: '#c9a84c' },
        handler: async function (resp) {
          if (btn) btn.textContent = 'Unlocking…';
          try {
            var tok2 = await token();
            var vres = await fetch(FN + 'ebook-verify-payment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok2 },
              body: JSON.stringify({
                razorpay_order_id: resp.razorpay_order_id,
                razorpay_payment_id: resp.razorpay_payment_id,
                razorpay_signature: resp.razorpay_signature,
              }),
            });
            var vdata = await vres.json();
            if (!vres.ok) throw new Error(vdata.error || 'Could not confirm the payment.');
            if (btn) { btn.disabled = false; btn.textContent = 'Read'; }
            read(slug);
          } catch (e) {
            // They have paid. Never imply otherwise — give them the reference
            // and a way to reach a human.
            alert(e.message + '\n\nIf money has left your account, message us on WhatsApp: ' + WA);
            if (btn) { btn.disabled = false; btn.textContent = original; }
          }
        },
        modal: {
          ondismiss: function () { if (btn) { btn.disabled = false; btn.textContent = original; } },
        },
      });
      rzp.open();
    } catch (e) {
      alert(e.message);
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
  }

  /** Open a book the customer owns. The reader does the authenticating. */
  function read(slug) {
    window.location.href = '/ebooks/read/?slug=' + encodeURIComponent(slug);
  }

  /** The free sample — no account needed, first few pages only. */
  function readSample(slug) {
    window.location.href = '/ebooks/read/?sample=1&slug=' + encodeURIComponent(slug);
  }

  // ── The button on a product page ─────────────────────────────────────────

  function currentSlug() {
    var m = location.pathname.match(/^\/product\/([^/]+)\/?$/);
    return m ? m[1] : '';
  }

  // ── The format strip ─────────────────────────────────────────────────────
  //
  // Amazon's pattern: the formats a book is sold in, across the top of the buy
  // box, with the one you are looking at selected. Another PRINT edition is a
  // different product with its own page, stock and cart line, so choosing it
  // navigates there. The eBook is the same product in another wrapper, so it
  // swaps the buy box in place.
  //
  // Everything here is additive and reversible. A book with one format gets no
  // strip at all and its page is untouched, which is every book but a handful.

  var _fmtState = null;   // { buyBox, formats, panel, chips, current }

  /**
   * The print buy box, across the three renderers that draw one.
   * `hide` is what stops making delivery promises about a PDF: a shipping
   * estimate and a COD badge are wrong the moment you switch to the eBook.
   */
  function findBuyBox() {
    var actions = document.querySelector('.actions, .pdp-actions, .buy-actions, .product-actions');
    if (!actions) return null;
    var priceRow = document.querySelector('.price-row, .product-price-row');
    if (!priceRow) return null;
    var hide = [];
    ['.stock', '#staticShipBy', '.trust'].forEach(function (sel) {
      var n = document.querySelector(sel);
      if (n) hide.push(n);
    });
    return { actions: actions, priceRow: priceRow, hide: hide };
  }

  function money(n) { return '₹' + esc(n); }

  function priceHtml(f) {
    return (f.mrp && f.mrp > f.price ? '<s>' + money(f.mrp) + '</s> ' : '') + money(f.price);
  }

  function chipHtml(f) {
    return '<span class="fmt-n">' + esc(f.label) + '</span>'
      + (f.price ? '<span class="fmt-p">' + priceHtml(f) + '</span>' : '');
  }

  function buildStrip(formats) {
    var wrap = el('div', { class: 'fmt-strip' });
    wrap.innerHTML = '<div class="fmt-lab">Format</div>';
    var row = el('div', { class: 'fmt-row' });
    var chips = {};

    formats.forEach(function (f) {
      var node;
      if (f.kind === 'print' && !f.current) {
        // A different edition lives on a different page. A real link, so it
        // opens in a new tab on a middle click and Google sees the edition.
        node = el('a', { class: 'fmt', href: f.url });
        node.innerHTML = chipHtml(f);
      } else {
        node = el('button', { class: 'fmt', type: 'button' });
        node.innerHTML = chipHtml(f);
        node.onclick = function () { selectFormat(f.kind); };
      }
      if (f.current) node.classList.add('is-on');
      chips[f.kind] = chips[f.kind] || node;
      row.appendChild(node);
    });

    wrap.appendChild(row);
    return { wrap: wrap, chips: chips };
  }

  /**
   * The eBook's buy box, as TWO pieces rather than one block.
   *
   * A single panel appended after the print buttons put the eBook's price below
   * the stock badge, the delivery estimate and the trust icons — a long way from
   * where the price had been a moment earlier. Each half is mounted beside the
   * print half it replaces instead, so switching format changes the numbers in
   * place and moves nothing.
   */
  function buildEbookPanel(f, owned) {
    var price = el('div', { class: 'fmt-panel' });
    price.style.display = 'none';

    var amount = el('div', { class: 'fmt-price' });
    amount.innerHTML = priceHtml(f);
    price.appendChild(amount);

    var bits = ['Read instantly — nothing is posted'];
    if (f.pages) bits.push(esc(f.pages) + ' pages');
    if (f.size_mb) bits.push(esc(f.size_mb) + ' MB');
    price.appendChild(el('div', { class: 'fmt-meta' }, bits.join(' · ')));

    var panel = el('div', { class: 'fmt-panel' });
    panel.style.display = 'none';
    var acts = el('div', { class: 'fmt-acts' });

    // The sample first: it is the cheapest thing to say yes to, and it needs no
    // account, so it behaves identically on every page.
    var sample = el('a', {
      class: 'eb-btn eb-btn-ghost',
      href: '/ebooks/read/?sample=1&slug=' + encodeURIComponent(f.slug),
    }, 'Read sample');
    sample.style.textDecoration = 'none';
    sample.style.display = 'inline-block';
    acts.appendChild(sample);

    var btn;
    if (canAuthHere()) {
      btn = el('button', { class: 'eb-btn', type: 'button' }, owned ? 'Read now' : 'Buy eBook');
      btn.onclick = function () { return owned ? read(f.slug) : buy(f.slug, f.title, btn); };
    } else {
      // No auth on this page (the crawlable book pages ship without it), so the
      // button hands the slug to /ebooks/ and the purchase resumes there.
      btn = el('a', { class: 'eb-btn', href: handoffUrl(f.slug) }, 'Buy eBook');
      btn.style.textDecoration = 'none';
      btn.style.display = 'inline-block';
    }
    acts.appendChild(btn);
    panel.appendChild(acts);

    if (!owned) panel.appendChild(el('div', { class: 'eb-nr' }, NON_REFUNDABLE));
    return { price: price, actions: panel };
  }

  function selectFormat(kind) {
    var st = _fmtState;
    if (!st || st.current === kind) return;
    st.current = kind;

    var toEbook = kind === 'ebook';
    st.buyBox.priceRow.style.display = toEbook ? 'none' : '';
    st.buyBox.actions.style.display  = toEbook ? 'none' : '';
    st.buyBox.hide.forEach(function (n) { n.style.display = toEbook ? 'none' : ''; });
    if (st.panel) {
      st.panel.price.style.display = toEbook ? '' : 'none';
      st.panel.actions.style.display = toEbook ? '' : 'none';
    }

    Object.keys(st.chips).forEach(function (k) {
      st.chips[k].classList.toggle('is-on', k === kind);
    });
  }

  async function mountFormats() {
    var slug = currentSlug();
    if (!slug) return;
    try {
      var res = await fetch(FN + 'product-formats?slug=' + encodeURIComponent(slug));
      var data = await res.json();
      var formats = data.formats || [];
      if (formats.length < 2) return;        // one format is not a choice

      var buyBox = findBuyBox();
      var ebook = formats.filter(function (f) { return f.kind === 'ebook'; })[0];
      if (!buyBox) {
        // A renderer whose buy box this does not recognise still deserves the
        // eBook, just not an in-place swap.
        if (ebook) mountEbookFallback(ebook);
        return;
      }

      injectCss();
      var owned = ebook ? await ownsSlug(slug) : false;
      var built = buildStrip(formats);
      var panel = ebook ? buildEbookPanel(ebook, owned) : null;

      _fmtState = {
        buyBox: buyBox, panel: panel, chips: built.chips,
        current: 'print',
      };

      // Above the price, where Amazon puts it: the format decides what the
      // price below it means.
      buyBox.priceRow.parentNode.insertBefore(built.wrap, buyBox.priceRow);
      if (panel) {
        buyBox.priceRow.parentNode.insertBefore(panel.price, buyBox.priceRow.nextSibling);
        buyBox.actions.parentNode.insertBefore(panel.actions, buyBox.actions.nextSibling);
      }
    } catch (e) { /* a missing eBook must never break a product page */ }
  }

  /** The pre-strip layout: a standalone card under the paperback controls. */
  function mountEbookFallback(f) {
    injectCss();
    var box = el('div', { class: 'eb-buy' });
    box.innerHTML =
      '<div class="eb-t">📄 <strong>Also available as a PDF eBook</strong>'
      + '<br><span style="font-size:.68rem;opacity:.8">Read instantly — no delivery wait'
      + (f.pages ? ' · ' + esc(f.pages) + ' pages' : '')
      + (f.size_mb ? ' · ' + esc(f.size_mb) + ' MB' : '') + '</span></div>'
      + '<div class="eb-p">' + priceHtml(f) + '</div>';

    var sample = el('a', {
      class: 'eb-btn eb-btn-ghost',
      href: '/ebooks/read/?sample=1&slug=' + encodeURIComponent(f.slug),
    }, 'Read sample');
    sample.style.textDecoration = 'none';
    sample.style.display = 'inline-block';
    box.appendChild(sample);

    var btn;
    if (canAuthHere()) {
      btn = el('button', { class: 'eb-btn', type: 'button' }, 'Buy eBook');
      btn.onclick = function () { buy(f.slug, f.title, btn); };
    } else {
      btn = el('a', { class: 'eb-btn', href: handoffUrl(f.slug) }, 'Buy eBook');
      btn.style.textDecoration = 'none';
      btn.style.display = 'inline-block';
    }
    box.appendChild(btn);
    box.appendChild(el('div', { class: 'eb-nr' }, NON_REFUNDABLE));

    var anchor = document.querySelector('.pdp-actions, .buy-actions, .actions, .product-actions');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(box, anchor.nextSibling);
    else (document.querySelector('main') || document.body).appendChild(box);
  }

  var _libCache = null;
  async function ownsSlug(slug) {
    if (!canAuthHere() || !signedIn()) return false;
    try {
      if (!_libCache) {
        var tok = await token();
        var res = await fetch(FN + 'ebook-library', { headers: { Authorization: 'Bearer ' + tok } });
        var data = await res.json();
        _libCache = (data.ebooks || []).map(function (e) { return e.slug; });
      }
      return _libCache.indexOf(slug) !== -1;
    } catch (e) { return false; }
  }

  // ── The /ebooks/ page ────────────────────────────────────────────────────

  async function mountShop() {
    var shop = document.getElementById('ebShop');
    var lib = document.getElementById('ebLibrary');
    if (!shop && !lib) return;
    injectCss();

    if (shop) {
      try {
        var res = await fetch(FN + 'ebook-catalog');
        var data = await res.json();
        var list = data.ebooks || [];
        if (!list.length) {
          shop.innerHTML = '<div class="eb-empty">No eBooks yet — they are on the way.</div>';
        } else {
          shop.innerHTML = '<div class="eb-grid">' + list.map(function (e) {
            return '<div class="eb-card">'
              + (e.cover ? '<img src="' + esc(e.cover) + '" alt="" loading="lazy"/>' : '<img alt=""/>')
              + '<div class="eb-ti">' + esc(e.title) + '</div>'
              + (e.author ? '<div class="eb-au">' + esc(e.author) + '</div>' : '')
              + '<div class="eb-p">' + (e.mrp && e.mrp > e.price ? '<s>₹' + esc(e.mrp) + '</s> ' : '')
              + '₹' + esc(e.price) + '</div>'
              + '<button class="eb-btn" type="button" data-slug="' + esc(e.slug) + '">Buy eBook</button>'
              + '<a class="eb-btn eb-btn-ghost" style="text-decoration:none;display:inline-block;text-align:center"'
              + ' href="/ebooks/read/?sample=1&slug=' + esc(e.slug) + '">Read sample</a>'
              + '<div class="eb-nr">' + NON_REFUNDABLE + '</div>'
              + '</div>';
          }).join('') + '</div>';
          shop.querySelectorAll('button[data-slug]').forEach(function (b) {
            b.onclick = function () { buy(b.dataset.slug, '', b); };
          });
        }
      } catch (e) {
        shop.innerHTML = '<div class="eb-empty">Could not load the eBook shop.</div>';
      }
    }

    if (lib) renderLibrary(lib);
  }

  async function renderLibrary(lib) {
    if (!signedIn()) {
      lib.innerHTML = '<div class="eb-empty">Sign in to see the eBooks you have bought.'
        + '<br><br><button class="eb-btn eb-btn-ghost" type="button" id="ebSignIn">Sign in</button></div>';
      var b = document.getElementById('ebSignIn');
      if (b) b.onclick = function () { askToSignIn(); };
      return;
    }
    lib.innerHTML = '<div class="eb-empty">Loading your library…</div>';
    try {
      var tok = await token();
      var res = await fetch(FN + 'ebook-library', { headers: { Authorization: 'Bearer ' + tok } });
      var data = await res.json();
      var list = data.ebooks || [];
      _libCache = list.map(function (e) { return e.slug; });
      if (!list.length) {
        lib.innerHTML = '<div class="eb-empty">You have not bought any eBooks yet.</div>';
        return;
      }
      lib.innerHTML = '<div class="eb-grid">' + list.map(function (e) {
        return '<div class="eb-card">'
          + (e.cover ? '<img src="' + esc(e.cover) + '" alt="" loading="lazy"/>' : '<img alt=""/>')
          + '<div class="eb-ti">' + esc(e.title) + '</div>'
          + (e.author ? '<div class="eb-au">' + esc(e.author) + '</div>' : '')
          + '<button class="eb-btn" type="button" data-dl="' + esc(e.slug) + '">Read</button>'
          + '</div>';
      }).join('') + '</div>';
      lib.querySelectorAll('button[data-dl]').forEach(function (b) {
        b.onclick = function () { read(b.dataset.dl); };
      });
    } catch (e) {
      lib.innerHTML = '<div class="eb-empty">Could not load your library.</div>';
    }
  }

  /**
   * Resume a purchase started on a book page that had no auth loaded.
   *
   * The slug is only ever used to open the same buy flow a click on this page
   * would, and ebook-create-order re-reads the price from the database, so a
   * hand-edited query string cannot change what anything costs.
   */
  function resumeHandoff() {
    var m = location.search.match(/[?&]buy=([^&]+)/);
    if (!m) return;
    var slug = decodeURIComponent(m[1]).toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!slug) return;
    // Drop it from the URL so a refresh after paying does not reopen checkout.
    try { history.replaceState(null, '', '/ebooks/'); } catch (e) {}
    buy(slug, '', null);
  }

  function start() {
    mountShop();
    mountFormats();
    if (document.getElementById('ebShop')) resumeHandoff();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.IacEbooks = {
    buy: buy, read: read, readSample: readSample,
    refreshLibrary: function () { _libCache = null; },
  };
})();
