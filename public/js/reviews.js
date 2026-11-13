/*
 * Customer reviews on book pages: real, approved reviews only.
 *
 * Every product page carries <section id="liveReviews" data-slug="..."> and
 * loads this file. It reads /.netlify/functions/get-reviews (approved rows of
 * product_reviews) and draws the summary, star breakdown and the reviews.
 * With none yet it shows an honest empty state.
 *
 * Until 13 Nov 2026 pages also showed a stored "4.8 rating · 14 customer
 * reviews" taken from the catalogue, not from customers. The owner chose to
 * show only real reviews, so nothing here invents a number.
 *
 * Colours come from the page theme (--panel, --cream, --muted, --border) with
 * fallbacks, so it reads in both the light and dark site themes.
 */
(function () {
  'use strict';

  var CSS = ''
    + '.iacr{margin-top:1.4rem;padding:1.4rem;border:1px solid var(--border,#e4d9c6);border-radius:20px;background:var(--panel,#fff);color:var(--cream,#241c14);line-height:1.6}'
    // Baked pages put the section straight after <main class="wrap"> (1260px,
    // 16px padding); line it up with that column instead of the full window.
    + 'body>.iacr{box-sizing:border-box;width:calc(100% - 32px);max-width:1228px;margin:1.4rem auto 0}'
    + '.iacr h2{font-family:"Cormorant Garamond","Playfair Display",serif;font-size:1.6rem;font-weight:600;margin:0 0 1rem;color:var(--cream,#241c14)}'
    + '.iacr-top{display:grid;grid-template-columns:minmax(150px,200px) 1fr;gap:1.6rem;align-items:center;padding-bottom:1.2rem;border-bottom:1px solid var(--border,#e4d9c6)}'
    + '.iacr-avg{font-size:2.6rem;font-weight:700;line-height:1;color:var(--cream,#241c14)}'
    + '.iacr-avg small{font-size:.9rem;font-weight:500;color:var(--muted,#6b5d4f)}'
    + '.iacr-stars{position:relative;display:inline-block;font-size:1.15rem;letter-spacing:.12em;line-height:1;color:rgba(127,127,127,.35);margin:.45rem 0 .3rem}'
    + '.iacr-stars span{position:absolute;inset:0 auto 0 0;overflow:hidden;white-space:nowrap;color:#f2a516}'
    + '.iacr-sub{font-size:.78rem;color:var(--muted,#6b5d4f)}'
    + '.iacr-bars{display:grid;gap:.45rem}'
    + '.iacr-bar{display:grid;grid-template-columns:3.4rem 1fr 2.6rem;gap:.7rem;align-items:center;font-size:.8rem;color:var(--muted,#6b5d4f)}'
    + '.iacr-track{height:.6rem;border-radius:99px;background:rgba(127,127,127,.16);overflow:hidden}'
    + '.iacr-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,#f2a516,#f7c04a)}'
    + '.iacr-pct{text-align:right;font-variant-numeric:tabular-nums}'
    + '.iacr-list{margin-top:.4rem}'
    + '.iacr-item{padding:1.1rem 0;border-bottom:1px solid var(--border,#e4d9c6)}'
    + '.iacr-item:last-child{border-bottom:0}'
    + '.iacr-who{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .7rem;font-size:.86rem;font-weight:600;color:var(--cream,#241c14)}'
    + '.iacr-avatar{width:2rem;height:2rem;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700;background:rgba(242,165,22,.16);color:#a86d00}'
    + '.iacr-ok{font-size:.66rem;font-weight:600;letter-spacing:.04em;padding:.15rem .55rem;border-radius:99px;background:rgba(46,125,50,.12);color:#2e7d32}'
    + '.iacr-meta{display:flex;align-items:center;gap:.7rem;margin:.45rem 0 0;font-size:.76rem;color:var(--muted,#6b5d4f)}'
    + '.iacr-meta .iacr-stars{font-size:.95rem;margin:0}'
    + '.iacr-text{margin:.5rem 0 0;font-size:.92rem;line-height:1.7;color:var(--cream,#241c14);white-space:pre-line;overflow-wrap:anywhere}'
    + '.iacr-more{margin-top:.9rem;padding:.6rem 1.1rem;border:1px solid var(--border,#e4d9c6);border-radius:99px;background:transparent;color:var(--cream,#241c14);font:inherit;font-size:.8rem;cursor:pointer}'
    + '.iacr-more:hover{border-color:#f2a516}'
    + '.iacr-line{display:inline-flex;align-items:center;gap:.45rem;margin:.35rem 0 .2rem;font-size:.86rem;color:var(--muted,#6b5d4f);text-decoration:none}'
    + '.iacr-line b{color:var(--cream,#241c14);font-weight:700}'
    + '.iacr-line .iacr-stars{font-size:1rem;margin:0}'
    + '.iacr-line u{text-decoration:none;border-bottom:1px solid transparent}'
    + '.iacr-line:hover u{border-bottom-color:currentColor}'
    + '.iacr-pics{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.65rem}'
    + '.iacr-pic{width:5.2rem;height:5.2rem;padding:0;border:1px solid var(--border,#e4d9c6);border-radius:10px;overflow:hidden;background:rgba(127,127,127,.08);cursor:zoom-in}'
    + '.iacr-pic img{width:100%;height:100%;object-fit:cover;display:block}'
    + '.iacr-gallery{padding:1rem 0 .2rem;border-bottom:1px solid var(--border,#e4d9c6)}'
    + '.iacr-gallery h3{margin:0;font-size:.82rem;font-weight:600;color:var(--cream,#241c14)}'
    + '.iacr-gallery .iacr-pics{flex-wrap:nowrap;overflow-x:auto;padding-bottom:.5rem}'
    + '.iacr-gallery .iacr-pic{flex:0 0 auto}'
    + '.iacr-lb{position:fixed;inset:0;z-index:2147483000;background:rgba(10,8,6,.88);display:flex;align-items:center;justify-content:center;padding:1rem}'
    + '.iacr-lb img{max-width:min(96vw,1100px);max-height:86vh;border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,.5)}'
    + '.iacr-lb button{position:absolute;border:0;border-radius:50%;width:2.6rem;height:2.6rem;background:rgba(255,255,255,.14);color:#fff;font-size:1.4rem;line-height:1;cursor:pointer}'
    + '.iacr-lb .x{top:1rem;right:1rem}.iacr-lb .p{left:1rem;top:50%;transform:translateY(-50%)}.iacr-lb .n{right:1rem;top:50%;transform:translateY(-50%)}'
    + '.iacr-lb small{position:absolute;bottom:1rem;left:0;right:0;text-align:center;color:rgba(255,255,255,.8);font-size:.8rem}'
    + '.iacr-empty{display:flex;gap:1rem;align-items:center}'
    + '.iacr-empty .iacr-stars{font-size:1.5rem;margin:0}'
    + '.iacr-empty p{margin:.15rem 0 0;font-size:.85rem;color:var(--muted,#6b5d4f)}'
    + '.iacr-empty b{font-size:1rem;color:var(--cream,#241c14)}'
    + '@media (max-width:640px){.iacr{padding:1.1rem;border-radius:16px}.iacr-top{grid-template-columns:1fr;gap:1rem}.iacr-empty{flex-direction:column;align-items:flex-start;gap:.5rem}}'
    // Pages default to the light theme; the toggle removes data-theme for dark.
    + ':root:not([data-theme="light"]) .iacr-ok{color:#81c784;background:rgba(129,199,132,.14)}'
    + ':root:not([data-theme="light"]) .iacr-avatar{color:#f7c04a}';

  if (!document.getElementById('iac-reviews-css')) {
    var st = document.createElement('style');
    st.id = 'iac-reviews-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // The client-side /product/ page draws a new #liveReviews per book and calls
  // window.iacLoadReviews() again; baked pages just run it once on load.
  function load() {
  var sec = document.getElementById('liveReviews');
  if (!sec || sec.getAttribute('data-iac-reviews') === 'on') return;
  var slug = sec.getAttribute('data-slug') || '';
  if (!slug) return;
  sec.setAttribute('data-iac-reviews', 'on');

  var esc = function (t) { var e = document.createElement('div'); e.textContent = t == null ? '' : String(t); return e.innerHTML; };
  // Public page: first name and last initial only, never a customer's full name.
  var shortName = function (n) {
    var p = String(n || '').trim().split(/\s+/).filter(Boolean);
    if (!p.length) return 'Verified buyer';
    var first = p[0].charAt(0).toUpperCase() + p[0].slice(1).toLowerCase();
    return p.length > 1 ? first + ' ' + p[p.length - 1].charAt(0).toUpperCase() + '.' : first;
  };
  var stars = function (v) {
    var pct = Math.max(0, Math.min(100, (Number(v) || 0) / 5 * 100));
    return '<span class="iacr-stars" role="img" aria-label="' + (Math.round((Number(v) || 0) * 10) / 10) + ' out of 5 stars">★★★★★<span style="width:' + pct + '%">★★★★★</span></span>';
  };
  var when = function (iso) {
    try { return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; }
  };

  var okUrl = function (u) { return /^https:\/\/[^\s"'<>]+$/i.test(String(u || '')); };
  var photosOf = function (r) { return (Array.isArray(r.photos) ? r.photos : []).filter(okUrl).slice(0, 4); };

  // Full-size viewer for review photos, with previous/next across the set
  // that was clicked (one review's photos, or every photo in the strip).
  function viewer(list, at) {
    var i = at;
    var lb = document.createElement('div');
    lb.className = 'iacr-lb';
    lb.setAttribute('role', 'dialog');
    lb.setAttribute('aria-label', 'Customer photo');
    var many = list.length > 1;
    lb.innerHTML = '<img alt="Customer photo"/>' + '<button type="button" class="x" aria-label="Close">×</button>'
      + (many ? '<button type="button" class="p" aria-label="Previous photo">‹</button><button type="button" class="n" aria-label="Next photo">›</button><small></small>' : '');
    var img = lb.querySelector('img');
    var show = function () {
      img.src = list[i];
      var c = lb.querySelector('small');
      if (c) c.textContent = (i + 1) + ' / ' + list.length;
    };
    var close = function () { lb.remove(); document.removeEventListener('keydown', key); document.body.style.overflow = ''; };
    var step = function (d) { i = (i + d + list.length) % list.length; show(); };
    var key = function (e) { if (e.key === 'Escape') close(); else if (many && e.key === 'ArrowLeft') step(-1); else if (many && e.key === 'ArrowRight') step(1); };
    lb.onclick = function (e) {
      var t = e.target;
      if (t.classList.contains('p')) step(-1);
      else if (t.classList.contains('n')) step(1);
      else if (t === lb || t.classList.contains('x')) close();
    };
    document.addEventListener('keydown', key);
    document.body.style.overflow = 'hidden';
    show();
    document.body.appendChild(lb);
  }
  var pics = function (list, set) {
    return '<div class="iacr-pics">' + list.map(function (u, i) {
      return '<button type="button" class="iacr-pic" data-set="' + set + '" data-i="' + i + '" aria-label="Open customer photo ' + (i + 1) + '"><img src="' + esc(u) + '" alt="Customer photo" loading="lazy"/></button>';
    }).join('') + '</div>';
  };

  function empty() {
    dropLine();
    sec.className = 'iacr';
    sec.innerHTML = '<h2>Customer reviews</h2>'
      + '<div class="iacr-empty">' + stars(0)
      + '<div><b>No reviews yet</b>'
      + '<p>Bought this book from Ink &amp; Chai? After delivery we send you a WhatsApp link to rate it. Only verified buyers can review.</p></div></div>';
    sec.hidden = false;
    sec.style.display = 'block';
  }

  function dropLine() {
    var old = document.querySelector('.iacr-linewrap');
    if (old) old.remove();
  }

  // Stars + count under "by Author" (Amazon-style), only when real reviews
  // exist. Baked and Worker pages use .author, the client page .prod-author.
  function summaryLine(avg, n) {
    dropLine();
    var h1 = document.querySelector('h1.prod-title') || document.querySelector('h1');
    if (!h1) return;
    var anchor = h1.parentElement.querySelector('.author, .prod-author') || h1;
    var a = document.createElement('a');
    a.className = 'iacr-line';
    a.href = '#liveReviews';
    a.innerHTML = stars(avg) + '<b>' + avg.toFixed(1) + '</b><u>' + n + ' ' + (n === 1 ? 'rating' : 'ratings') + '</u>';
    a.onclick = function (e) { e.preventDefault(); sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    var wrap = document.createElement('div');
    wrap.className = 'iacr-linewrap';
    wrap.appendChild(a);
    anchor.insertAdjacentElement('afterend', wrap);
  }

  function render(rv) {
    var n = rv.length;
    var sum = 0;
    var counts = [0, 0, 0, 0, 0, 0];
    rv.forEach(function (r) {
      var k = Math.max(1, Math.min(5, Math.round(Number(r.rating) || 0)));
      counts[k] += 1;
      sum += k;
    });
    var avg = sum / n;
    var bars = [5, 4, 3, 2, 1].map(function (k) {
      var pct = Math.round(counts[k] / n * 100);
      return '<div class="iacr-bar"><span>' + k + ' star</span><div class="iacr-track"><div class="iacr-fill" style="width:' + pct + '%"></div></div><span class="iacr-pct">' + pct + '%</span></div>';
    }).join('');
    var item = function (r) {
      var name = shortName(r.customer_name);
      return '<div class="iacr-item">'
        + '<div class="iacr-who"><span class="iacr-avatar" aria-hidden="true">' + esc(name.charAt(0)) + '</span>' + esc(name)
        + (r.verified_buyer ? '<span class="iacr-ok">✓ Verified purchase</span>' : '') + '</div>'
        + '<div class="iacr-meta">' + stars(r.rating) + '<span>' + esc(when(r.created_at)) + '</span></div>'
        + (r.comment ? '<p class="iacr-text">' + esc(r.comment) + '</p>' : '')
        + (photosOf(r).length ? pics(photosOf(r), 'r' + rv.indexOf(r)) : '')
        + '</div>';
    };
    var FIRST = 5;
    var allPics = [];
    rv.forEach(function (r) { allPics = allPics.concat(photosOf(r)); });
    var gallery = allPics.length
      ? '<div class="iacr-gallery"><h3>Customer photos (' + allPics.length + ')</h3>' + pics(allPics.slice(0, 12), 'all') + '</div>'
      : '';
    sec.className = 'iacr';
    sec.innerHTML = '<h2>Customer reviews</h2>'
      + '<div class="iacr-top"><div><div class="iacr-avg">' + avg.toFixed(1) + ' <small>out of 5</small></div>'
      + stars(avg) + '<div class="iacr-sub">' + n + ' verified ' + (n === 1 ? 'review' : 'reviews') + '</div></div>'
      + '<div class="iacr-bars">' + bars + '</div></div>'
      + gallery
      + '<div class="iacr-list">' + rv.slice(0, FIRST).map(item).join('') + '</div>'
      + (n > FIRST ? '<button type="button" class="iacr-more">Show all ' + n + ' reviews</button>' : '');
    summaryLine(avg, n);
    // One listener for every thumbnail, including ones "Show all" adds later.
    sec.onclick = function (e) {
      var b = e.target.closest && e.target.closest('.iacr-pic');
      if (!b) return;
      var set = b.getAttribute('data-set');
      var list = set === 'all' ? allPics : photosOf(rv[Number(set.slice(1))] || {});
      if (list.length) viewer(list, Number(b.getAttribute('data-i')) || 0);
    };
    var more = sec.querySelector('.iacr-more');
    if (more) more.onclick = function () {
      sec.querySelector('.iacr-list').innerHTML = rv.map(item).join('');
      more.remove();
    };
    sec.hidden = false;
    sec.style.display = 'block';
  }

  fetch('/.netlify/functions/get-reviews?slug=' + encodeURIComponent(slug))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      var rv = ((d && d.reviews) || []).filter(function (r) { return Number(r.rating) >= 1; });
      if (rv.length) render(rv); else empty();
    })
    .catch(empty);
  }

  window.iacLoadReviews = load;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load); else load();
})();
