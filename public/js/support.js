/* Ink & Chai support desk (/support/).
 * Raise a ticket (order id mandatory), attach evidence, check a ticket, reply,
 * reopen. Talks only to /.netlify/functions/support-ticket. Every piece of
 * customer text is inserted with textContent. */
(function () {
  'use strict';

  var API = '/.netlify/functions/support-ticket';
  var MAX_FILES = 5;
  var LIMITS = { // keep in step with utils/support-ticket.js EVIDENCE_TYPES
    'image/jpeg': 10, 'image/png': 10, 'image/webp': 10, 'image/heic': 12,
    'video/mp4': 40, 'video/quicktime': 40, 'video/webm': 40, 'application/pdf': 10
  };
  var BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heic', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', pdf: 'application/pdf' };

  function $(id) { return document.getElementById(id); }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {} return null; }

  // ── helpers ──────────────────────────────────────────────────────────────
  function post(payload) {
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, data: d }; }); })
      .catch(function () { return { status: 0, data: { ok: false, error: 'No connection. Please check your internet and try again.' } }; });
  }

  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
  }

  function fileType(file) {
    var t = String(file.type || '').toLowerCase().split(';')[0];
    if (LIMITS[t]) return t;
    var m = /\.([a-z0-9]+)$/i.exec(file.name || '');
    return (m && BY_EXT[m[1].toLowerCase()]) || t;
  }

  function size(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  function showErr(el, msg, field) {
    el.textContent = msg || '';
    el.classList.toggle('show', !!msg);
    document.querySelectorAll('.sp .invalid').forEach(function (n) { n.classList.remove('invalid'); });
    if (field && $(field)) { $(field).classList.add('invalid'); $(field).focus(); }
    else if (msg) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // Phones produce 4-8 MB photos; a ~1600px JPEG is plenty to judge damage and
  // uploads in a second on mobile data.
  function squeeze(file, type) {
    if (!/^image\/(jpeg|png|webp)$/.test(type) || file.size < 1.5 * 1048576 || !window.createImageBitmap) return Promise.resolve({ blob: file, name: file.name, type: type });
    return createImageBitmap(file).then(function (bmp) {
      var scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
      var c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return new Promise(function (res) {
        c.toBlob(function (b) {
          if (b && b.size < file.size) res({ blob: b, name: file.name.replace(/\.[^.]+$/, '') + '.jpg', type: 'image/jpeg' });
          else res({ blob: file, name: file.name, type: type });
        }, 'image/jpeg', 0.85);
      });
    }).catch(function () { return { blob: file, name: file.name, type: type }; });
  }

  // ── evidence picker (shared by the new-ticket and reply forms) ───────────
  function Picker(input, list) {
    var self = { files: [] };
    function paint() {
      list.textContent = '';
      self.files.forEach(function (f, i) {
        var li = document.createElement('li');
        if (/^image\//.test(f.type) && f.type !== 'image/heic') {
          var im = document.createElement('img'); im.alt = ''; im.src = URL.createObjectURL(f.file); li.appendChild(im);
        } else { var ic = document.createElement('span'); ic.textContent = /^video\//.test(f.type) ? '🎬' : '📄'; li.appendChild(ic); }
        var nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = f.file.name; li.appendChild(nm);
        var sz = document.createElement('span'); sz.className = 'sz'; sz.textContent = size(f.file.size); li.appendChild(sz);
        var rm = document.createElement('button'); rm.type = 'button'; rm.setAttribute('aria-label', 'Remove ' + f.file.name); rm.textContent = '×';
        rm.addEventListener('click', function () { self.files.splice(i, 1); paint(); });
        li.appendChild(rm);
        list.appendChild(li);
      });
    }
    input.addEventListener('change', function () {
      var problem = '';
      Array.prototype.forEach.call(input.files, function (file) {
        var type = fileType(file);
        if (self.files.length >= MAX_FILES) { problem = 'You can attach up to ' + MAX_FILES + ' files.'; return; }
        if (!LIMITS[type]) { problem = '"' + file.name + '" is not a photo, video or PDF.'; return; }
        if (file.size > LIMITS[type] * 1048576 && !/^image\//.test(type)) { problem = '"' + file.name + '" is over the ' + LIMITS[type] + ' MB limit.'; return; }
        self.files.push({ file: file, type: type });
      });
      input.value = '';
      paint();
      if (problem) self.onProblem && self.onProblem(problem);
    });
    self.clear = function () { self.files = []; paint(); };
    // Compress, then describe: what the server is told and what is PUT.
    self.prepare = function () {
      return Promise.all(self.files.map(function (f) { return squeeze(f.file, f.type); })).then(function (out) {
        return out.map(function (o) { return { blob: o.blob, meta: { name: o.name, type: o.type, size: o.blob.size } }; });
      });
    };
    return self;
  }

  // After compression: anything still over its limit is refused here, kindly.
  function tooBig(prepared) {
    for (var i = 0; i < prepared.length; i++) {
      var m = prepared[i].meta, cap = (LIMITS[m.type] || 0) * 1048576;
      if (m.size > cap) return '"' + m.name + '" is ' + size(m.size) + ' — the limit is ' + Math.round(cap / 1048576) + ' MB. Please choose a smaller file.';
    }
    return '';
  }

  // PUT each file to its presigned URL, then tell the server which landed.
  function uploadAll(prepared, uploads, ticketNo, contact, onProgress) {
    var done = [], failed = 0, chain = Promise.resolve();
    uploads.forEach(function (u, i) {
      chain = chain.then(function () {
        onProgress('Uploading file ' + (i + 1) + ' of ' + uploads.length + '…');
        return fetch(u.upload_url, { method: 'PUT', headers: { 'Content-Type': u.type }, body: prepared[i].blob })
          .then(function (r) { if (r.ok) done.push({ key: u.key, name: u.name, type: u.type }); else failed++; })
          .catch(function () { failed++; });
      });
    });
    return chain.then(function () {
      if (!done.length) return { attached: 0, failed: failed };
      return post({ action: 'attach', ticket_no: ticketNo, contact: contact, files: done }).then(function (r) {
        if (r.status === 200 && r.data.ok) return { attached: r.data.attached, failed: failed + (r.data.rejected || []).length };
        return { attached: 0, failed: failed + done.length, error: r.data.error };
      });
    });
  }

  // ── tabs ─────────────────────────────────────────────────────────────────
  function showTab(which) {
    var isNew = which === 'new';
    $('spNew').hidden = !isNew; $('spTrack').hidden = isNew;
    $('spTabNew').setAttribute('aria-selected', String(isNew));
    $('spTabTrack').setAttribute('aria-selected', String(!isNew));
    if (!isNew) paintRecent();
  }
  $('spTabNew').addEventListener('click', function () { showTab('new'); });
  $('spTabTrack').addEventListener('click', function () { showTab('track'); });

  // ── raise a ticket ───────────────────────────────────────────────────────
  var picker = Picker($('spFile'), $('spFiles'));
  picker.onProblem = function (m) { showErr($('spErr'), m); };

  $('spMsg').addEventListener('input', function () { $('spCount').textContent = $('spMsg').value.length + ' / 3000'; });

  $('spForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = $('spErr'); showErr(err, '');
    var order = $('spOrder').value.trim(), contact = $('spContact').value.trim(), cat = $('spCat').value, msg = $('spMsg').value.trim();
    if (!order) return showErr(err, 'Please enter your order ID — we cannot open a ticket without it. You will find it in your order confirmation email.', 'spOrder');
    if (!contact) return showErr(err, 'Please enter the email or phone number you used on this order.', 'spContact');
    if (!cat) return showErr(err, 'Please choose what the problem is about.', 'spCat');
    if (msg.length < 20) return showErr(err, 'Please describe the problem in a little more detail (at least 20 characters) so we can fix it the first time.', 'spMsg');

    var btn = $('spSubmit'), status = $('spStatus');
    btn.disabled = true; status.textContent = 'Opening your ticket…';
    picker.prepare().then(function (prepared) {
      var big = tooBig(prepared);
      if (big) { btn.disabled = false; status.textContent = ''; return showErr(err, big); }
      return post({ action: 'create', order_id: order, contact: contact, category: cat, message: msg, files: prepared.map(function (p) { return p.meta; }), website: $('spHp').value })
        .then(function (r) {
          if (r.status !== 200 || !r.data.ok) {
            btn.disabled = false; status.textContent = '';
            var field = ({ order_id: 'spOrder', contact: 'spContact', category: 'spCat', message: 'spMsg' })[r.data.field];
            if (r.status === 409 && r.data.existing_ticket) {
              showErr(err, r.data.error);
              var go = document.createElement('button'); go.type = 'button'; go.className = 'sp-link'; go.textContent = ' Open ' + r.data.existing_ticket;
              go.addEventListener('click', function () { $('spTno').value = r.data.existing_ticket; $('spTcontact').value = contact; showTab('track'); lookup(); });
              err.appendChild(go);
              return;
            }
            return showErr(err, r.data.error || 'Something went wrong. Please try again.', field);
          }
          var no = r.data.ticket_no, warn = r.data.evidence_error || '';
          var uploads = r.data.uploads || [];
          var after = uploads.length ? uploadAll(prepared, uploads, no, contact, function (t) { status.textContent = t; }) : Promise.resolve(null);
          return after.then(function (up) {
            if (up && up.failed) warn = (warn ? warn + ' ' : '') + (up.attached ? 'Some of your files could not be uploaded' : 'Your files could not be uploaded') + ' — your ticket is open, and you can add them from “Check a ticket”, or WhatsApp them to us quoting ' + no + '.';
            finish(no, contact, order, warn);
          });
        });
    });
  });

  function finish(no, contact, order, warn) {
    store('iac_sp_contact', contact); store('iac_sp_order', order); remember(no);
    $('spForm').hidden = true;
    $('spDoneNo').textContent = no;
    var w = $('spDoneWarn'); w.hidden = !warn; w.textContent = warn || '';
    var done = $('spDone'); done.hidden = false; done.focus();
    $('spDoneView').onclick = function () { $('spTno').value = no; $('spTcontact').value = contact; showTab('track'); lookup(); };
    $('spCopy').onclick = function () {
      var b = $('spCopy');
      (navigator.clipboard ? navigator.clipboard.writeText(no) : Promise.reject()).then(function () { b.textContent = 'Copied'; }, function () { b.textContent = 'Select & copy'; });
    };
    try { if (window.gtag) window.gtag('event', 'support_ticket_created'); } catch (e) {}
  }

  // ── remembered tickets (this browser only) ───────────────────────────────
  function remember(no) {
    var list = []; try { list = JSON.parse(store('iac_sp_tickets') || '[]'); } catch (e) {}
    list = [no].concat(list.filter(function (x) { return x !== no; })).slice(0, 5);
    store('iac_sp_tickets', JSON.stringify(list));
  }
  function paintRecent() {
    var list = []; try { list = JSON.parse(store('iac_sp_tickets') || '[]'); } catch (e) {}
    var box = $('spRecent'); box.textContent = '';
    box.hidden = !list.length;
    if (!list.length) return;
    box.appendChild(document.createTextNode('Your recent tickets on this device: '));
    list.forEach(function (no) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = no;
      b.addEventListener('click', function () { $('spTno').value = no; if (!$('spTcontact').value) $('spTcontact').value = store('iac_sp_contact') || ''; if ($('spTcontact').value) lookup(); else $('spTcontact').focus(); });
      box.appendChild(b);
    });
  }

  // ── check a ticket ───────────────────────────────────────────────────────
  var currentNo = '', currentContact = '';
  var replyPicker = null;

  $('spLookup').addEventListener('submit', function (e) { e.preventDefault(); lookup(); });
  $('spLost').addEventListener('click', function () { $('spFind').hidden = !$('spFind').hidden; if (!$('spFind').hidden) $('spForder').focus(); });

  $('spFind').addEventListener('submit', function (e) {
    e.preventDefault();
    var out = $('spFindOut'); out.textContent = 'Looking…';
    post({ action: 'find', order_id: $('spForder').value.trim(), contact: $('spTcontact').value.trim() }).then(function (r) {
      out.textContent = '';
      if (r.status !== 200 || !r.data.ok) { out.textContent = r.data.error || 'Not found.'; return; }
      r.data.tickets.forEach(function (t) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'sp-link'; b.style.display = 'block'; b.style.marginTop = '.4rem';
        b.textContent = t.ticket_no + ' · ' + (t.category_label || '') + ' · ' + t.status_label;
        b.addEventListener('click', function () { $('spTno').value = t.ticket_no; lookup(); });
        out.appendChild(b);
      });
    });
  });

  function lookup() {
    var err = $('spTerr'); showErr(err, '');
    var no = $('spTno').value.trim(), contact = $('spTcontact').value.trim();
    if (!no) return showErr(err, 'Please enter your ticket number, like TKT-AB12CD.', 'spTno');
    if (!contact) return showErr(err, 'Please enter the email or phone used on the order.', 'spTcontact');
    var btn = $('spTgo'); btn.disabled = true;
    return post({ action: 'lookup', ticket_no: no, contact: contact }).then(function (r) {
      btn.disabled = false;
      if (r.status !== 200 || !r.data.ok) { $('spTicket').hidden = true; return showErr(err, r.data.error || 'Could not find that ticket.'); }
      currentNo = r.data.ticket.ticket_no; currentContact = contact;
      store('iac_sp_contact', contact); remember(currentNo);
      renderTicket(r.data.ticket);
    });
  }

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  function renderTicket(t) {
    var box = $('spTicket'); box.textContent = ''; box.hidden = false;
    var head = el('div'); head.style.cssText = 'display:flex;justify-content:space-between;gap:.8rem;flex-wrap:wrap;align-items:center';
    head.appendChild(el('h2', null, t.ticket_no));
    head.appendChild(el('span', 'sp-badge ' + t.status, t.status_label));
    box.appendChild(head);
    var meta = el('div', 'sp-meta');
    [t.category_label, 'Order ' + t.order_id, 'Opened ' + when(t.created_at)].forEach(function (s) { meta.appendChild(el('span', null, s)); });
    box.appendChild(meta);

    var sla = el('div', 'sp-sla');
    if (t.status === 'closed') { sla.className += ' done'; sla.textContent = 'Resolved' + (t.closed_at ? ' on ' + when(t.closed_at) : '') + '.'; }
    else if (t.status === 'waiting_customer') sla.textContent = 'We are waiting for your reply. Add it below and we will pick this straight back up.';
    else if (t.delayed) { sla.className += ' late'; sla.textContent = 'This is taking longer than we promised, and we are sorry. It is still being worked on and has been flagged to the owner — we will update you as soon as it is resolved.'; }
    else sla.textContent = 'We aim to resolve this within 24–48 hours of opening — by ' + when(t.due_at) + '. You will hear from us by email.';
    box.appendChild(sla);

    if (t.status === 'closed' && t.resolution) {
      box.appendChild(el('div', null, 'How it was resolved')).style.cssText = 'font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;color:var(--sp-muted);margin-bottom:.35rem';
      box.appendChild(el('div', 'sp-resolution', t.resolution));
    }

    var tl = el('ol', 'sp-tl');
    (t.timeline || []).forEach(function (e) {
      var li = el('li', e.actor);
      var who = el('div', 'who');
      var name = e.actor === 'customer' ? 'You' : e.actor === 'staff' ? 'Ink & Chai support' : 'Update';
      var b = el('b', null, name); who.appendChild(b); who.appendChild(document.createTextNode(' · ' + when(e.at)));
      li.appendChild(who);
      if (e.body) li.appendChild(el('div', 'txt', e.kind === 'created' ? e.body : e.body));
      if (e.attachments && e.attachments.length) li.appendChild(el('div', 'att', '📎 ' + e.attachments.map(function (a) { return a.name; }).join(', ')));
      tl.appendChild(li);
    });
    box.appendChild(tl);

    if (t.can_reply) {
      var f = el('form'); f.noValidate = true;
      var field = el('div', 'sp-field');
      var lab = el('label', null, t.status === 'closed' ? 'Not fixed? Reopen with a message' : 'Add a message');
      lab.setAttribute('for', 'spReplyMsg');
      var ta = el('textarea'); ta.id = 'spReplyMsg'; ta.maxLength = 3000; ta.placeholder = 'Add details, answer our question, or tell us it still is not working.';
      field.appendChild(lab); field.appendChild(ta); f.appendChild(field);
      var drop = el('div', 'sp-drop'); var inp = el('input'); inp.type = 'file'; inp.multiple = true; inp.accept = 'image/*,video/mp4,video/quicktime,video/webm,application/pdf';
      var ul = el('ul', 'sp-files'); drop.appendChild(inp); drop.appendChild(ul); f.appendChild(drop);
      var rerr = el('div', 'sp-err'); rerr.style.marginTop = '.8rem'; f.appendChild(rerr);
      var send = el('button', 'sp-btn', t.status === 'closed' ? 'Reopen ticket' : 'Send'); send.type = 'submit'; send.style.marginTop = '1rem';
      f.appendChild(send);
      var st = el('div', 'sp-status'); f.appendChild(st);
      replyPicker = Picker(inp, ul); replyPicker.onProblem = function (m) { showErr(rerr, m); };
      f.addEventListener('submit', function (ev) {
        ev.preventDefault(); showErr(rerr, '');
        var text = ta.value.trim();
        if (text.length < 3) return showErr(rerr, 'Please write your message.');
        send.disabled = true; st.textContent = 'Sending…';
        replyPicker.prepare().then(function (prepared) {
          var big = tooBig(prepared);
          if (big) { send.disabled = false; st.textContent = ''; return showErr(rerr, big); }
          return post({ action: 'reply', ticket_no: currentNo, contact: currentContact, message: text, files: prepared.map(function (p) { return p.meta; }) }).then(function (r) {
            if (r.status !== 200 || !r.data.ok) { send.disabled = false; st.textContent = ''; return showErr(rerr, r.data.error || 'Could not send. Please try again.'); }
            var up = (r.data.uploads && r.data.uploads.length) ? uploadAll(prepared, r.data.uploads, currentNo, currentContact, function (m) { st.textContent = m; }) : Promise.resolve(null);
            return up.then(function () { $('spTno').value = currentNo; return lookup(); });
          });
        });
      });
      box.appendChild(f);
    } else if (t.status === 'closed') {
      box.appendChild(el('p', 'sp-help', 'This ticket was closed more than 7 days ago. If you still need help, please raise a new ticket and mention ' + t.ticket_no + '.'));
    }
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── deep links: /support/?order=IC-… from Track Order, /support/?t=TKT-… from emails ─
  (function init() {
    var q = new URLSearchParams(location.search);
    var order = q.get('order'), t = q.get('t');
    // Only an explicit ?order= prefills the order id: a remembered one could
    // quietly attach a new problem to last month's order.
    $('spOrder').value = (order || '').slice(0, 64);
    $('spContact').value = store('iac_sp_contact') || '';
    if (t) {
      showTab('track');
      $('spTno').value = t.slice(0, 20);
      $('spTcontact').value = store('iac_sp_contact') || '';
      if ($('spTcontact').value) lookup(); else $('spTcontact').focus();
    } else if (order) {
      $('spOrder').value = order.slice(0, 64);
      if (!$('spContact').value) $('spContact').focus(); else $('spCat').focus();
    }
  })();
})();
