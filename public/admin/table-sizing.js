/* Table dimensions are browser preferences; no order data is changed. */
(() => {
  const section = document.getElementById('ordersTableSection');
  const body = document.getElementById('ordersBody');
  const table = section?.querySelector('table');
  if (!table || !body) return;
  const headers = [...table.tHead.rows[0].cells];
  const names = headers.map((cell, i) => i ? cell.textContent.replace('↕', '').trim() : 'Selection');
  const KEY = 'iac_admin_order_table_sizes_v1';
  const desktop = matchMedia('(min-width:821px)');
  const clamp = (value, min, max) => Math.round(Math.min(max, Math.max(min, value)));
  const valid = (n, min, max) => Number.isFinite(n) && n >= min && n <= max;
  let prefs = { widths: null, height: null, rows: Object.create(null) };
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (stored) {
      if (Array.isArray(stored.widths) && stored.widths.length === headers.length && stored.widths.every((v, i) => valid(v, i ? 100 : 48, 1000))) prefs.widths = stored.widths;
      if (valid(stored.height, 80, 1200)) prefs.height = stored.height;
      for (const [key, value] of Object.entries(stored.rows || {}).slice(-500)) if (value === null || valid(value, 80, 1200)) prefs.rows[key] = value;
    }
  } catch { /* A blocked or invalid preference store must not block the admin. */ }

  const panel = document.createElement('details');
  panel.className = 'order-size-panel';
  panel.innerHTML = `<summary>Resize rows &amp; columns</summary>
    <p>Drag a column edge or a row’s ↕ handle, or enter a size below. Shorter rows scroll inside each cell. Sizes are saved in this browser.</p>
    <div class="order-size-fields">
      <label>Column<select id="orderSizeColumn"></select></label>
      <label>Width (px)<input id="orderSizeWidth" type="number" min="100" max="1000" step="10" inputmode="numeric"></label>
      <button type="button" id="orderSizeApplyColumn" class="btn-outline">Set width</button>
      <label>Row<select id="orderSizeRow"><option value="">All rows</option></select></label>
      <label>Height (px)<input id="orderSizeHeight" type="number" min="80" max="1200" step="10" inputmode="numeric" placeholder="Auto"></label>
      <button type="button" id="orderSizeApplyRow" class="btn-outline">Set height</button>
      <button type="button" id="orderSizeAutoRow" class="btn-outline">Auto height</button>
      <button type="button" id="orderSizeReset" class="btn-outline">Reset all sizes</button>
    </div><p id="orderSizeNotice" role="status" aria-live="polite"></p>`;
  section.before(panel);
  const find = id => panel.querySelector('#' + id);
  const column = find('orderSizeColumn'), widthInput = find('orderSizeWidth');
  const rowSelect = find('orderSizeRow'), heightInput = find('orderSizeHeight');
  const notice = find('orderSizeNotice');
  names.forEach((name, i) => column.add(new Option(name, String(i))));
  column.value = '1';
  const rows = () => [...body.querySelectorAll('tr[data-order-size-key]')];
  const heightForKey = key => Object.hasOwn(prefs.rows, key) ? prefs.rows[key] : prefs.height;
  const heightFor = row => heightForKey(row.dataset.orderSizeKey);
  const widths = () => prefs.widths || headers.map((header, i) => clamp(header.getBoundingClientRect().width, i ? 100 : 48, 1000));
  function save() {
    prefs.rows = Object.assign(Object.create(null), Object.fromEntries(Object.entries(prefs.rows).slice(-500)));
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); notice.textContent = 'Sizes saved in this browser.'; }
    catch { notice.textContent = 'Sizes applied. This browser could not save them for next time.'; }
  }
  let cols;
  function applyColumns() {
    const fixed = desktop.matches && !!prefs.widths;
    table.classList.toggle('order-table-sized', fixed);
    if (!fixed) {
      cols?.remove(); cols = null; table.style.removeProperty('width');
    } else {
      if (!cols) {
        cols = document.createElement('colgroup');
        headers.forEach(() => cols.append(document.createElement('col')));
        table.prepend(cols);
      }
      prefs.widths.forEach((w, i) => { cols.children[i].style.width = w + 'px'; });
      table.style.width = prefs.widths.reduce((a, b) => a + b, 0) + 'px';
    }
    headers.forEach((header, i) => {
      const handle = header.querySelector('.order-column-grip');
      handle?.setAttribute('aria-valuenow', String(widths()[i]));
    });
  }
  function applyRow(row) {
    const height = desktop.matches ? heightFor(row) : null;
    row.classList.toggle('order-row-sized', height !== null);
    for (const cell of row.cells) {
      let content = cell.querySelector(':scope > .order-cell-content');
      if (height !== null) {
        if (!content) {
          content = document.createElement('div'); content.className = 'order-cell-content';
          // Move the existing nodes so inline actions and event listeners survive.
          for (const node of [...cell.childNodes]) if (!node.classList?.contains('order-row-grip')) content.append(node);
          cell.prepend(content);
        }
        content.style.height = height + 'px';
      } else if (content) content.replaceWith(...content.childNodes);
    }
    row.querySelector('.order-row-grip')?.setAttribute('aria-valuenow', String(height ?? Math.round(row.getBoundingClientRect().height)));
  }
  function syncFields() {
    const i = Number(column.value);
    widthInput.min = i ? '100' : '48'; widthInput.value = String(widths()[i]);
    const key = rowSelect.value;
    heightInput.value = (key ? heightForKey(key) : prefs.height) ?? '';
  }
  function setColumn(i, value) {
    column.value = String(i);
    prefs.widths = [...widths()]; prefs.widths[i] = clamp(value, i ? 100 : 48, 1000);
    applyColumns(); syncFields();
  }
  function setRow(key, value) {
    rowSelect.value = key;
    if (key) {
      prefs.rows[key] = value === null ? null : clamp(value, 80, 1200);
    } else {
      prefs.height = value === null ? null : clamp(value, 80, 1200);
      prefs.rows = Object.create(null);
    }
    rows().forEach(applyRow); syncFields();
  }
  function grip(orientation, name, get, set, min, max) {
    const handle = document.createElement('span');
    handle.className = orientation === 'vertical' ? 'order-column-grip' : 'order-row-grip';
    handle.tabIndex = 0; handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-label', name); handle.setAttribute('aria-orientation', orientation);
    handle.setAttribute('aria-valuemin', min); handle.setAttribute('aria-valuemax', max);
    handle.title = name + '. Drag or use arrow keys.';
    if (orientation === 'horizontal') handle.textContent = '↕';
    handle.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); });
    handle.addEventListener('keydown', e => {
      const keys = orientation === 'vertical' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
      if (!keys.includes(e.key)) return;
      e.preventDefault(); e.stopPropagation(); set(get() + (e.key === keys[0] ? -1 : 1) * (e.shiftKey ? 50 : 10)); save();
    });
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !desktop.matches) return;
      e.preventDefault(); e.stopPropagation();
      const start = orientation === 'vertical' ? e.clientX : e.clientY, initial = get();
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add('order-size-dragging');
      const move = event => set(initial + (orientation === 'vertical' ? event.clientX : event.clientY) - start);
      const finish = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', finish);
        handle.removeEventListener('lostpointercapture', finish);
        document.body.classList.remove('order-size-dragging'); save();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', finish);
      handle.addEventListener('lostpointercapture', finish);
    });
    return handle;
  }
  headers.forEach((header, i) => header.append(grip('vertical', 'Resize ' + names[i] + ' column', () => widths()[i], value => setColumn(i, value), i ? 100 : 48, 1000)));
  function syncRows() {
    const selected = rowSelect.value;
    rowSelect.replaceChildren(new Option('All rows', ''));
    for (const row of rows()) {
      const key = row.dataset.orderSizeKey;
      const name = row.querySelector('.order-id')?.textContent.trim() || key;
      rowSelect.add(new Option(name, key));
      if (!row.querySelector('.order-row-grip')) row.cells[0].append(grip('horizontal', 'Resize row ' + name,
        () => heightFor(row) ?? Math.round(row.getBoundingClientRect().height), value => setRow(key, value), 80, 1200));
      applyRow(row);
    }
    if ([...rowSelect.options].some(o => o.value === selected)) rowSelect.value = selected;
    syncFields();
  }
  column.addEventListener('change', syncFields); rowSelect.addEventListener('change', syncFields);
  find('orderSizeApplyColumn').addEventListener('click', () => {
    if (!widthInput.value || !widthInput.reportValidity()) return;
    setColumn(Number(column.value), Number(widthInput.value)); save();
  });
  find('orderSizeApplyRow').addEventListener('click', () => {
    if (!heightInput.value || !heightInput.reportValidity()) return;
    setRow(rowSelect.value, Number(heightInput.value)); save();
  });
  find('orderSizeAutoRow').addEventListener('click', () => {
    setRow(rowSelect.value, null); save();
  });
  find('orderSizeReset').addEventListener('click', () => {
    prefs = { widths: null, height: null, rows: Object.create(null) };
    applyColumns(); syncRows(); save(); notice.textContent = 'Default column widths and automatic row heights restored.';
  });
  new MutationObserver(syncRows).observe(body, { childList: true });
  desktop.addEventListener('change', () => { applyColumns(); syncRows(); });
  applyColumns(); syncRows();
})();
