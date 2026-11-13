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

  function empty() {
    sec.className = 'iacr';
    sec.innerHTML = '<h2>Customer reviews</h2>'
      + '<div class="iacr-empty">' + stars(0)
      + '<div><b>No reviews yet</b>'
      + '<p>Bought this book from Ink &amp; Chai? After delivery we send you a WhatsApp link to rate it. Only verified buyers can review.</p></div></div>';
    sec.hidden = false;
    sec.style.display = 'block';
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
        + '</div>';
    };
    var FIRST = 5;
    sec.className = 'iacr';
    sec.innerHTML = '<h2>Customer reviews</h2>'
      + '<div class="iacr-top"><div><div class="iacr-avg">' + avg.toFixed(1) + ' <small>out of 5</small></div>'
      + stars(avg) + '<div class="iacr-sub">' + n + ' verified ' + (n === 1 ? 'review' : 'reviews') + '</div></div>'
      + '<div class="iacr-bars">' + bars + '</div></div>'
      + '<div class="iacr-list">' + rv.slice(0, FIRST).map(item).join('') + '</div>'
      + (n > FIRST ? '<button type="button" class="iacr-more">Show all ' + n + ' reviews</button>' : '');
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
