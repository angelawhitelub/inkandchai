/* Actual purchases only. All display times come from the saved order timestamp. */
(function () {
  'use strict';
  if (window.__iacRecentPurchases) return;
  window.__iacRecentPurchases = true;
  const maxAge = 86400000;
  let purchases = [], offset = 0, fetchedAt = 0, stopped = false, busy = false;
  let hideTimer, showTimer, refreshTimer, toast;
  let seen = new Set();
  try {
    stopped = sessionStorage.getItem('iac_reader_activity_closed') === '1';
    seen = new Set(JSON.parse(sessionStorage.getItem('iac_purchase_seen') || '[]'));
  } catch (_) {}
  function hide() { if (toast) { toast.classList.remove('show'); toast.inert = true; toast.setAttribute('aria-hidden','true'); } }
  function stop() {
    stopped = true; purchases = []; hide();
    clearTimeout(hideTimer); clearTimeout(showTimer); clearTimeout(refreshTimer);
    try { sessionStorage.setItem('iac_reader_activity_closed','1'); } catch (_) {}
  }
  window.stopReaderActivity = stop;
  function valid(p, now) {
    const age = now - Date.parse(p.ordered_at);
    return typeof p.event_id === 'string' && /^[a-f0-9]{24}$/.test(p.event_id) &&
      typeof p.title === 'string' && typeof p.first_name === 'string' && age >= 0 && age <= maxAge &&
      /^\/product\/[a-z0-9-]+\/$/.test(p.url) && /^(https:\/\/|\/(?!\/))/.test(p.img);
  }
  function relative(time) {
    const minutes = Math.floor((Date.now()+offset-Date.parse(time))/60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes} minute${minutes===1?'':'s'} ago`;
    const hours = Math.floor(minutes/60);
    return `${hours} hour${hours===1?'':'s'} ago`;
  }
  function element(tag, className, text) {
    const el = document.createElement(tag); el.className = className;
    if (text) el.textContent = text;
    return el;
  }
  function show() {
    if (stopped || document.hidden || Date.now()-fetchedAt > 75000) return;
    const item = purchases.find(p => !seen.has(p.event_id) && valid(p,Date.now()+offset));
    if (!item) return;
    if (!toast) {
      toast = element('aside','reader-activity-toast'); toast.id = 'readerActivityToast';
      toast.setAttribute('aria-label','Recent purchase'); toast.setAttribute('aria-live','polite');
      document.body.appendChild(toast);
    }
    const img = element('img','reader-activity-img'); img.src = item.img; img.alt = '';
    const content = element('div','');
    const link = element('a','reader-activity-title',item.title); link.href = item.url;
    link.style.cssText = 'display:block;color:inherit;text-decoration:none';
    const time = element('time','reader-activity-time',relative(item.ordered_at));
    time.dateTime = item.ordered_at; time.title = new Date(item.ordered_at).toLocaleString();
    content.append(element('div','reader-activity-kicker',`${item.first_name} ordered`),link,time);
    const close = element('button','reader-activity-close','×'); close.type = 'button';
    close.setAttribute('aria-label','Hide recent purchases'); close.onclick = stop;
    toast.replaceChildren(img,content,close); toast.inert = false; toast.removeAttribute('aria-hidden');
    toast.classList.add('show');
    seen.add(item.event_id);
    try { sessionStorage.setItem('iac_purchase_seen',JSON.stringify([...seen].slice(-200))); } catch (_) {}
    clearTimeout(hideTimer); hideTimer = setTimeout(hide,7500);
  }
  async function refresh() {
    if (stopped || document.hidden || busy) return;
    busy = true;
    try {
      const response = await fetch('/.netlify/functions/recent-purchases',{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(8000)});
      if (!response.ok) throw new Error('Unavailable');
      const data = await response.json(), serverTime = Date.parse(data.generated_at);
      if (!Number.isFinite(serverTime) || !Array.isArray(data.purchases)) throw new Error('Invalid feed');
      offset = serverTime-Date.now(); fetchedAt = Date.now();
      purchases = data.purchases.filter(p => valid(p,serverTime));
      // Remove a displayed order if the refreshed feed no longer qualifies it.
      hide();
    } catch (_) { purchases = []; hide(); }
    finally { busy = false; }
  }
  async function poll() {
    await refresh();
    if (!stopped) { clearTimeout(refreshTimer); refreshTimer = setTimeout(poll,60000); }
  }
  function cycle() { show(); if (!stopped) showTimer = setTimeout(cycle,20000); }
  function start() {
    if (stopped) return;
    poll(); showTimer = setTimeout(cycle,5200);
  }
  document.addEventListener('visibilitychange',() => {
    if (document.hidden) hide();
    else if (!stopped) { clearTimeout(refreshTimer); poll(); }
  });
  document.addEventListener('click',event => {
    const target = event.target.closest('button,a');
    if (target && (/buyNowBook|addBookToCart|checkout/i.test(target.getAttribute('onclick')||'') || /\/checkout\/?/i.test(target.getAttribute('href')||''))) stop();
  },true);
  if (document.readyState === 'complete') start(); else window.addEventListener('load',start,{once:true});
})();
