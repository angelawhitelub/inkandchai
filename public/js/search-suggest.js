/*
 * Amazon-style search autocomplete for product pages.
 * Attaches to any <form class="nav-search"> / <form class="pdp-search"> that has
 * an <input name="q">. As the customer types, it fetches instant book
 * suggestions from /.netlify/functions/search-suggest and shows a dropdown with
 * cover + title + price. Click a suggestion → go straight to that product;
 * press Enter with nothing selected → the form's normal /?q= submit still works.
 */
(function () {
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var css = ''
    + '.sugg-box{position:absolute;top:calc(100% + 6px);left:0;right:0;z-index:9999;display:none;'
    + 'background:var(--glass-bg,#15110e);border:1px solid var(--border,rgba(214,184,94,.28));'
    + 'border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.42);overflow:hidden;max-height:74vh;overflow-y:auto;-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px)}'
    + 'html[data-theme="light"] .sugg-box{background:#fffdf8}'
    + '.sugg-row{display:flex;align-items:center;gap:.7rem;padding:.5rem .8rem;text-decoration:none;'
    + 'color:var(--cream,#f4ecdc);border-bottom:1px solid rgba(214,184,94,.10)}'
    + '.sugg-row:last-child{border-bottom:0}'
    + '.sugg-row:hover,.sugg-row.sugg-active{background:rgba(214,184,94,.14)}'
    + '.sugg-row img{width:32px;height:46px;object-fit:cover;border-radius:4px;flex:0 0 auto;background:rgba(150,150,150,.15)}'
    + '.sugg-main{flex:1;min-width:0}'
    + '.sugg-t{font-size:.82rem;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}'
    + '.sugg-a{font-size:.66rem;color:var(--muted,#b9ab96);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '.sugg-p{font-size:.82rem;color:var(--gold,#d6b85e);font-weight:600;white-space:nowrap}'
    + '.sugg-foot{display:block;padding:.5rem .8rem;font-size:.7rem;letter-spacing:.05em;color:var(--muted,#b9ab96);text-decoration:none;text-align:center;border-top:1px solid rgba(214,184,94,.14)}'
    + '.sugg-foot:hover{color:var(--gold,#d6b85e)}';
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  function initSuggest(form) {
    var input = form.querySelector('input[name="q"]');
    if (!input || form.__suggestReady) return;
    form.__suggestReady = true;
    form.style.position = 'relative';
    input.setAttribute('autocomplete', 'off');

    var box = document.createElement('div');
    box.className = 'sugg-box';
    form.appendChild(box);

    var items = [], sel = -1, timer = null, lastQ = '';

    function close() { box.style.display = 'none'; sel = -1; }
    function highlight() {
      var rows = box.querySelectorAll('.sugg-row');
      for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('sugg-active', i === sel);
      if (sel >= 0 && rows[sel]) rows[sel].scrollIntoView({ block: 'nearest' });
    }
    function render(results, q) {
      items = results || [];
      if (!items.length) { close(); return; }
      var html = items.map(function (r, i) {
        var mrp = r.mrp ? '<span style="color:var(--muted,#b9ab96);text-decoration:line-through;font-size:.66rem;margin-left:.35rem">₹' + r.mrp + '</span>' : '';
        return '<a class="sugg-row" href="' + esc(r.url) + '" data-i="' + i + '">'
          + '<img loading="lazy" src="' + esc(r.img) + '" alt=""/>'
          + '<span class="sugg-main"><span class="sugg-t">' + esc(r.title) + '</span>'
          + (r.author ? '<span class="sugg-a">' + esc(r.author) + '</span>' : '') + '</span>'
          + '<span class="sugg-p">₹' + r.price + mrp + '</span></a>';
      }).join('');
      html += '<a class="sugg-foot" href="/?q=' + encodeURIComponent(q) + '">See all results for “' + esc(q) + '” →</a>';
      box.innerHTML = html;
      box.style.display = 'block';
      sel = -1;
    }

    input.addEventListener('input', function () {
      var q = input.value.trim();
      clearTimeout(timer);
      if (q.length < 2) { close(); return; }
      timer = setTimeout(function () {
        lastQ = q;
        fetch('/.netlify/functions/search-suggest?q=' + encodeURIComponent(q))
          .then(function (r) { return r.json(); })
          .then(function (d) { if (input.value.trim() === lastQ) render(d.results || [], q); })
          .catch(function () { close(); });
      }, 200);
    });

    input.addEventListener('keydown', function (e) {
      if (box.style.display === 'none') return;
      var rows = box.querySelectorAll('.sugg-row');
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(rows.length - 1, sel + 1); highlight(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(-1, sel - 1); highlight(); }
      else if (e.key === 'Enter') { if (sel >= 0 && items[sel]) { e.preventDefault(); window.location.href = items[sel].url; } }
      else if (e.key === 'Escape') { close(); }
    });

    input.addEventListener('focus', function () {
      if (items.length && input.value.trim().length >= 2) box.style.display = 'block';
    });
    document.addEventListener('click', function (e) { if (!form.contains(e.target)) close(); });
  }

  function boot() {
    var forms = document.querySelectorAll('form.nav-search, form.pdp-search');
    for (var i = 0; i < forms.length; i++) initSuggest(forms[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
