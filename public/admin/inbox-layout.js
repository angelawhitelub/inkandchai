/* Local display preferences only. No customer data or message actions. */
(() => {
  const KEY = 'iac_inbox_layout_v1';
  const root = document.body, panel = document.getElementById('inboxLayout');
  if (!panel) return;
  const mobile = matchMedia('(max-width:820px)');
  let saved = {};
  try { const value = JSON.parse(localStorage.getItem(KEY) || '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) saved = value; } catch {}
  function blockBudget() {
    const body = document.getElementById('threadBody');
    if (!body?.clientHeight) return innerHeight * .5;
    const height = selector => body.querySelector(selector)?.getBoundingClientRect().height || 0;
    const composerStyle = getComputedStyle(body.querySelector('.composer'));
    const padding = parseFloat(composerStyle.paddingTop) + parseFloat(composerStyle.paddingBottom);
    // Leave a readable message area even when both blocks are expanded.
    return Math.max(152, body.clientHeight - height('.thead') - height('.history-status') - height('#chatSummary') - height('#inboxReplyGrip') - height('#inboxDetailsGrip') - padding - 120);
  }
  const specs = {
    sidebar: {min:260, max:() => Math.max(260, Math.min(680, innerWidth - 380)), default:rem => 23.5 * rem, unit:'px'},
    rows: {min:64, max:() => 200, default:rem => 5.2 * rem, unit:'px'},
    bubble: {min:45, max:() => 100, default:() => mobile.matches ? 92 : 66, unit:'%'},
    spacing: {min:0, max:() => 40, default:rem => .5 * rem, unit:'px'},
    details: {min:100, max:() => Math.max(100, Math.min(480, Math.floor(innerHeight * .32), Math.floor(blockBudget() * .55))), default:() => Math.min(260, innerHeight * .32), unit:'px'},
    reply: {min:52, max:() => Math.max(52, Math.min(300, Math.floor(innerHeight * .25), Math.floor(blockBudget() * .45))), default:rem => 4.3 * rem + 2, unit:'px'},
  };
  // Only accept finite numbers from this schema; ignore stale or damaged storage.
  saved = Object.fromEntries(Object.entries(saved).filter(([key,value]) => Object.hasOwn(specs,key) && typeof value === 'number' && Number.isFinite(value)).map(([key,value]) => [key, Math.max(specs[key].min, Math.min(key === 'bubble' ? 100 : key === 'spacing' ? 40 : key === 'rows' ? 200 : key === 'sidebar' ? 680 : 480, value))]));
  const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 17;
  function valueFor(key) {
    const spec = specs[key], value = saved[key] ?? spec.default(rem());
    return Math.round(Math.max(spec.min, Math.min(spec.max(), value)));
  }
  const grips = {sidebar:document.getElementById('inboxColumnGrip'), details:document.getElementById('inboxDetailsGrip'), reply:document.getElementById('inboxReplyGrip')};
  function render() {
    if (!panel.isConnected) return;
    for (const [key,spec] of Object.entries(specs)) {
      const value = valueFor(key), range = document.getElementById('layout-' + key), number = document.getElementById('layout-' + key + '-value');
      // Keep the default column in sync with zoom while leaving room for chat.
      // Other unedited settings retain their original responsive defaults.
      if (key in saved || key === 'sidebar') root.style.setProperty('--inbox-' + key, value + spec.unit); else root.style.removeProperty('--inbox-' + key);
      for (const input of [range,number]) {
        input.min = spec.min; input.max = spec.max(); input.step = 1; input.disabled = key === 'sidebar' && mobile.matches;
        if (input !== document.activeElement || input.type === 'range') input.value = value;
      }
      if (grips[key]) {
        grips[key].setAttribute('aria-valuemin', spec.min);
        grips[key].setAttribute('aria-valuemax', spec.max());
        grips[key].setAttribute('aria-valuenow', value);
        grips[key].setAttribute('aria-valuetext', value + ' pixels');
      }
    }
    root.style.setProperty('--inbox-details-limit', specs.details.max() + 'px');
    root.style.setProperty('--inbox-reply-limit', specs.reply.max() + 'px');
    document.getElementById('layout-rows-hint').textContent = 'Minimum height; text stays fully visible.';
    document.getElementById('layout-bubble-hint').textContent = 'Maximum width; short messages stay compact.';
    document.getElementById('layout-sidebar-hint').textContent = mobile.matches ? 'On phones, the list and chat each use the full width.' : '';
    for (const key of ['details','reply']) document.getElementById('layout-' + key + '-hint').textContent = 'Up to ' + specs[key].max() + ' px in this window.';
  }
  function persist() {
    const status = document.getElementById('layoutSaveStatus');
    try { localStorage.setItem(KEY, JSON.stringify(saved)); status.textContent = 'Saved on this browser'; }
    catch { status.textContent = 'Applied for this visit; browser storage is unavailable.'; }
  }
  function change(key,value,save = true) {
    if (!Number.isFinite(value)) return;
    saved[key] = Math.round(Math.max(specs[key].min, Math.min(specs[key].max(), value)));
    render(); if (save) persist();
  }
  for (const key of Object.keys(specs)) {
    const range = document.getElementById('layout-' + key), number = document.getElementById('layout-' + key + '-value');
    range.addEventListener('input', () => change(key,range.valueAsNumber));
    number.addEventListener('input', () => { if (number.valueAsNumber >= specs[key].min && number.valueAsNumber <= specs[key].max()) change(key,number.valueAsNumber); });
    number.addEventListener('change', () => { if (Number.isFinite(number.valueAsNumber)) change(key,number.valueAsNumber); number.value = valueFor(key); });
    number.addEventListener('blur', () => { number.value = valueFor(key); });
  }
  function reset(key) { if (key) delete saved[key]; else saved = {}; render(); persist(); }
  document.getElementById('resetInboxLayout').addEventListener('click', () => reset());
  function closePanel(focus = false) { panel.open = false; if (focus) panel.querySelector('summary').focus(); }
  document.getElementById('closeInboxLayout').addEventListener('click', () => closePanel(true));
  document.addEventListener('pointerdown', event => { if (panel.open && !panel.contains(event.target)) closePanel(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && panel.open) { event.preventDefault(); closePanel(true); } });
  panel.addEventListener('focusout', () => setTimeout(() => { if (panel.open && !panel.contains(document.activeElement)) closePanel(); }, 0));
  panel.addEventListener('toggle', () => { if (panel.open) render(); });

  let drag = null;
  function stopDrag(event) {
    if (!drag || (event?.pointerId != null && event.pointerId !== drag.id)) return;
    const {grip,id} = drag; drag = null;
    if (grip.hasPointerCapture(id)) grip.releasePointerCapture(id);
    root.classList.remove('inbox-resizing'); root.style.removeProperty('--inbox-resize-cursor'); persist();
  }
  for (const [key,grip] of Object.entries(grips)) {
    grip.addEventListener('pointerdown', event => {
      if (event.button !== 0 || (key === 'sidebar' && mobile.matches)) return;
      event.preventDefault(); closePanel();
      const target = document.getElementById(key === 'sidebar' ? 'sidebar' : key === 'details' ? 'customerDetails' : 'reply');
      const rect = target.getBoundingClientRect();
      drag = {key,grip,id:event.pointerId,start:key === 'sidebar' ? event.clientX : event.clientY,size:key === 'sidebar' ? rect.width : rect.height};
      grip.setPointerCapture(event.pointerId); grip.focus(); root.classList.add('inbox-resizing');
      root.style.setProperty('--inbox-resize-cursor', key === 'sidebar' ? 'col-resize' : 'row-resize');
    });
    grip.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId || drag.grip !== grip) return;
      const delta = (key === 'sidebar' ? event.clientX : event.clientY) - drag.start;
      change(key, drag.size + delta * (key === 'reply' ? -1 : 1), false);
    });
    grip.addEventListener('pointerup', stopDrag);
    grip.addEventListener('pointercancel', stopDrag);
    grip.addEventListener('lostpointercapture', stopDrag);
    grip.addEventListener('dblclick', () => reset(key));
    grip.addEventListener('keydown', event => {
      const positive = key === 'sidebar' ? 'ArrowRight' : key === 'reply' ? 'ArrowUp' : 'ArrowDown';
      const negative = key === 'sidebar' ? 'ArrowLeft' : key === 'reply' ? 'ArrowDown' : 'ArrowUp';
      if (![positive,negative,'Home','End'].includes(event.key)) return;
      event.preventDefault();
      change(key,event.key === 'Home' ? specs[key].min : event.key === 'End' ? specs[key].max() : valueFor(key) + (event.key === positive ? 1 : -1) * (event.shiftKey ? 30 : 10));
    });
  }
  window.addEventListener('blur', () => stopDrag());
  window.addEventListener('resize', () => { stopDrag(); render(); });
  new MutationObserver(render).observe(document.documentElement,{attributes:true,attributeFilter:['style']});
  let frame;
  const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(render); });
  for (const selector of ['#threadBody','.thead','.history-status','#chatSummary']) { const node=document.querySelector(selector); if(node)observer.observe(node); }
  document.getElementById('customerDetails').addEventListener('toggle', render);
  render();
})();
