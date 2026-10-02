'use strict';

/**
 * Customer support tickets: everything that can be decided without a database.
 *
 * Shared by support-ticket (the public endpoint), admin-support-tickets (the
 * admin panel's) and support-ticket-sla-scheduled (the hourly watchdog), so the
 * deadlines, the evidence rules and the wording of every email live in one
 * place and are unit tested.
 *
 * THE PROMISE
 * A ticket is answered within 24 hours (respond_by) and resolved within 48
 * (due_at). Past due_at the customer is told, in so many words, that it is
 * taking longer than expected -- and again every further 48 hours, up to three
 * notices -- so nobody is left wondering. A ticket waiting on the CUSTOMER is
 * not late, so the clock does not run there. Closing it requires a resolution
 * note, which is what the customer is sent.
 */

const crypto = require('crypto');

const OWNER_EMAIL_DEFAULT = 'asfkhn234@gmail.com';
const SITE = 'https://inkandchai.in';

const HOUR = 3600 * 1000;
const RESPOND_HOURS = 24;
const RESOLVE_HOURS = 48;
const DELAY_REPEAT_HOURS = 48;
const MAX_DELAY_NOTICES = 3;
const REOPEN_WINDOW_DAYS = 7;
const MAX_OPEN_PER_ORDER_CATEGORY = 1;

const MIN_MESSAGE = 20;
const MAX_MESSAGE = 3000;
const MAX_FILES_PER_SUBMISSION = 5;
const MAX_FILES_PER_TICKET = 12;

const CATEGORIES = [
  { id: 'damaged_wrong', label: 'Damaged, defective or wrong item', priority: 'high' },
  { id: 'missing_item', label: 'Item missing from the parcel', priority: 'high' },
  { id: 'not_received', label: 'Order not delivered / shipping delay', priority: 'high' },
  { id: 'refund_payment', label: 'Refund or payment issue', priority: 'high' },
  { id: 'return_replace', label: 'Replacement (defective, wrong or missing book)', priority: 'normal' },
  { id: 'change_cancel', label: 'Change address or cancel order', priority: 'normal' },
  { id: 'other', label: 'Something else', priority: 'normal' },
];
const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

const STATUSES = ['open', 'in_progress', 'waiting_customer', 'closed'];
const STATUS_LABEL = {
  open: 'Open',
  in_progress: 'In progress',
  waiting_customer: 'Waiting for your reply',
  closed: 'Closed',
};
// Statuses where the clock is running on us.
const ACTIVE = new Set(['open', 'in_progress']);

