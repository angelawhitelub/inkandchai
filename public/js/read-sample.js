/* Ink & Chai "Read sample" for physical books.
 * Loaded on product pages by cart.js. Asks get-product-sample whether this
 * book has a sample (uploaded from the admin product editor); if it does, puts
 * a "Read sample" button under the cover and opens the PDF in a full-screen
 * reader. pdf.js is fetched only when someone actually opens a sample. */
(function () {
  'use strict';

  var PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  var PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  var sample = null;
  var modal = null;
  var lastFocus = null;

  function productSlug() {
    var parts = location.pathname.split('/').filter(Boolean);
    return parts[0] === 'product' && parts[1] ? decodeURIComponent(parts[1]).toLowerCase() : '';
  }

  function bookTitle() {
    var h = document.querySelector('main h1') || document.querySelector('h1');
    return h ? h.textContent.trim() : '';
  }

  function addStyles() {
    if (document.getElementById('iac-sample-css')) return;
    var s = document.createElement('style');
    s.id = 'iac-sample-css';
    s.textContent = ''
      + '.iac-sample-row{margin-top:.9rem;display:flex;justify-content:center}'
      + '.iac-sample-btn{display:inline-flex;align-items:center;gap:.55rem;font:600 .64rem Inter,sans-serif;letter-spacing:.18em;text-transform:uppercase;padding:.8rem 1.3rem;background:rgba(201,168,76,.08);color:var(--gold,#c9a84c);border:1px dashed rgba(201,168,76,.5);cursor:pointer;transition:background .2s,color .2s}'
      + '.iac-sample-btn:hover,.iac-sample-btn:focus-visible{background:var(--gold,#c9a84c);color:var(--bg,#0d0b08);border-style:solid;outline:none}'
      + '.iac-sample-modal{position:fixed;inset:0;z-index:10050;background:rgba(8,7,5,.94);display:flex;flex-direction:column}'
      + '.iac-sample-head{display:flex;align-items:center;gap:.8rem;padding:.75rem 1rem;border-bottom:1px solid rgba(201,168,76,.2);color:#f0e8d8;background:#0d0b08}'
      + '.iac-sample-title{flex:1;min-width:0;font:500 1.05rem "Cormorant Garamond",Georgia,serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '.iac-sample-title small{display:block;font:600 .55rem Inter,sans-serif;letter-spacing:.2em;text-transform:uppercase;color:#c9a84c;margin-top:.15rem}'
      + '.iac-sample-close{background:none;border:1px solid rgba(201,168,76,.35);color:#f0e8d8;width:40px;height:40px;font-size:1.3rem;line-height:1;cursor:pointer;flex:none}'
      + '.iac-sample-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:1rem .6rem 2rem;overscroll-behavior:contain}'
      + '.iac-sample-page{display:block;margin:0 auto .8rem;max-width:860px;width:100%;background:#fff;box-shadow:0 4px 24px rgba(0,0,0,.45);min-height:200px}'
      + '.iac-sample-page canvas{display:block;width:100%;height:auto}'
      + '.iac-sample-msg{color:#a09080;font:.85rem Inter,sans-serif;text-align:center;padding:2.5rem 1rem;line-height:1.7}'
      + '.iac-sample-end{max-width:860px;margin:1.2rem auto 0;text-align:center;color:#a09080;font:.82rem Inter,sans-serif;line-height:1.7}'
      + '.iac-sample-end button{margin-top:.8rem;font:600 .66rem Inter,sans-serif;letter-spacing:.2em;text-transform:uppercase;padding:.9rem 1.6rem;background:#c9a84c;color:#0d0b08;border:0;cursor:pointer}';
    document.head.appendChild(s);
  }

  function placeButton() {
    // A page generated with its own sample (ALL_BOOKS.json sample_pdf) keeps it.
    if (document.querySelector('.btn-sample, .btn-sample-pdf, .iac-sample-row')) return;
    var row = document.createElement('div');
    row.className = 'iac-sample-row';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'iac-sample-btn';
    btn.innerHTML = '<span aria-hidden="true">📖</span><span></span>';
    btn.lastChild.textContent = 'Read sample' + (sample.pages ? ' · ' + sample.pages + ' pages free' : '');
    btn.addEventListener('click', open);
    row.appendChild(btn);

    var cover = document.querySelector('main section.cover');
    var actions = document.querySelector('main .actions');
    if (cover && cover.parentNode) {
      // On admin-created pages (product-page.js) the cover is itself a column
      // of the two-column .wrap grid; a sibling dropped next to it becomes a
      // grid item, takes the right column and pushes the title below. Wrap the
      // cover and the button together, as the generated pages already do.
      var parent = cover.parentNode;
      if (parent.matches && parent.matches('main.wrap, main')) {
        var col = document.createElement('div');
        col.className = 'iac-sample-col';
        parent.insertBefore(col, cover);
        col.appendChild(cover);
      }
      cover.insertAdjacentElement('afterend', row);
    } else if (actions && actions.parentNode) actions.insertAdjacentElement('afterend', row);
    else return;
    addStyles();
  }

  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[src="' + PDFJS + '"]');
      var s = existing || document.createElement('script');
      var tries = 0;
      // A generated page may already be loading the same file with `defer`.
      var poll = setInterval(function () {
        if (window.pdfjsLib) { clearInterval(poll); resolve(window.pdfjsLib); }
        else if (++tries > 150) { clearInterval(poll); reject(new Error('timeout')); }
      }, 100);
      if (!existing) {
        s.src = PDFJS;
        s.onerror = function () { clearInterval(poll); reject(new Error('load')); };
        document.head.appendChild(s);
      }
    });
  }

  function addToCart() {
    var btn = document.getElementById('addToCartBtn') || document.querySelector('main .actions button.secondary');
    close();
    if (btn) btn.click();
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function close() {
    if (!modal) return;
    modal.remove();
    modal = null;
    document.documentElement.style.overflow = '';
    document.removeEventListener('keydown', onKey);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function open() {
    if (modal) return;
    lastFocus = document.activeElement;
    var title = bookTitle();
    modal = document.createElement('div');
    modal.className = 'iac-sample-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Free sample' + (title ? ' of ' + title : ''));
    modal.innerHTML = '<div class="iac-sample-head"><div class="iac-sample-title"><span></span><small>Free sample</small></div>'
      + '<button type="button" class="iac-sample-close" aria-label="Close sample">&times;</button></div>'
      + '<div class="iac-sample-body"><div class="iac-sample-msg">Opening the sample…</div></div>';
    modal.querySelector('.iac-sample-title span').textContent = title || 'Sample pages';
    modal.querySelector('.iac-sample-close').addEventListener('click', close);
    document.body.appendChild(modal);
    document.documentElement.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    modal.querySelector('.iac-sample-close').focus();
    try { if (window.fbq) window.fbq('trackCustom', 'ReadSample', { content_name: title, content_type: 'product_sample' }); } catch (e) {}
    try { if (window.gtag) window.gtag('event', 'read_sample', { item_name: title }); } catch (e) {}
    render(modal, modal.querySelector('.iac-sample-body'));
  }

  function render(owner, body) {
    loadPdfJs().then(function (pdfjsLib) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return pdfjsLib.getDocument({ url: sample.file_url }).promise;
    }).then(function (pdf) {
      if (modal !== owner) return;
      body.textContent = '';
      var slots = [];
      for (var i = 1; i <= pdf.numPages; i++) {
        var slot = document.createElement('div');
        slot.className = 'iac-sample-page';
        slot.setAttribute('data-page', String(i));
        slot.setAttribute('aria-label', 'Page ' + i);
        body.appendChild(slot);
        slots.push(slot);
      }
      var end = document.createElement('div');
      end.className = 'iac-sample-end';
      end.innerHTML = '<div>End of the free sample.</div><button type="button">Add the book to cart</button>';
      end.querySelector('button').addEventListener('click', addToCart);
      body.appendChild(end);

      var drawn = {};
      function draw(slot) {
        var n = Number(slot.getAttribute('data-page'));
        if (drawn[n]) return;
        drawn[n] = true;
        pdf.getPage(n).then(function (page) {
          if (modal !== owner) return;
          var cssWidth = Math.min(slot.clientWidth || 800, 860);
          var base = page.getViewport({ scale: 1 });
          var dpr = Math.min(window.devicePixelRatio || 1, 2);
          var vp = page.getViewport({ scale: (cssWidth / base.width) * dpr });
          var canvas = document.createElement('canvas');
          canvas.width = Math.floor(vp.width);
          canvas.height = Math.floor(vp.height);
          slot.style.minHeight = '';
          slot.appendChild(canvas);
          return page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        }).catch(function () { drawn[n] = false; });
      }
      // Reserve each page's height from page 1 so the scrollbar is honest.
      pdf.getPage(1).then(function (p) {
        var v = p.getViewport({ scale: 1 });
        slots.forEach(function (s) { s.style.minHeight = Math.round((s.clientWidth || 800) * v.height / v.width) + 'px'; });
      });
      if ('IntersectionObserver' in window) {
        var io = new IntersectionObserver(function (entries) {
          entries.forEach(function (e) { if (e.isIntersecting) { draw(e.target); io.unobserve(e.target); } });
        }, { root: body, rootMargin: '600px 0px' });
        slots.forEach(function (s) { io.observe(s); });
      } else {
        slots.forEach(draw);
      }
    }).catch(function () {
      if (modal !== owner) return;
      body.innerHTML = '<div class="iac-sample-msg">The sample could not be opened right now. <a href="" target="_blank" rel="noopener" style="color:#c9a84c">Open it as a PDF instead →</a></div>';
      body.querySelector('a').href = sample.file_url;
    });
  }

  function init() {
    var slug = productSlug();
    if (!slug || sample) return;
    fetch('/.netlify/functions/get-product-sample?slug=' + encodeURIComponent(slug))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.sample || !d.sample.file_url) return;
        sample = d.sample;
        placeButton();
      })
      .catch(function () {});
  }

  window.IACReadSample = { init: init, open: function () { if (sample) open(); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
