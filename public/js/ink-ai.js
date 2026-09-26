/**
 * Ink AI — the floating assistant on inkandchai.in.
 *
 * A second button beside the WhatsApp one, for the questions a customer would
 * rather not start a WhatsApp thread over: is this genuine, what does shipping
 * cost, how do returns work, what happens to my money if I paid cash. WhatsApp
 * is still one tap away, and the bot hands over whenever it should.
 *
 * It opens with FAQ chips rather than a blank box, because a blank box is a
 * question nobody answers. Tapping a chip sends it as a message.
 *
 * Positioning: the WhatsApp button moves between corners across breakpoints and
 * is nudged again by the mobile nav and the product page's sticky buy bar, so
 * this measures .wa-float at open time and sits above it, rather than
 * hard-coding an offset that four media queries can each invalidate.
 *
 * Talks to /.netlify/functions/ink-ai, which has no order access by design --
 * see that file's header for why. Nothing here should ever start claiming
 * otherwise.
 */
(function () {
  'use strict';

  var API = '/.netlify/functions/ink-ai';
  var FEEDBACK_API = '/.netlify/functions/ink-ai-feedback';
  var RKEY = 'iac_ink_ai_rated';
  var WA = 'https://wa.me/917678400508';
  var KEY = 'iac_ink_ai_v1';

  var FAQS = [
    'Are your books original?',
    'How much is shipping?',
    'How do returns work?',
    'I paid cash — how do I get a refund?',
    'Can I cancel an order?',
    'Where is my order?',
    'Nobody attempted my delivery',
  ];

  var SKEY = 'iac_ink_ai_sid';
  function sessionId() {
    try {
      var v = sessionStorage.getItem(SKEY);
      if (!v) {
        v = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        sessionStorage.setItem(SKEY, v);
      }
      return v;
    } catch (e) { return ''; }
  }

  var built = false, open_ = false;
  var root, panel, log, input, sendBtn, fab, chips, rate;
  var history = [];
  var busy = false;

  var CSS = [
    '.ink-fab{position:fixed;right:22px;bottom:22px;z-index:251;display:flex;align-items:center;gap:0.45rem;',
      'padding:0.6rem 0.95rem;border:none;border-radius:999px;cursor:pointer;font:inherit;font-size:0.68rem;',
      'font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#141008;',
      'background:linear-gradient(135deg,#e2c46a,#c9a84c);box-shadow:0 6px 22px rgba(201,168,76,0.45);',
      'transition:transform .2s,box-shadow .2s,opacity .22s}',
    '.ink-fab:hover{transform:scale(1.05);box-shadow:0 8px 28px rgba(201,168,76,0.6)}',
    '.ink-fab[hidden]{display:none!important}',
    '@media(max-width:780px){.ink-fab{right:14px;font-size:0}',
      '.ink-fab{width:46px;height:46px;padding:0;justify-content:center}',
      '.ink-fab .ink-fab-i{font-size:1.25rem}}',
    '.ink-fab-i{font-size:0.95rem;line-height:1}',

    // The UA's [hidden]{display:none} is a bare-element rule, so every class
    // rule below that sets display beats it -- without this the panel stays in
    // the layout after close(), merely translated off-screen, and the FAQ chips
    // never actually hide.
    '.ink-panel[hidden],.ink-chips[hidden],.ink-back[hidden]{display:none!important}',

    '.ink-back{position:fixed;inset:0;background:rgba(0,0,0,0.5);opacity:0;transition:opacity .25s;z-index:2147482900}',
    '.ink-back.on{opacity:1}',
    '@media(min-width:760px){.ink-back{background:transparent;pointer-events:none}}',

    '.ink-panel{position:fixed;left:0;right:0;bottom:0;z-index:2147482901;display:flex;flex-direction:column;',
      'max-height:78vh;background:var(--bg2,#1c1916);color:var(--cream,#f0e8d8);',
      'border-top:1px solid var(--border,rgba(201,168,76,0.25));border-radius:18px 18px 0 0;',
      'box-shadow:0 -18px 50px rgba(0,0,0,0.5);transform:translateY(100%);',
      'transition:transform .3s cubic-bezier(.22,.8,.3,1)}',
    '.ink-panel.on{transform:translateY(0)}',
    '@media(min-width:760px){.ink-panel{left:auto;right:22px;bottom:22px;width:390px;max-height:min(620px,78vh);',
      'border-radius:16px;border:1px solid var(--border,rgba(201,168,76,0.25));',
      'transform:translateY(16px) scale(.98);opacity:0;transition:transform .22s,opacity .22s}',
      '.ink-panel.on{transform:none;opacity:1}}',
    '@media(prefers-reduced-motion:reduce){.ink-panel,.ink-back{transition:none}}',

    '.ink-head{display:flex;align-items:center;gap:0.6rem;padding:0.85rem 1rem;flex:none;',
      'border-bottom:1px solid var(--border,rgba(201,168,76,0.18))}',
    '.ink-head b{flex:1;font-size:0.82rem;font-weight:600;color:var(--gold,#c9a84c);letter-spacing:0.02em}',
    '.ink-head small{display:block;font-size:0.6rem;font-weight:400;color:var(--cream-dim,#a09080);',
      'letter-spacing:0.02em;text-transform:none}',
    '.ink-x{background:none;border:1px solid var(--border,rgba(201,168,76,0.3));color:inherit;width:28px;height:28px;',
      'border-radius:50%;cursor:pointer;font-size:0.85rem;line-height:1;flex:none}',
    '.ink-x:hover{background:rgba(201,168,76,0.12)}',

    '.ink-log{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0.9rem 1rem;',
      'font-size:0.78rem;line-height:1.7;display:flex;flex-direction:column;gap:0.6rem}',
    '.ink-msg{max-width:88%;padding:0.55rem 0.8rem;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}',
    '.ink-msg.bot{align-self:flex-start;background:rgba(201,168,76,0.09);border:1px solid rgba(201,168,76,0.16)}',
    '.ink-msg.me{align-self:flex-end;background:rgba(109,191,109,0.13);border:1px solid rgba(109,191,109,0.25)}',
    '.ink-msg a{color:var(--gold,#c9a84c)}',
    '.ink-msg.err{background:rgba(200,90,70,0.12);border-color:rgba(200,90,70,0.3)}',
    '.ink-dots span{display:inline-block;width:5px;height:5px;margin-right:3px;border-radius:50%;',
      'background:var(--gold,#c9a84c);animation:inkBlink 1.1s infinite}',
    '.ink-dots span:nth-child(2){animation-delay:.18s}.ink-dots span:nth-child(3){animation-delay:.36s}',
    '@keyframes inkBlink{0%,60%,100%{opacity:.25}30%{opacity:1}}',

    '.ink-chips{display:flex;flex-wrap:wrap;gap:0.35rem;padding:0 1rem 0.6rem;flex:none}',
    '.ink-chip{background:none;border:1px solid var(--border,rgba(201,168,76,0.3));border-radius:999px;',
      'padding:0.35rem 0.7rem;font:inherit;font-size:0.68rem;color:var(--gold,#c9a84c);cursor:pointer;',
      'text-align:left;line-height:1.4;text-transform:none;letter-spacing:normal;text-decoration:none}',
    '.ink-chip:hover{background:rgba(201,168,76,0.12)}',

    '.ink-foot{flex:none;display:flex;gap:0.45rem;padding:0.7rem 1rem calc(0.7rem + env(safe-area-inset-bottom,0px));',
      'border-top:1px solid var(--border,rgba(201,168,76,0.18))}',
    '.ink-foot input{flex:1;min-width:0;background:rgba(255,255,255,0.05);color:inherit;font:inherit;',
      'font-size:0.78rem;border:1px solid var(--border,rgba(201,168,76,0.25));border-radius:999px;padding:0.55rem 0.9rem}',
    '.ink-foot input:focus{outline:none;border-color:var(--gold,#c9a84c)}',
    '.ink-send{flex:none;width:38px;height:38px;border-radius:50%;border:none;cursor:pointer;',
      'background:linear-gradient(135deg,#e2c46a,#c9a84c);color:#141008;font-size:0.9rem}',
    '.ink-send:disabled{opacity:0.5;cursor:default}',
    '.ink-note{flex:none;padding:0 1rem 0.7rem;font-size:0.6rem;line-height:1.5;color:var(--cream-dim,#a09080);text-align:center}',
    '.ink-note a{color:var(--gold-dim,#b09a5e)}',

    // Star rating. Asked once per chat, only after Ink AI has actually answered
    // something -- a rating of a greeting measures nothing.
    '.ink-rate[hidden]{display:none!important}',
    '.ink-rate{flex:none;margin:0 1rem 0.6rem;padding:0.65rem 0.8rem;border-radius:12px;',
      'border:1px solid var(--border,rgba(201,168,76,0.22));background:rgba(201,168,76,0.06);font-size:0.74rem}',
    '.ink-rate-row{display:flex;align-items:center;justify-content:space-between;gap:0.6rem;flex-wrap:wrap}',
    '.ink-rate-q{font-weight:600}',
    '.ink-stars{display:flex;gap:2px}',
    '.ink-star{background:none;border:none;padding:0 2px;cursor:pointer;font-size:1.45rem;line-height:1;',
      'color:rgba(160,144,128,0.45);transition:color .12s,transform .12s;font-family:system-ui,sans-serif}',
    '.ink-star.on{color:#e3a72f}',
    '.ink-star:hover{transform:scale(1.15)}',
    '.ink-star:focus-visible{outline:2px solid #e3a72f;outline-offset:2px;border-radius:4px}',
    '.ink-rate textarea{display:block;width:100%;margin-top:0.55rem;min-height:58px;resize:vertical;font:inherit;',
      'font-size:0.76rem;color:inherit;background:rgba(255,255,255,0.05);border:1px solid var(--border,rgba(201,168,76,0.25));',
      'border-radius:10px;padding:0.5rem 0.65rem;box-sizing:border-box}',
    '.ink-rate textarea:focus{outline:none;border-color:var(--gold,#c9a84c)}',
    '.ink-rate-actions{display:flex;justify-content:flex-end;gap:0.4rem;margin-top:0.45rem}',
    '.ink-rate-actions button{font:inherit;font-size:0.72rem;font-weight:600;border-radius:999px;padding:0.4rem 0.9rem;cursor:pointer}',
    '.ink-rate-skip{background:none;border:1px solid var(--border,rgba(201,168,76,0.3));color:inherit}',
    '.ink-rate-send{border:none;background:linear-gradient(135deg,#e2c46a,#c9a84c);color:#141008}',
    '.ink-rate-thanks{text-align:center;font-weight:600}',
    'html[data-theme="light"] .ink-rate{background:#fff5e2}',
    'html[data-theme="light"] .ink-rate textarea{background:#fff}',

    'html[data-theme="light"] .ink-panel{background:#fffaf0;color:#2a2018}',
    'html[data-theme="light"] .ink-log{color:#3a2e22}',
    'html[data-theme="light"] .ink-foot input{background:rgba(0,0,0,0.04)}',
  ].join('');

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /** Escape first, then linkify — so a URL in the reply is clickable and
   *  nothing else in it is ever treated as markup. */
  function render(text) {
    return esc(text)
      .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(inkandchai\.in\/[^\s<)]+)/g, '$1<a href="https://$2" target="_blank" rel="noopener">$2</a>');
  }

  function bubble(role, text, cls) {
    var d = document.createElement('div');
    d.className = 'ink-msg ' + (role === 'user' ? 'me' : 'bot') + (cls ? ' ' + cls : '');
    d.innerHTML = render(text);
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  function showChips(list) {
    chips.innerHTML = '';
    list.forEach(function (q) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ink-chip';
      b.textContent = q;
      b.addEventListener('click', function () { send(q); });
      chips.appendChild(b);
    });
    chips.hidden = !list.length;
  }

  /**
   * Candidate titles from whatever book list this page already carries, so a
   * "do you have X?" gets a real price and link. Pages without a list (the
   * checkout, policy pages) simply send nothing.
   */
  function matchBooks(q) {
    var all = window.IAC_BOOKS || window.BOOKS_PRELOAD;
    if (!Array.isArray(all) || !all.length) return [];
    var words = q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter(function (w) { return w.length > 3; });
    if (!words.length) return [];
    var out = [];
    for (var i = 0; i < all.length && out.length < 5; i++) {
      var t = (all[i] && all[i].t ? String(all[i].t) : '').toLowerCase();
      if (!t) continue;
      var hit = words.every(function (w) { return t.indexOf(w) !== -1; });
      if (hit) out.push({ title: all[i].t, price: all[i].p || '', url: all[i].url || '' });
    }
    return out;
  }

  function escalateRow() {
    var d = document.createElement('div');
    d.className = 'ink-chips';
    d.style.cssText = 'padding:0 0 0.2rem;flex-direction:column;align-items:flex-start';
    d.innerHTML = '<a class="ink-chip" href="' + WA + '" target="_blank" rel="noopener">'
                + '\uD83D\uDCAC Send this to Ankit or Shila</a>'
                + '<span style="font-size:0.62rem;line-height:1.5;opacity:0.8">'
                + 'A human agent reads every query and replies within 48 hours.</span>';
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  // ── Star rating ────────────────────────────────────────────────────────
  function ratedState() {
    try { return JSON.parse(sessionStorage.getItem(RKEY) || 'null'); } catch (e) { return null; }
  }
  function setRatedState(v) {
    try { sessionStorage.setItem(RKEY, JSON.stringify(v)); } catch (e) { /* fine */ }
  }

  /** Fire-and-forget. A rating that fails to save must never show the customer an error. */
  function postFeedback(rating, comment) {
    try {
      fetch(FEEDBACK_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          session_id: sessionId(),
          rating: rating,
          comment: comment || '',
          page_url: location.pathname,
          turns: history.filter(function (m) { return m.role === 'user'; }).length,
        }),
      }).catch(function () { /* fine */ });
    } catch (e) { /* fine */ }
  }

  function paintStars(n) {
    rate.querySelectorAll('.ink-star').forEach(function (b, i) {
      b.classList.toggle('on', i < n);
      b.textContent = i < n ? '\u2605' : '\u2606';
    });
  }

  function thank() {
    rate.innerHTML = '<div class="ink-rate-thanks">Thank you \u2728 Your feedback helps Ink AI get better.</div>';
    setTimeout(function () { rate.hidden = true; }, 2600);
  }

  function askComment(n) {
    var low = n <= 3;
    var box = document.createElement('div');
    box.innerHTML =
      '<textarea maxlength="1000" placeholder="' + (low
        ? 'What went wrong? What should Ink AI have said? (optional)'
        : 'Anything we could do better? (optional)') + '" aria-label="Your feedback"></textarea>'
      + '<div class="ink-rate-actions">'
      +   '<button type="button" class="ink-rate-skip">Skip</button>'
      +   '<button type="button" class="ink-rate-send">Send feedback</button>'
      + '</div>';
    var old = rate.querySelector('.ink-rate-more');
    if (old) old.remove();
    box.className = 'ink-rate-more';
    rate.appendChild(box);
    var ta = box.querySelector('textarea');
    box.querySelector('.ink-rate-skip').addEventListener('click', function () {
      setRatedState({ rating: n, done: true });
      thank();
    });
    box.querySelector('.ink-rate-send').addEventListener('click', function () {
      var c = ta.value.trim();
      if (c) postFeedback(n, c);
      setRatedState({ rating: n, done: true });
      thank();
    });
    if (window.matchMedia('(min-width:760px)').matches) ta.focus();
    log.scrollTop = log.scrollHeight;
  }

  function maybeShowRate() {
    if (!rate) return;
    var st = ratedState();
    var answered = history.some(function (m) { return m.role === 'assistant'; });
    if (!answered || (st && st.done)) { rate.hidden = true; return; }
    if (!rate.hidden) return;
    rate.innerHTML =
      '<div class="ink-rate-row">'
      +   '<span class="ink-rate-q">How helpful was Ink AI?</span>'
      +   '<span class="ink-stars" role="radiogroup" aria-label="Rate Ink AI from 1 to 5 stars">'
      +     [1, 2, 3, 4, 5].map(function (i) {
              return '<button type="button" class="ink-star" role="radio" aria-checked="false" '
                + 'data-v="' + i + '" aria-label="' + i + ' star' + (i > 1 ? 's' : '') + '">\u2606</button>';
            }).join('')
      +   '</span>'
      + '</div>';
    var stars = rate.querySelectorAll('.ink-star');
    stars.forEach(function (b) {
      var v = Number(b.dataset.v);
      b.addEventListener('mouseenter', function () { paintStars(v); });
      b.addEventListener('focus', function () { paintStars(v); });
      b.addEventListener('click', function () {
        stars.forEach(function (x) { x.setAttribute('aria-checked', String(Number(x.dataset.v) === v)); });
        rate.dataset.v = String(v);
        paintStars(v);
        postFeedback(v, '');                 // the stars count even if they skip the comment
        setRatedState({ rating: v, done: false });
        askComment(v);
      });
    });
    rate.querySelector('.ink-stars').addEventListener('mouseleave', function () {
      paintStars(Number(rate.dataset.v || 0));
    });
    if (st && st.rating) { rate.dataset.v = String(st.rating); paintStars(st.rating); askComment(st.rating); }
    rate.hidden = false;
  }

  async function send(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    busy = true;
    sendBtn.disabled = true;
    input.value = '';
    chips.hidden = true;

    bubble('user', text);
    history.push({ role: 'user', content: text });

    var thinking = bubble('assistant', '');
    thinking.innerHTML = '<span class="ink-dots"><span></span><span></span><span></span></span>';

    try {
      var res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history.slice(-14),
          session_id: sessionId(),
          page: { url: location.pathname, title: document.title },
          books: matchBooks(text),
        }),
      });
      var data = await res.json().catch(function () { return {}; });
      var reply = data.reply
        || 'Sorry — something went wrong at our end. Our team is on WhatsApp and replies 7 days a week.';
      thinking.innerHTML = render(reply);
      thinking.classList.toggle('err', !res.ok && !data.reply);
      if (res.ok) history.push({ role: 'assistant', content: reply });
      if (data.escalate || !res.ok) escalateRow();
      save();
      maybeShowRate();
    } catch (e) {
      thinking.className = 'ink-msg bot err';
      thinking.innerHTML = render('I could not reach our server. Please check your connection, or message us on WhatsApp.');
      escalateRow();
    } finally {
      busy = false;
      sendBtn.disabled = false;
      if (!history.length) showChips(FAQS);
    }
  }

  // Per-viewer convenience only: keeps the thread if they navigate to another
  // page mid-conversation. Never read back by us, and every access is guarded
  // because a private window can throw on the accessor itself.
  function save() {
    try { sessionStorage.setItem(KEY, JSON.stringify(history.slice(-14))); } catch (e) { /* fine */ }
  }
  function restore() {
    try {
      var v = JSON.parse(sessionStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  function build() {
    if (built) return;
    built = true;

    var back = document.createElement('div');
    back.className = 'ink-back';
    back.hidden = true;

    root = document.createElement('div');
    root.className = 'ink-panel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Ink AI assistant');
    root.hidden = true;
    root.innerHTML =
      '<div class="ink-head">'
      +   '<b>Ink AI<small>Ink &amp; Chai’s reading assistant</small></b>'
      +   '<button class="ink-x" type="button" aria-label="Close">✕</button>'
      + '</div>'
      + '<div class="ink-log" aria-live="polite"></div>'
      + '<div class="ink-rate" hidden></div>'
      + '<div class="ink-chips" hidden></div>'
      + '<div class="ink-foot">'
      +   '<input type="text" placeholder="Ask about a book, shipping, returns…" aria-label="Your question" maxlength="700"/>'
      +   '<button class="ink-send" type="button" aria-label="Send">➤</button>'
      + '</div>'
      + '<div class="ink-note">Ink AI can\u2019t see your order \u2014 track it '
      +   '<a href="/track/">here</a>. Anything it can\u2019t answer goes to Ankit or Shila, '
      +   'who reply within 48 hours.</div>';

    document.body.appendChild(back);
    document.body.appendChild(root);

    panel = root;
    log = root.querySelector('.ink-log');
    chips = root.querySelector('.ink-chips');
    rate = root.querySelector('.ink-rate');
    input = root.querySelector('.ink-foot input');
    sendBtn = root.querySelector('.ink-send');

    back.addEventListener('click', close);
    root.querySelector('.ink-x').addEventListener('click', close);
    sendBtn.addEventListener('click', function () { send(input.value); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(input.value); });
    root.__back = back;

    history = restore();
    if (history.length) {
      history.forEach(function (m) { bubble(m.role, m.content); });
      maybeShowRate();
    } else {
      bubble('assistant', 'Hi 👋 I’m Ink AI. Ask me anything about our books, '
        + 'delivery, payments or returns — or pick one below.');
      showChips(FAQS);
    }
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function openPanel() {
    build();
    open_ = true;
    panel.__back.hidden = false;
    panel.hidden = false;
    void panel.offsetHeight;
    panel.__back.classList.add('on');
    panel.classList.add('on');
    fab.hidden = true;
    document.addEventListener('keydown', onKey);
    if (window.matchMedia('(min-width:760px)').matches) input.focus();
    log.scrollTop = log.scrollHeight;
  }

  function close() {
    if (!built || !open_) return;
    open_ = false;
    panel.__back.classList.remove('on');
    panel.classList.remove('on');
    document.removeEventListener('keydown', onKey);
    setTimeout(function () { panel.__back.hidden = true; panel.hidden = true; }, 300);
    fab.hidden = false;
    fab.focus();
  }

  /**
   * Keep clear of whatever else is pinned to the bottom of this page. Three
   * things can be: the WhatsApp button (bottom-left on a wide window,
   * bottom-right under 780px), the mobile nav, and the product page's sticky
   * Add-to-Cart bar, which is full-width. Rather than encode four breakpoints'
   * worth of offsets, measure them and sit above the tallest one that actually
   * sits under this button.
   *
   * offsetParent is null for every position:fixed element, so visibility has to
   * be read off the rect.
   */
  var OBSTACLES = '.wa-float, .actions, .mob-nav';

  function position() {
    fab.style.bottom = '';
    var f = fab.getBoundingClientRect();
    var lift = 0;
    document.querySelectorAll(OBSTACLES).forEach(function (el) {
      if (el === fab || fab.contains(el)) return;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      if (getComputedStyle(el).position !== 'fixed') return;      // in-flow copies don't count
      if (r.bottom < window.innerHeight - 200) return;            // not pinned to the bottom
      if (r.right < f.left - 8 || r.left > f.right + 8) return;   // different column
      lift = Math.max(lift, window.innerHeight - r.top + 12);
    });
    if (lift) fab.style.bottom = Math.round(lift) + 'px';
  }

  function init() {
    var style = document.createElement('style');
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);

    fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'ink-fab';
    fab.setAttribute('aria-haspopup', 'dialog');
    fab.setAttribute('title', 'Ask Ink AI');
    fab.setAttribute('aria-label', 'Ask Ink AI');
    fab.innerHTML = '<span class="ink-fab-i" aria-hidden="true">✨</span><span>Ink AI</span>';
    fab.addEventListener('click', openPanel);
    document.body.appendChild(fab);

    position();
    window.addEventListener('resize', position);
    window.addEventListener('orientationchange', position);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.InkAI = { open: openPanel, close: close };
})();
