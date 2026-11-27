/* Warehouse app — /admin/pick/ (owner, 27 Nov 2026).
   1. Add books: photograph a stack (copies counted from spines) or one book
      with a typed quantity; check what was read; it goes on the shelf.
   2. Shelf: the warehouse inventory, editable.
   3. Labels: orders the courier has not picked up whose books are all on the
      shelf are ready; orders with a book missing are flagged and printed only
      if you say so. Printing takes the books off the shelf (with Undo).
   Server: admin-warehouse (shelf, photo reading, matching), admin-order-label
   (the PDF). Same sign-in cookie as the admin. */
(() => {
  'use strict';
  const FN = '/.netlify/functions/';
  const app = document.getElementById('app');
  const tabs = document.getElementById('tabs');
  const sheetEl = document.getElementById('sheet');
  const toastEl = document.getElementById('toast');
  const shelfCountEl = document.getElementById('shelfCount');

  const ls = {
    get(k, d) { try { const v = localStorage.getItem('iac_pick_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('iac_pick_' + k, JSON.stringify(v)); } catch (e) {} },
  };
  const state = {
    mode: ls.get('mode', 'stack'),
    images: [],
    scan: null,
    titles: null,
    shelf: null,
    match: null,
    includeDtdc: ls.get('dtdc', false),
    sel: new Set(),
  };

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, w, ws) => n + ' ' + (n === 1 ? w : (ws || w + 's'));
  const wide = () => window.matchMedia('(min-width: 960px)').matches;
  const wireGo = (root) => root.querySelectorAll('[data-go]').forEach((b) => { b.onclick = (e) => { e.preventDefault(); go(b.dataset.go); }; });

  function toast(msg, { bad = false, action, ms } = {}) {
    toastEl.innerHTML = '<span>' + esc(msg) + '</span>' + (action ? '<button type="button">' + esc(action.label) + '</button>' : '');
    toastEl.className = 'toast' + (bad ? ' bad' : '');
    toastEl.hidden = false;
    if (action) toastEl.querySelector('button').onclick = () => { toastEl.hidden = true; action.run(); };
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { toastEl.hidden = true; }, ms || (action ? 9000 : bad ? 5500 : 2800));
  }

  async function api(name, { method = 'GET', query, body } = {}) {
    const qs = query ? '?' + new URLSearchParams(query) : '';
    const res = await fetch(FN + name + qs, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { showLogin(); throw Object.assign(new Error('Signed out'), { quiet: true }); }
    if (res.status === 403) throw new Error(data.error || 'This sign-in cannot use the warehouse app.');
    if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  async function busy(btn, fn, label) {
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>' + (label ? ' ' + esc(label) : '');
    try { return await fn(); }
    catch (e) { if (!e.quiet) toast(e.message, { bad: true }); }
    finally { btn.disabled = false; btn.innerHTML = html; }
  }

  function openSheet(html) {
    sheetEl.innerHTML = '<div class="panel">' + html + '</div>';
    sheetEl.hidden = false;
    sheetEl.onclick = (e) => { if (e.target === sheetEl) closeSheet(); };
    return sheetEl.querySelector('.panel');
  }
  function closeSheet() { sheetEl.hidden = true; sheetEl.innerHTML = ''; }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheetEl.hidden) closeSheet(); });

  const stepper = (val, attrs = '') => `<span class="stepper"><button type="button" data-step="-1" aria-label="One less">−</button><input type="number" inputmode="numeric" min="0" value="${Number(val) || 0}" ${attrs}><button type="button" data-step="1" aria-label="One more">+</button></span>`;
  function wireSteppers(root) {
    root.querySelectorAll('.stepper').forEach((s) => {
      const input = s.querySelector('input');
      s.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
        input.value = Math.max(0, (Number(input.value) || 0) + Number(b.dataset.step));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }));
    });
  }

  async function loadTitles() {
    if (state.titles) return state.titles;
    const r = await api('admin-warehouse', { method: 'POST', body: { action: 'titles' } });
    state.titles = r.titles || [];
    let dl = document.getElementById('known');
    if (!dl) { dl = document.createElement('datalist'); dl.id = 'known'; document.body.appendChild(dl); }
    dl.innerHTML = state.titles.map((t) => '<option value="' + esc(t) + '">').join('');
    return state.titles;
  }
  const knownSet = () => new Set(state.titles || []);

  async function refreshShelf() {
    const r = await api('admin-warehouse', { query: { action: 'state' } });
    state.shelf = r.inventory || [];
    shelfCountEl.textContent = r.books ? '(' + r.books + ')' : '';
    return r;
  }

  // ── Photos ────────────────────────────────────────────────────────────────
  function shrink(file, max = 1600) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not open that photo')); };
      img.src = url;
    });
  }

  // ── Add books ─────────────────────────────────────────────────────────────
  function viewAdd() {
    const single = state.mode === 'single';
    app.innerHTML = `
      <div class="page-head"><div><h2>Add books</h2>
      <p class="muted small">Photograph what has arrived${wide() ? ', or drop / paste photos here' : ''}. Check what was read, then put it on the shelf.</p></div></div>
      <div class="add-grid"><section class="a-photo">
      <div class="seg" role="tablist">
        <button data-mode="stack" class="${single ? '' : 'on'}">📚 Stack of books</button>
        <button data-mode="single" class="${single ? 'on' : ''}">📖 Single book</button>
      </div>
      <label class="drop" for="photo">
        <input id="photo" type="file" accept="image/*" ${single ? '' : 'multiple'} capture="environment">
        <div style="font-size:30px">📷</div>
        <b>${wide() ? (single ? 'Choose, drop or paste a photo of the cover' : 'Choose, drop or paste photos of the stack') : single ? 'Take a photo of the cover' : 'Take photos of the stack (spines visible)'}</b>
        <div class="muted small">${single ? 'One book; type how many copies you have below.' : 'Up to 4 photos; copies are counted from the spines.'}</div>
        <div class="thumbs">${state.images.map((u) => `<img src="${u}" alt="">`).join('')}</div>
      </label>
      ${single ? `<label class="field"><span>Copies of this book</span>${stepper(ls.get('lastQty', 1), 'id="qty"')}</label>` : ''}
      <div class="row" style="margin-top:12px">
        <button class="btn block" id="read" ${state.images.length ? '' : 'disabled'}>Read ${state.images.length > 1 ? 'photos' : 'photo'}</button>
        ${state.images.length ? '<button class="btn ghost" id="clearPics" style="flex:none">Clear</button>' : ''}
      </div></section>
      <section class="a-scan" id="scan">${wide() ? '<div class="card empty placeholder">📋<br>What the photo shows appears here, ready to check.</div>' : ''}</section>
      <section class="a-manual"><h3>Or type a title</h3>
      <div class="card">
        <input type="search" id="manualTitle" list="known" placeholder="Start typing — books orders are waiting for appear">
        <div class="row" style="margin-top:10px">${stepper(1, 'id="manualQty"')}<button class="btn grow" id="manualAdd">Add to shelf</button></div>
      </div></section></div>`;
    wireSteppers(app);
    loadTitles().catch(() => {});
    app.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => {
      state.mode = b.dataset.mode; ls.set('mode', state.mode);
      state.images = []; state.scan = null; viewAdd();
    });
    const addFiles = async (list) => {
      const imgs = [...(list || [])].filter((f) => /^image\//.test(f.type));
      if (!imgs.length) { toast('That is not a photo', { bad: true }); return; }
      const files = imgs.slice(0, single ? 1 : Math.max(0, 4 - state.images.length));
      if (!files.length) { toast('4 photos at most — Clear first', { bad: true }); return; }
      try {
        const urls = await Promise.all(files.map((f) => shrink(f)));
        state.images = single ? urls : [...state.images, ...urls].slice(0, 4);
        state.scan = null;
        viewAdd();
      } catch (err) { toast(err.message, { bad: true }); }
    };
    app.querySelector('#photo').onchange = (e) => addFiles(e.target.files);
    // Desktop: drag photos onto the box, or paste a screenshot / copied image.
    const drop = app.querySelector('.drop');
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };
    window.onpaste = (e) => {
      if (location.hash && location.hash !== '#add') return;
      const files = [...((e.clipboardData && e.clipboardData.files) || [])];
      if (files.some((f) => /^image\//.test(f.type))) { e.preventDefault(); addFiles(files); }
    };
    const clr = app.querySelector('#clearPics');
    if (clr) clr.onclick = (e) => { e.preventDefault(); state.images = []; state.scan = null; viewAdd(); };
    const qtyInput = app.querySelector('#qty');
    if (qtyInput) qtyInput.onchange = () => ls.set('lastQty', Math.max(1, Number(qtyInput.value) || 1));
    app.querySelector('#read').onclick = (e) => busy(e.currentTarget, async () => {
      const r = await api('admin-warehouse', { method: 'POST', body: { action: 'scan', images: state.images, single, qty: qtyInput ? Number(qtyInput.value) || 1 : undefined } });
      await loadTitles();
      state.scan = (r.books || []).map((b) => ({ ...b, title: b.match ? b.match.title : b.seen, include: !b.unreadable }));
      renderScan();
    }, 'Reading…');
    app.querySelector('#manualTitle').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); app.querySelector('#manualAdd').click(); } };
    app.querySelector('#manualAdd').onclick = (e) => {
      const title = app.querySelector('#manualTitle').value.trim();
      const qty = Number(app.querySelector('#manualQty').value) || 0;
      if (!title || !qty) { toast('Type a title and a quantity', { bad: true }); return; }
      busy(e.currentTarget, async () => {
        await addToShelf([{ title, qty }]);
        app.querySelector('#manualTitle').value = '';
      });
    };
    if (state.scan) renderScan();
  }

  function renderScan() {
    const box = app.querySelector('#scan');
    if (!box) return;
    if (!state.scan.length) { box.innerHTML = '<div class="card empty">No books found in the photo. Try closer, with the spines straight on.</div>'; return; }
    const known = knownSet();
    box.innerHTML = `<h3 class="scan-h">Found ${plural(state.scan.length, 'book')} — check before adding</h3>
      <div class="card">${state.scan.map((b, i) => {
        const waiting = known.has(b.title);
        const chip = b.unreadable ? '<span class="chip bad">Could not read — type the title</span>'
          : waiting ? '<span class="chip ok">Orders are waiting for this</span>'
            : '<span class="chip warn">No waiting order has this title</span>';
        return `<div class="book" data-i="${i}">
          <input type="checkbox" data-inc ${b.include ? 'checked' : ''} aria-label="Add this book">
          <div>
            <input type="text" list="known" data-title value="${esc(b.title === 'unreadable' ? '' : b.title)}" placeholder="Title">
            <div class="small muted" style="margin-top:4px">Read as: “${esc(b.seen)}”${b.author ? ' · ' + esc(b.author) : ''}${b.language ? ' · ' + esc(b.language) : ''}</div>
            <div class="row" style="justify-content:space-between;margin-top:6px">${chip}${stepper(b.count, 'data-count')}</div>
          </div></div>`;
      }).join('')}</div>
      <button class="btn block green" id="addAll" style="margin-top:6px">Put on shelf</button>`;
    wireSteppers(box);
    box.querySelectorAll('.book').forEach((el) => {
      const b = state.scan[Number(el.dataset.i)];
      el.querySelector('[data-inc]').onchange = (e) => { b.include = e.target.checked; };
      el.querySelector('[data-title]').onchange = (e) => { b.title = e.target.value.trim(); b.unreadable = !b.title; if (b.title) b.include = true; renderScan(); };
      el.querySelector('[data-count]').onchange = (e) => { b.count = Math.max(0, Number(e.target.value) || 0); };
    });
    box.querySelector('#addAll').onclick = (e) => {
      const items = state.scan.filter((b) => b.include && b.title && b.count > 0).map((b) => ({ title: b.title, qty: b.count }));
      if (!items.length) { toast('Tick at least one book', { bad: true }); return; }
      busy(e.currentTarget, async () => {
        await addToShelf(items);
        state.images = []; state.scan = null;
        viewAdd();
      });
    };
  }

  async function addToShelf(items) {
    const r = await api('admin-warehouse', { method: 'POST', body: { action: 'add', items } });
    shelfCountEl.textContent = r.books ? '(' + r.books + ')' : '';
    state.match = null;
    const n = items.reduce((s, i) => s + i.qty, 0);
    toast(plural(n, 'book') + ' added · ' + r.books + ' on the shelf', { action: { label: 'Labels →', run: () => go('labels') } });
  }

  // ── Shelf ─────────────────────────────────────────────────────────────────
  async function viewShelf() {
    app.innerHTML = '<div class="page-head"><div><h2>Shelf</h2><p class="muted small">Books in the warehouse right now. Printing labels takes their books off.</p></div></div><div id="list"><div class="card empty"><span class="spin"></span></div></div>';
    try {
      const r = await refreshShelf();
      const list = app.querySelector('#list');
      if (!state.shelf.length) { list.innerHTML = '<div class="card empty">The shelf is empty. Add books from a photo first.<br><button class="btn sm" data-go="add" style="margin-top:12px">📷 Add books</button></div>'; wireGo(list); return; }
      list.innerHTML = `<div class="toolbar"><p><b>${plural(r.books, 'book')}</b> · ${plural(state.shelf.length, 'title')}</p>
        <input type="search" id="filter" placeholder="Find a book"></div>
        <div class="card shelf-rows" id="rows">${state.shelf.map((b) => `<div class="book" style="grid-template-columns:1fr auto;align-items:center" data-t="${esc(b.title)}">
          <div class="t">${esc(b.title)}</div>
          <div class="row">${stepper(b.qty, 'data-qty')}<button class="btn sm danger" data-del aria-label="Remove">✕</button></div></div>`).join('')}</div>
        <button class="btn block danger" id="clearShelf" style="margin-top:10px">Empty the whole shelf</button>`;
      wireSteppers(list);
      list.querySelector('#filter').oninput = (e) => {
        const q = e.target.value.toLowerCase();
        list.querySelectorAll('[data-t]').forEach((el) => { el.hidden = q && !el.dataset.t.toLowerCase().includes(q); });
      };
      list.querySelectorAll('[data-t]').forEach((el) => {
        const title = el.dataset.t;
        el.querySelector('[data-qty]').onchange = async (e) => {
          try { await api('admin-warehouse', { method: 'POST', body: { action: 'add', mode: 'set', items: [{ title, qty: Number(e.target.value) || 0 }] } }); state.match = null; refreshShelf(); toast('Saved'); }
          catch (err) { if (!err.quiet) toast(err.message, { bad: true }); }
        };
        el.querySelector('[data-del]').onclick = async () => {
          try { await api('admin-warehouse', { method: 'POST', body: { action: 'remove', title } }); state.match = null; viewShelf(); }
          catch (err) { if (!err.quiet) toast(err.message, { bad: true }); }
        };
      });
      list.querySelector('#clearShelf').onclick = () => {
        const p = openSheet(`<h3>Empty the shelf?</h3><p>All ${plural(r.books, 'book')} come off the inventory. Labels already printed are not affected.</p>
          <div class="actions"><button class="btn danger" data-yes>Empty it</button><button class="btn ghost" data-no>Keep</button></div>`);
        p.querySelector('[data-no]').onclick = closeSheet;
        p.querySelector('[data-yes]').onclick = (e) => busy(e.currentTarget, async () => {
          await api('admin-warehouse', { method: 'POST', body: { action: 'clear', confirm: true } });
          closeSheet(); state.match = null; viewShelf();
        });
      };
    } catch (e) { if (!e.quiet) app.querySelector('#list').innerHTML = '<div class="card empty">⚠️ ' + esc(e.message) + '</div>'; }
  }

  // ── Labels ────────────────────────────────────────────────────────────────
  const orderHtml = (o, checked) => `<div class="order" data-id="${esc(o.order_id)}">
      <input type="checkbox" data-pick ${checked ? 'checked' : ''} aria-label="Print this label">
      <div><div class="row" style="justify-content:space-between"><span class="id">${esc(o.order_id)}</span><span class="small muted">${esc(o.courier || 'Not booked')}</span></div>
      <ul>${o.lines.map((l) => {
        const miss = (o.missing || []).find((m) => m.title === l.title);
        return `<li class="${miss ? 'miss' : ''}">${l.qty} × ${esc(l.title)}${miss ? ' — <b>' + esc(miss.reason || 'not in the warehouse') + '</b>' : ''}</li>`;
      }).join('')}</ul>
      <div class="small muted">${o.age_hours != null ? Math.floor(o.age_hours / 24) + 'd old · ' : ''}${esc(o.payment || '')}${o.awb ? ' · ' + esc(o.awb) : ''}</div></div></div>`;

  async function viewLabels(force) {
    app.innerHTML = `<div class="page-head"><div><h2>Labels</h2><p class="muted small">Orders the courier has not picked up, matched against the shelf (oldest orders get the books first).</p></div>
      <div class="head-tools"><label class="toggle"><input type="checkbox" id="dtdc" ${state.includeDtdc ? 'checked' : ''}> Include DTDC orders</label>
      <button class="btn sm ghost" id="refresh" title="Match again">↻ Refresh</button></div></div>
      <div id="body"><div class="card empty"><span class="spin"></span> Matching orders…</div></div>`;
    app.querySelector('#dtdc').onchange = (e) => { state.includeDtdc = e.target.checked; ls.set('dtdc', state.includeDtdc); state.match = null; viewLabels(true); };
    app.querySelector('#refresh').onclick = () => { state.match = null; viewLabels(true); };
    const body = app.querySelector('#body');
    try {
      if (!state.match || force) {
        state.match = await api('admin-warehouse', { query: { action: 'match', dtdc: state.includeDtdc ? '1' : '0' } });
        state.sel = new Set(state.match.ready.map((o) => o.order_id));
      }
      renderLabels(body);
    } catch (e) { if (!e.quiet) body.innerHTML = '<div class="card empty">⚠️ ' + esc(e.message) + '</div>'; }
  }

  function renderLabels(body) {
    const m = state.match;
    const readyBooks = m.ready.reduce((n, o) => n + o.units, 0);
    const left = m.shelf.filter((s) => s.left > 0);
    if (!m.shelf.length) { body.innerHTML = '<div class="card empty big-empty"><div style="font-size:34px">📦</div><b>The shelf is empty</b><p>Add the books that have arrived, then their orders show up here ready to print.</p><button class="btn" data-go="add">📷 Add books</button></div>'; wireGo(body); return; }
    body.innerHTML = `
      <div class="kpis"><div class="kpi ok"><b>${m.ready.length}</b><span>ready (${plural(readyBooks, 'book')})</span></div>
        <div class="kpi warn"><b>${m.flagged.length}</b><span>missing a book</span></div>
        <div class="kpi"><b>${m.not_booked.length}</b><span>not booked yet</span></div></div>
      ${m.skipped.extracted ? `<p class="small muted">${plural(m.skipped.extracted, 'order')} already printed from here are hidden. <a href="#" id="showPrinted">Show them again</a></p>` : ''}
      ${m.skipped.dtdc ? `<p class="small muted">${plural(m.skipped.dtdc, 'DTDC order')} hidden.</p>` : ''}
      <div class="lab-grid${m.flagged.length ? ' two' : ''}">
      <section><div class="sec-head"><h3>Ready — every book is on the shelf</h3>${m.ready.length > 1 ? '<a href="#" data-all="ready" class="small">Select all / none</a>' : ''}</div>
      <div class="card">${m.ready.length ? m.ready.map((o) => orderHtml(o, state.sel.has(o.order_id))).join('') : '<div class="empty">None yet.</div>'}</div></section>
      ${m.flagged.length ? `<section><div class="sec-head"><h3>Flagged — some books are not in the warehouse</h3>${m.flagged.length > 1 ? '<a href="#" data-all="flagged" class="small">Select all / none</a>' : ''}</div>
        <div class="card flagged">${m.flagged.map((o) => orderHtml(o, state.sel.has(o.order_id))).join('')}</div></section>` : ''}
      </div>
      ${m.not_booked.length ? `<details class="card"><summary>Not booked with a courier yet (${m.not_booked.length})</summary>
        <p class="small muted">These have books on the shelf but no label exists yet. Book them in the admin first.</p>
        ${m.not_booked.map((o) => orderHtml(o, false).replace('<input type="checkbox" data-pick', '<input type="checkbox" disabled')).join('')}</details>` : ''}
      ${left.length ? `<details class="card"><summary>Left on the shelf after these (${left.reduce((n, s) => n + s.left, 0)})</summary>
        <ul class="small">${left.map((s) => `<li>${s.left} × ${esc(s.title)}</li>`).join('')}</ul></details>` : ''}
      ${m.last_print ? `<p class="small muted">Last print: ${plural(m.last_print.orders, 'order')}, ${new Date(m.last_print.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. <a href="#" id="undo">Undo it</a></p>` : ''}
      <div class="sticky-bar"><div class="inner"><span class="sel-info" id="selInfo"></span><button class="btn block" id="extract">Extract labels</button></div></div>`;
    app.classList.add('has-bar');
    const btn = body.querySelector('#extract');
    const info = body.querySelector('#selInfo');
    const syncBtn = () => {
      btn.textContent = state.sel.size ? 'Extract labels (' + state.sel.size + ')' : 'Extract labels';
      const picked = [...m.ready, ...m.flagged].filter((o) => state.sel.has(o.order_id));
      const fl = m.flagged.filter((o) => state.sel.has(o.order_id)).length;
      info.textContent = picked.length ? plural(picked.length, 'order') + ' · ' + plural(picked.reduce((n, o) => n + o.units, 0), 'book') + (fl ? ' · ' + fl + ' flagged' : '') : 'Nothing ticked';
    };
    syncBtn();
    body.querySelectorAll('[data-all]').forEach((a) => a.onclick = (e) => {
      e.preventDefault();
      const ids = m[a.dataset.all].map((o) => o.order_id);
      const on = !ids.every((id) => state.sel.has(id));
      ids.forEach((id) => (on ? state.sel.add(id) : state.sel.delete(id)));
      body.querySelectorAll('.order [data-pick]').forEach((cb) => { cb.checked = state.sel.has(cb.closest('.order').dataset.id); });
      syncBtn();
    });
    body.querySelectorAll('.order [data-pick]').forEach((cb) => cb.onchange = (e) => {
      const id = e.target.closest('.order').dataset.id;
      if (e.target.checked) state.sel.add(id); else state.sel.delete(id);
      syncBtn();
    });
    btn.onclick = () => extract(btn);
    const undo = body.querySelector('#undo');
    if (undo) undo.onclick = (e) => { e.preventDefault(); undoPrint(); };
    const sp = body.querySelector('#showPrinted');
    if (sp) sp.onclick = (e) => { e.preventDefault(); reprintAll(); };
  }

  /** Ask before printing any order with a book that is not in the warehouse. */
  function extract(btn) {
    const m = state.match;
    const ready = m.ready.filter((o) => state.sel.has(o.order_id));
    const flaggedPicked = m.flagged.filter((o) => state.sel.has(o.order_id));
    const flaggedAll = m.flagged;
    if (!ready.length && !flaggedAll.length) { toast('Nothing to print', { bad: true }); return; }
    const ask = flaggedPicked.length ? flaggedPicked : (flaggedAll.length ? flaggedAll : []);
    if (!ask.length) { download(btn, ready); return; }
    const missingList = ask.map((o) => `<li><b>${esc(o.order_id)}</b><ul>${o.missing.map((x) => `<li class="small">${x.qty} × ${esc(x.title)} — ${esc(x.reason || 'not in the warehouse')}</li>`).join('')}</ul></li>`).join('');
    const p = openSheet(`<h3>${plural(ask.length, 'order')} ${ask.length === 1 ? 'has' : 'have'} books not in the warehouse</h3>
      <p class="small muted">${flaggedPicked.length ? 'You ticked these.' : 'These orders have some books on the shelf, but not all.'} Extract their labels anyway?</p>
      <ul style="padding-left:18px">${missingList}</ul>
      <div class="actions">
        <button class="btn" data-anyway>Yes, extract anyway (${ready.length + ask.length})</button>
        ${ready.length ? `<button class="btn ghost" data-ready>No, only the ready ones (${ready.length})</button>` : ''}
        <button class="btn ghost" data-cancel>Cancel</button>
      </div>`);
    p.querySelector('[data-cancel]').onclick = closeSheet;
    p.querySelector('[data-anyway]').onclick = () => { closeSheet(); download(btn, [...ready, ...ask]); };
    const r = p.querySelector('[data-ready]');
    if (r) r.onclick = () => { closeSheet(); download(btn, ready); };
  }

  async function download(btn, orders) {
    if (!orders.length) return;
    if (orders.length > 200) { toast('At most 200 labels at a time', { bad: true }); return; }
    await busy(btn, async () => {
      const res = await fetch(FN + 'admin-order-label', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders: orders.map((o) => ({ awb: o.awb, order: o.order_id, courier: o.courier })) }),
      });
      if (res.status === 401) { showLogin(); return; }
      if (!res.ok || !(res.headers.get('Content-Type') || '').includes('pdf')) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data.error || 'No labels found') + (data.missing && data.missing.length ? ': ' + data.missing.map((x) => x.order || x.awb).join(', ') : ''));
      }
      let sum = {};
      try { sum = JSON.parse(decodeURIComponent(res.headers.get('X-Label-Summary') || '%7B%7D')); } catch (e) {}
      const blob = await res.blob();
      const day = new Date().toISOString().slice(0, 10);
      await saveFile(blob, `warehouse-labels-${day}.pdf`);
      const missing = new Set((sum.missing || []).map((x) => x.order));
      const printed = orders.filter((o) => !missing.has(o.order_id));
      if (printed.length) {
        const r = await api('admin-warehouse', { method: 'POST', body: { action: 'printed', orders: printed.map((o) => ({ order_id: o.order_id, lines: o.lines.filter((l) => l.key) })) } });
        const taken = (r.taken || []).reduce((n, t) => n + t.qty, 0);
        refreshShelf().catch(() => {});
        toast(`${plural(printed.length, 'label')} saved · ${plural(taken, 'book')} taken off the shelf`, { action: { label: 'Undo', run: undoPrint }, ms: 12000 });
      }
      if (missing.size) {
        openSheet(`<h3>No label found for ${plural(missing.size, 'order')}</h3><ul>${(sum.missing || []).map((x) => `<li>${esc(x.order || '')} ${esc(x.awb || '')} — ${esc(x.reason || '')}</li>`).join('')}</ul>
          <p class="small muted">Their books stay on the shelf. Bookings made directly on a courier's own portal are not reachable from here.</p><div class="actions"><button class="btn ghost" data-ok>OK</button></div>`)
          .querySelector('[data-ok]').onclick = closeSheet;
      }
      state.match = null;
      viewLabels(true);
    }, 'Getting labels…');
  }

  async function saveFile(blob, name) {
    const file = new File([blob], name, { type: 'application/pdf' });
    // Installed on a phone, a plain download often goes nowhere visible; the
    // share sheet lets the owner print, save to Files or send it on.
    if (navigator.canShare && navigator.canShare({ files: [file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  async function undoPrint() {
    try {
      const r = await api('admin-warehouse', { method: 'POST', body: { action: 'undo' } });
      toast(`Undone: ${plural(r.restored, 'order')} back in the list, books back on the shelf`);
      state.match = null; refreshShelf().catch(() => {});
      if (location.hash === '#labels') viewLabels(true);
    } catch (e) { if (!e.quiet) toast(e.message, { bad: true }); }
  }

  async function reprintAll() {
    const p = openSheet(`<h3>Show printed orders again?</h3><p>Orders whose labels were already extracted here come back into the list, so they can be printed again. The shelf does not change.</p>
      <div class="actions"><button class="btn" data-yes>Show them</button><button class="btn ghost" data-no>Cancel</button></div>`);
    p.querySelector('[data-no]').onclick = closeSheet;
    p.querySelector('[data-yes]').onclick = (e) => busy(e.currentTarget, async () => {
      await api('admin-warehouse', { method: 'POST', body: { action: 'reprint', all: true, order_ids: [] } });
      closeSheet(); state.match = null; viewLabels(true);
    });
  }

  // ── Sign-in + routing ─────────────────────────────────────────────────────
  function showLogin() {
    closeSheet();
    tabs.hidden = true;
    document.body.classList.remove('in');
    app.classList.remove('has-bar');
    app.innerHTML = `<div class="login"><form class="card" autocomplete="on">
      <h2>Sign in</h2><p class="muted small">Same email and password as the Ink &amp; Chai admin.</p>
      <label class="field"><span>Email</span><input name="email" type="email" inputmode="email" autocomplete="username" required></label>
      <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
      <div class="err" data-err></div>
      <button class="btn block" type="submit">Sign in</button>
    </form></div>`;
    const form = app.querySelector('form');
    form.onsubmit = (e) => {
      e.preventDefault();
      const err = form.querySelector('[data-err]');
      err.textContent = '';
      busy(form.querySelector('button'), async () => {
        const res = await fetch(FN + 'admin-login', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: form.email.value, password: form.password.value, remember: true }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { err.textContent = data.error || 'Could not sign in'; return; }
        start();
      });
    };
  }

  function go(tab) { if (location.hash !== '#' + tab) location.hash = tab; else route(); }
  function route() {
    const tab = (location.hash || '#add').slice(1);
    app.classList.remove('has-bar');
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    window.scrollTo(0, 0);
    if (tab === 'shelf') return viewShelf();
    if (tab === 'labels') return viewLabels();
    return viewAdd();
  }

  async function start() {
    try {
      const res = await fetch(FN + 'admin-session', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) { showLogin(); return; }
    } catch (e) {
      app.innerHTML = '<div class="card empty">No connection. Reopen to try again.</div>';
      return;
    }
    tabs.hidden = false;
    document.body.classList.add('in');
    tabs.querySelectorAll('button').forEach((b) => b.onclick = () => go(b.dataset.tab));
    window.onhashchange = route;
    refreshShelf().catch(() => {});
    route();
  }

  start();
})();