// What a customer may attach. The type is signed into the upload URL, so the
// stored object cannot claim to be anything else.
const EVIDENCE_TYPES = {
  'image/jpeg': { ext: 'jpg', maxBytes: 10 * 1024 * 1024 },
  'image/png': { ext: 'png', maxBytes: 10 * 1024 * 1024 },
  'image/webp': { ext: 'webp', maxBytes: 10 * 1024 * 1024 },
  'image/heic': { ext: 'heic', maxBytes: 12 * 1024 * 1024 },
  'video/mp4': { ext: 'mp4', maxBytes: 40 * 1024 * 1024 },
  'video/quicktime': { ext: 'mov', maxBytes: 40 * 1024 * 1024 },
  'video/webm': { ext: 'webm', maxBytes: 40 * 1024 * 1024 },
  'application/pdf': { ext: 'pdf', maxBytes: 10 * 1024 * 1024 },
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ownerEmail(env = process.env) {
  return String(env.SUPPORT_TICKET_EMAIL || OWNER_EMAIL_DEFAULT).trim();
}

// ── Identity ───────────────────────────────────────────────────────────────

const TICKET_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

function newTicketNo(bytes = crypto.randomBytes(6)) {
  let out = '';
  for (let i = 0; i < 6; i += 1) out += TICKET_ALPHABET[bytes[i] % TICKET_ALPHABET.length];
  return `TKT-${out}`;
}

function normTicketNo(value) {
  const s = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  const m = s.match(/^(?:TKT-?)?([A-Z0-9]{6})$/);
  return m ? `TKT-${m[1]}` : '';
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

/**
 * The same ownership rule as track-order and report-missing-books: the e-mail
 * on file, or the last ten digits of the phone on file.
 * @param {{customer_email?: string, customer_phone?: string}} record  an order or a ticket
 */
function contactMatches(record, contact) {
  const q = norm(contact);
  if (!q || !record) return false;
  if (record.customer_email && norm(record.customer_email) === q) return true;
  const digits = q.replace(/\D/g, '');
  const phone = String(record.customer_phone || '').replace(/\D/g, '');
  return digits.length >= 10 && phone.length >= 10 && phone.slice(-10) === digits.slice(-10);
}

/** Order ids are IC-… (or IC-R-/IC-CW-…); older ones are Razorpay's order_… */
function cleanOrderId(value) {
  return String(value || '').trim().replace(/\s+/g, '').slice(0, 64);
}

// ── Intake ─────────────────────────────────────────────────────────────────

/**
 * Validate a new-ticket submission. The order id is mandatory; so is the
 * e-mail/phone that proves it is the customer's order.
 * @returns {{ok: true, value: object} | {ok: false, error: string, field?: string}}
 */
function parseNewTicket(body = {}) {
  const orderId = cleanOrderId(body.order_id);
  if (!orderId) return { ok: false, field: 'order_id', error: 'Please enter your order ID — we cannot open a ticket without it. You will find it in your order confirmation email or on the Track Order page.' };
  const contact = String(body.contact || '').trim().slice(0, 200);
  if (!contact) return { ok: false, field: 'contact', error: 'Please enter the email or phone number you used on this order, so we know it is yours.' };
  const category = CATEGORY_BY_ID[String(body.category || '')];
  if (!category) return { ok: false, field: 'category', error: 'Please choose what the problem is about.' };
  const message = String(body.message || '').replace(/\r\n/g, '\n').trim();
  if (message.length < MIN_MESSAGE) return { ok: false, field: 'message', error: `Please describe the problem in a little more detail (at least ${MIN_MESSAGE} characters) so we can fix it the first time.` };
  if (message.length > MAX_MESSAGE) return { ok: false, field: 'message', error: `Please keep the description under ${MAX_MESSAGE} characters.` };
  const files = parseFileMetas(body.files);
  if (!files.ok) return { ok: false, field: 'files', error: files.error };
  return { ok: true, value: { orderId, contact, category, message, files: files.files } };
}

function parseFileMetas(list) {
  if (list == null) return { ok: true, files: [] };
  if (!Array.isArray(list)) return { ok: false, error: 'Attachments were not understood.' };
  if (list.length > MAX_FILES_PER_SUBMISSION) return { ok: false, error: `You can attach up to ${MAX_FILES_PER_SUBMISSION} files at a time.` };
  const files = [];
  for (const f of list) {
    const type = String((f && f.type) || '').toLowerCase().split(';')[0].trim();
    const spec = EVIDENCE_TYPES[type];
    const name = cleanFileName(f && f.name);
    const size = Number(f && f.size);
    if (!spec) return { ok: false, error: `"${name || 'A file'}" is not a supported type. Attach photos (JPG, PNG, WebP), a short video (MP4, MOV, WebM) or a PDF.` };
    if (!Number.isFinite(size) || size <= 0) return { ok: false, error: `"${name}" looks empty.` };
    if (size > spec.maxBytes) return { ok: false, error: `"${name}" is ${(size / 1048576).toFixed(1)} MB; the limit for this type is ${Math.round(spec.maxBytes / 1048576)} MB.` };
    files.push({ name, type, size: Math.floor(size) });
  }
  return { ok: true, files };
}

function cleanFileName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop().replace(/[^\w.\- ()]/g, '_').trim();
  return (base || 'file').slice(0, 80);
}

function evidenceKey(ticketNo, type, now = Date.now(), rand = crypto.randomBytes(5).toString('hex')) {
  const spec = EVIDENCE_TYPES[type];
  return `support/${ticketNo}/${now}-${rand}.${spec ? spec.ext : 'bin'}`;
}

/** Only a key minted for THIS ticket may be attached to it. */
function isEvidenceKeyFor(key, ticketNo) {
  if (!/^TKT-[A-Z0-9]{6}$/.test(String(ticketNo || ''))) return false;
  return new RegExp(`^support/${ticketNo}/\\d{10,}-[a-f0-9]{10}\\.[a-z0-9]{2,4}$`).test(String(key || ''));
}

function evidenceKind(type) {
  if (/^image\//.test(type)) return 'image';
  if (/^video\//.test(type)) return 'video';
  return 'file';
}

// ── Deadlines ──────────────────────────────────────────────────────────────

function slaDates(now = Date.now()) {
  return {
    respond_by: new Date(now + RESPOND_HOURS * HOUR).toISOString(),
    due_at: new Date(now + RESOLVE_HOURS * HOUR).toISOString(),
  };
}

const ms = (v) => { const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; };

/** Is a "taking longer than expected" notice owed now? */
function delayNoticeDue(ticket, now = Date.now()) {
  if (!ticket || !ACTIVE.has(ticket.status)) return false;
  const notices = Number(ticket.delay_notices) || 0;
  if (notices >= MAX_DELAY_NOTICES) return false;
  const due = ms(ticket.due_at);
  if (due == null) return false;
  return now >= due + notices * DELAY_REPEAT_HOURS * HOUR;
}

/** Nobody has answered within the first 24 hours: nudge the owner, once. */
function ownerNudgeDue(ticket, now = Date.now()) {
  if (!ticket || ticket.status !== 'open' || ticket.first_response_at || ticket.owner_reminded_at) return false;
  const by = ms(ticket.respond_by);
  return by != null && now >= by;
}

function isOverdue(ticket, now = Date.now()) {
  const due = ms(ticket && ticket.due_at);
  return !!ticket && ACTIVE.has(ticket.status) && due != null && now > due;
}

function canReopen(ticket, now = Date.now()) {
  if (!ticket || ticket.status !== 'closed') return false;
  const closed = ms(ticket.closed_at);
  return closed != null && now - closed <= REOPEN_WINDOW_DAYS * 24 * HOUR;
}

function fmtWhen(value) {
  const t = ms(value);
  if (t == null) return '';
  return new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) + ' IST';
}

// ── What a customer is shown ───────────────────────────────────────────────

function publicTicket(ticket, events = [], now = Date.now()) {
  return {
    ticket_no: ticket.ticket_no,
    order_id: ticket.order_id,
    category: ticket.category,
    category_label: (CATEGORY_BY_ID[ticket.category] || {}).label || 'Support',
    status: ticket.status,
    status_label: STATUS_LABEL[ticket.status] || ticket.status,
    created_at: ticket.created_at,
    respond_by: ticket.respond_by,
    due_at: ticket.due_at,
    closed_at: ticket.closed_at || null,
    resolution: ticket.status === 'closed' ? (ticket.resolution || null) : null,
    delayed: isOverdue(ticket, now),
    can_reopen: canReopen(ticket, now),
    can_reply: ticket.status !== 'closed' || canReopen(ticket, now),
    timeline: events.filter((e) => !e.internal).map((e) => ({
      actor: e.actor,
      kind: e.kind,
      body: e.body,
      at: e.created_at,
      attachments: (Array.isArray(e.attachments) ? e.attachments : []).map((a) => ({ name: a.name, type: a.type })),
    })),
  };
}

// ── Emails ─────────────────────────────────────────────────────────────────

function shell(heading, bodyHtml) {
  return `<div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:620px;margin:0 auto;padding:30px;">
  <h1 style="color:#c9a84c;font-size:22px;font-weight:400;margin:0 0 2px;">Ink &amp; Chai</h1>
  <p style="color:#a09080;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 22px;">Customer support</p>
  <h2 style="color:#f0e8d8;font-size:19px;font-weight:400;margin:0 0 14px;">${heading}</h2>
  ${bodyHtml}
  <hr style="border:none;border-top:1px solid #2a2a2a;margin:26px 0 12px;"/>
  <p style="color:#7a6330;font-size:11px;margin:0;">Ink &amp; Chai · inkandchai.in · Need us sooner? WhatsApp +91 92171 75546</p>
</div>`;
}
const p = (html) => `<p style="color:#cfc4b2;line-height:1.75;font-size:14px;margin:10px 0;">${html}</p>`;
const quote = (text) => `<div style="border-left:3px solid #c9a84c;background:#1c1916;padding:10px 14px;margin:12px 0;color:#f0e8d8;font-size:13.5px;line-height:1.7;white-space:pre-wrap;">${esc(text)}</div>`;
const box = (rows) => `<table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:13px;">${rows.filter(Boolean).map(([k, v]) =>
  `<tr><td style="padding:6px 10px;color:#a09080;width:34%;border-bottom:1px solid #2a2a2a;">${esc(k)}</td><td style="padding:6px 10px;color:#f0e8d8;border-bottom:1px solid #2a2a2a;">${v}</td></tr>`).join('')}</table>`;
const button = (href, label) => `<p style="margin:18px 0;"><a href="${esc(href)}" style="display:inline-block;background:#c9a84c;color:#0d0b08;padding:11px 24px;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:600;">${esc(label)}</a></p>`;

const statusUrl = (t) => `${SITE}/support/?t=${encodeURIComponent(t.ticket_no)}`;
const firstName = (t) => esc(String(t.customer_name || '').trim().split(/\s+/)[0] || 'there');

function customerConfirmation(t) {
  return {
    subject: `We've got your request — ticket ${t.ticket_no}`,
    html: shell('We\'ve received your request', [
      p(`Hi ${firstName(t)}, thank you for telling us. Your ticket is open and our team will look into it.`),
      box([['Ticket', `<strong style="color:#c9a84c;">${esc(t.ticket_no)}</strong>`], ['Order', esc(t.order_id)], ['Topic', esc((CATEGORY_BY_ID[t.category] || {}).label || '')],
        ['First reply by', esc(fmtWhen(t.respond_by))], ['Resolution target', `within 24–48 hours (by ${esc(fmtWhen(t.due_at))})`]]),
      quote(t.message),
      p('If it is taking longer than that, we will tell you — you will not have to chase us. You can check the status or add more photos or details any time:'),
      button(statusUrl(t), 'View my ticket'),
      p(`Keep the ticket number handy: <strong>${esc(t.ticket_no)}</strong>.`),
    ].join('')),
  };
}

function customerReply(t, message) {
  return {
    subject: `Update on your ticket ${t.ticket_no}`,
    html: shell('We\'ve replied to your ticket', [
      p(`Hi ${firstName(t)}, our team has written back on ticket <strong style="color:#c9a84c;">${esc(t.ticket_no)}</strong>:`),
      quote(message),
      p(t.status === 'waiting_customer'
        ? 'We need a little more from you to move forward. Please reply on your ticket page — the clock pauses until you do.'
        : 'You can reply or add photos on your ticket page.'),
      button(statusUrl(t), 'Open my ticket'),
    ].join('')),
  };
}

function customerDelay(t, now = Date.now()) {
  const hrs = Math.max(1, Math.round((now - (ms(t.created_at) || now)) / HOUR));
  return {
    subject: `Your ticket ${t.ticket_no} is taking longer than expected`,
    html: shell('This is taking longer than we promised', [
      p(`Hi ${firstName(t)}, we told you ticket <strong style="color:#c9a84c;">${esc(t.ticket_no)}</strong> would be resolved within 24–48 hours. It has been about ${hrs} hours, and we have not finished — we are sorry for the wait.`),
      p('It is still being worked on and has been flagged to the owner. You do not need to do anything; we will message you as soon as it is resolved.'),
      box([['Ticket', esc(t.ticket_no)], ['Order', esc(t.order_id)], ['Opened', esc(fmtWhen(t.created_at))]]),
      p('If it is urgent, WhatsApp us on +91 92171 75546 and quote your ticket number.'),
      button(statusUrl(t), 'See the latest'),
    ].join('')),
  };
}

function customerClosed(t) {
  return {
    subject: `Resolved — ticket ${t.ticket_no} is closed`,
    html: shell('Your ticket is resolved', [
      p(`Hi ${firstName(t)}, we have closed ticket <strong style="color:#c9a84c;">${esc(t.ticket_no)}</strong>. Here is what we did:`),
      quote(t.resolution || 'Resolved.'),
      p(`If this has not fixed it, you can reopen the ticket within ${REOPEN_WINDOW_DAYS} days from your ticket page and we will pick it straight back up.`),
      button(statusUrl(t), 'View ticket'),
    ].join('')),
  };
}

function ownerAdminUrl() { return `${SITE}/admin/#tickets`; }

function ownerNewTicket(t, order) {
  const items = Array.isArray(order && order.cart_items)
    ? order.cart_items.filter((i) => i && i.title).map((i) => `${esc(i.title)} ×${esc(i.qty || 1)}`).join('<br/>') : '';
  const paid = order && order.razorpay_payment_id ? 'Prepaid' : 'COD / unpaid';
  return {
    subject: `🎫 ${t.priority === 'high' ? '[HIGH] ' : ''}New ticket ${t.ticket_no} — ${(CATEGORY_BY_ID[t.category] || {}).label || t.category} (${t.order_id})`,
    html: shell(`New support ticket ${esc(t.ticket_no)}`, [
      box([
        ['Customer', `${esc(t.customer_name || '—')}<br/>${esc(t.customer_email || '')}<br/>${esc(t.customer_phone || '')}`],
        ['Topic', `${esc((CATEGORY_BY_ID[t.category] || {}).label || t.category)}${t.priority === 'high' ? ' · <strong style="color:#e07060;">high priority</strong>' : ''}`],
        ['Order', `${esc(t.order_id)}${order ? ` · ${esc(order.status || '')} · ${esc(paid)} · ₹${esc(Math.round((Number(order.amount_paise) || 0) / 100))}` : ''}`],
        order && order.tracking_id ? ['Shipment', `${esc(order.courier_name || '')} ${esc(order.tracking_id)}`] : null,
        items ? ['Items', items] : null,
        ['Evidence', t.evidence && t.evidence.length ? `${t.evidence.length} file(s)` : 'none attached'],
        ['Reply by', esc(fmtWhen(t.respond_by))],
        ['Resolve by', esc(fmtWhen(t.due_at))],
      ]),
      quote(t.message),
      button(ownerAdminUrl(), 'Open in admin'),
    ].join('')),
  };
}

function ownerEvidence(t, extra) {
  return {
    subject: `📎 Evidence added to ${t.ticket_no} (${t.order_id})`,
    html: shell(`Evidence added to ${esc(t.ticket_no)}`, [
      p(`${esc(t.customer_name || 'The customer')} attached ${extra.files.length} file(s) to ticket ${esc(t.ticket_no)} (order ${esc(t.order_id)}).`),
      `<ul style="color:#cfc4b2;font-size:13.5px;line-height:1.8;">${extra.files.map((f) => `<li>${esc(f.name)} <span style="color:#a09080;">(${esc(evidenceKind(f.type))}, ${(f.size / 1048576).toFixed(1)} MB${f.attached ? ', attached to this email' : ''})</span></li>`).join('')}</ul>`,
      p('Images that fit are attached; videos and large files open from the ticket in admin.'),
      button(ownerAdminUrl(), 'Open in admin'),
    ].join('')),
  };
}

function ownerCustomerReply(t, message, files = []) {
  return {
    subject: `💬 Customer replied on ${t.ticket_no} (${t.order_id})${t.status === 'closed' ? ' — REOPENED' : ''}`,
    html: shell(`${esc(t.customer_name || 'Customer')} replied on ${esc(t.ticket_no)}`, [
      quote(message),
      files.length ? p(`${files.length} file(s) attached — see them in admin.`) : '',
      button(ownerAdminUrl(), 'Open in admin'),
    ].join('')),
  };
}

function ownerOverdue(t, now = Date.now()) {
  const hrs = Math.round((now - (ms(t.created_at) || now)) / HOUR);
  return {
    subject: `⏰ OVERDUE ticket ${t.ticket_no} — ${hrs}h open (${t.order_id})`,
    html: shell(`Ticket ${esc(t.ticket_no)} is past its 48-hour target`, [
      p(`The customer has been told it is taking longer than expected. It has been open about <strong>${hrs} hours</strong>.`),
      box([['Customer', esc(t.customer_name || t.customer_email || t.customer_phone || '')], ['Order', esc(t.order_id)], ['Topic', esc((CATEGORY_BY_ID[t.category] || {}).label || '')], ['Status', esc(STATUS_LABEL[t.status] || t.status)]]),
      quote(t.message),
      button(ownerAdminUrl(), 'Resolve it now'),
    ].join('')),
  };
}

function ownerNudge(t) {
  return {
    subject: `⏳ No reply yet on ${t.ticket_no} — 24h target passed (${t.order_id})`,
    html: shell(`Nobody has answered ${esc(t.ticket_no)} yet`, [
      p('This ticket was promised a first reply within 24 hours, and none has been sent.'),
      quote(t.message),
      button(ownerAdminUrl(), 'Reply now'),
    ].join('')),
  };
}

function customerWhatsApp(kind, t) {
  const name = String(t.customer_name || '').trim().split(/\s+/)[0] || 'there';
  if (kind === 'delay') return { template: 'ticket_delay_update', params: [name, t.ticket_no] };
  if (kind === 'closed') return { template: 'ticket_resolved', params: [name, t.ticket_no] };
  return { template: 'ticket_received', params: [name, t.ticket_no] };
}

module.exports = {
  OWNER_EMAIL_DEFAULT, RESPOND_HOURS, RESOLVE_HOURS, DELAY_REPEAT_HOURS, MAX_DELAY_NOTICES, REOPEN_WINDOW_DAYS,
  MAX_OPEN_PER_ORDER_CATEGORY, MIN_MESSAGE, MAX_MESSAGE, MAX_FILES_PER_SUBMISSION, MAX_FILES_PER_TICKET,
  CATEGORIES, CATEGORY_BY_ID, STATUSES, STATUS_LABEL, ACTIVE, EVIDENCE_TYPES,
  ownerEmail, newTicketNo, normTicketNo, contactMatches, cleanOrderId, parseNewTicket, parseFileMetas, cleanFileName,
  evidenceKey, isEvidenceKeyFor, evidenceKind, slaDates, delayNoticeDue, ownerNudgeDue, isOverdue, canReopen,
  publicTicket, fmtWhen,
  customerConfirmation, customerReply, customerDelay, customerClosed,
  ownerNewTicket, ownerEvidence, ownerCustomerReply, ownerOverdue, ownerNudge, customerWhatsApp, esc,
};
