'use strict';

/**
 * The operations on a support ticket, as functions of an explicit `deps` so the
 * handlers stay thin and every one of them is testable without a network:
 *
 *   deps = { db, sendEmail, sendWhatsApp, r2: { presign, head, get }, now, whatsappOn, ownerEmail }
 *
 * Each returns { status, body } -- the HTTP answer -- and never throws for an
 * expected refusal. Emails and WhatsApps are sent AFTER the database write and
 * their failure never undoes it: a ticket that exists but whose confirmation
 * bounced is far better than a ticket that was lost because an email provider
 * was down.
 *
 * Needs sql/support_tickets.sql.
 */

const T = require('./support-ticket');

const TICKETS = 'support_tickets';
const EVENTS = 'support_ticket_events';
const MISSING_TABLE = /relation .* does not exist|Could not find the table|schema cache/i;
const UNIQUE_VIOLATION = '23505';
// The partial unique index that allows one unresolved ticket per order.
const ONE_OPEN_INDEX = 'support_tickets_one_open_per_order';
const UNRESOLVED = ['open', 'in_progress', 'waiting_customer'];

// The order's unresolved ticket, if any (other than `exceptId`).
async function unresolvedTicketFor(deps, orderId, exceptId = null) {
  const r = await deps.db.from(TICKETS).select('id,ticket_no,status').eq('order_id', orderId).in('status', UNRESOLVED);
  if (r.error) return { error: r.error };
  return { ticket: (r.data || []).find((t) => t.id !== exceptId) || null };
}

function alreadyOpen(t) {
  return fail(409, `This order already has an open ticket (${t.ticket_no}). We'll resolve that one first — please add any new details or photos to it. You can raise a new ticket for this order once it is closed.`, { existing_ticket: t.ticket_no });
}

const fail = (status, error, extra = {}) => ({ status, body: { ok: false, error, ...extra } });
const ok = (body = {}) => ({ status: 200, body: { ok: true, ...body } });
const NOT_FOUND_TICKET = 'We could not find that ticket for that email or phone number. Check the ticket number and the contact you used on the order.';
const NO_TABLE = 'Tickets are being set up — please WhatsApp us on +91 92171 75546 for now.';

const nowOf = (deps) => (deps.now ? deps.now() : Date.now());

async function safe(label, fn) {
  try { return await fn(); } catch (e) { console.warn(`[support-ticket] ${label}:`, e && e.message); return null; }
}

async function addEvent(deps, ticketId, ev) {
  return safe('event', async () => {
    const { error } = await deps.db.from(EVENTS).insert({
      ticket_id: ticketId, actor: ev.actor, kind: ev.kind, body: ev.body || null,
      attachments: ev.attachments || [], internal: !!ev.internal,
      created_at: new Date(nowOf(deps)).toISOString(),
    });
    if (error) throw error;
  });
}

async function loadTicketFor(deps, ticketNo, contact) {
  const no = T.normTicketNo(ticketNo);
  if (!no) return { error: fail(400, 'Please enter your ticket number, like TKT-AB12CD.') };
  const { data, error } = await deps.db.from(TICKETS).select('*').eq('ticket_no', no).maybeSingle();
  if (error) return { error: MISSING_TABLE.test(error.message || '') ? fail(503, NO_TABLE) : fail(500, 'Could not look that up right now.') };
  // One message for "no such ticket" and "not your ticket": do not confirm which.
  if (!data || !T.contactMatches(data, contact)) return { error: fail(404, NOT_FOUND_TICKET) };
  return { ticket: data };
}

async function loadEvents(deps, ticketId) {
  const { data } = await deps.db.from(EVENTS).select('*').eq('ticket_id', ticketId).order('created_at', { ascending: true });
  return data || [];
}

/** Presigned PUTs, one per declared file, bound to this ticket. */
function signUploads(deps, ticketNo, files) {
  const out = [];
  for (const f of files) {
    const key = T.evidenceKey(ticketNo, f.type, nowOf(deps));
    out.push({ key, name: f.name, type: f.type, upload_url: deps.r2.presign(key, f.type) });
  }
  return out;
}

async function sendBoth(deps, { to, mail, wa }) {
  const jobs = [];
  if (to && mail) jobs.push(safe('email', () => deps.sendEmail({ to, subject: mail.subject, html: mail.html, attachments: mail.attachments })));
  if (wa && deps.whatsappOn && wa.phone) jobs.push(safe('whatsapp', () => deps.sendWhatsApp({ to: wa.phone, template: wa.template, params: wa.params })));
  await Promise.all(jobs);
}

async function tellOwner(deps, mail) {
  return safe('owner email', () => deps.sendEmail({ to: deps.ownerEmail, subject: mail.subject, html: mail.html, attachments: mail.attachments }));
}

// ── Customer: open a ticket ────────────────────────────────────────────────

async function createTicket(deps, body, { ipHash = null } = {}) {
  const parsed = T.parseNewTicket(body);
  if (!parsed.ok) return fail(400, parsed.error, { field: parsed.field });
  const { orderId, contact, category, message, files } = parsed.value;

  let { data: order, error: orderErr } = await deps.db.from('orders').select('*').eq('razorpay_order_id', orderId).limit(1).maybeSingle();
  if (!orderErr && !order) {
    const r = await deps.db.from('orders').select('*').ilike('razorpay_order_id', orderId).limit(1).maybeSingle();
    order = r.data || null;
    orderErr = r.error;
  }
  if (orderErr) return fail(500, 'Could not check that order right now. Please try again in a minute.');
  // Same answer for "no such order" and "wrong contact": an order id alone must
  // never confirm that an order exists.
  if (!order || !T.contactMatches(order, contact)) {
    return fail(404, 'We could not match that order ID with that email or phone number. Please check both — they must be the ones used when the order was placed.', { field: 'order_id' });
  }
  const realOrderId = order.razorpay_order_id || orderId;

  // One unresolved ticket per order, whatever the topic, until it is closed.
  const open = await unresolvedTicketFor(deps, realOrderId);
  if (open.error && MISSING_TABLE.test(open.error.message || '')) return fail(503, NO_TABLE);
  if (open.error) return fail(500, 'Could not check this order right now. Please try again in a minute.');
  if (open.ticket) return alreadyOpen(open.ticket);

  const now = nowOf(deps);
  const sla = T.slaDates(now);
  const base = {
    order_id: realOrderId,
    customer_name: order.customer_name || null,
    customer_email: order.customer_email || null,
    customer_phone: order.customer_phone || null,
    category: category.id,
    priority: category.priority,
    subject: category.label,
    message,
    evidence: [],
    status: 'open',
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
    respond_by: sla.respond_by,
    due_at: sla.due_at,
    last_customer_at: new Date(now).toISOString(),
    source_ip_hash: ipHash,
  };

  let ticket = null;
  for (let attempt = 0; attempt < 5 && !ticket; attempt += 1) {
    const { data, error } = await deps.db.from(TICKETS).insert({ ...base, ticket_no: T.newTicketNo(deps.randomBytes ? deps.randomBytes() : undefined) }).select('*').single();
    if (!error) { ticket = data; break; }
    if (MISSING_TABLE.test(error.message || '')) return fail(503, NO_TABLE);
    // Two submissions at once: the index lets only one through.
    if (error.code === UNIQUE_VIOLATION && String(error.message || '').includes(ONE_OPEN_INDEX)) {
      const winner = await unresolvedTicketFor(deps, realOrderId);
      return winner.ticket ? alreadyOpen(winner.ticket) : fail(409, 'This order already has an open ticket. Please check your email for its number.');
    }
    if (error.code !== UNIQUE_VIOLATION) {
      console.error('[support-ticket] insert:', error.message);
      return fail(500, 'We could not save your ticket just now. Please try again, or WhatsApp us on +91 92171 75546.');
    }
  }
  if (!ticket) return fail(500, 'We could not save your ticket just now. Please try again.');

  await addEvent(deps, ticket.id, { actor: 'customer', kind: 'created', body: message });

  let uploads = [];
  let evidenceError = null;
  if (files.length) {
    if (deps.r2 && deps.r2.configured) uploads = signUploads(deps, ticket.ticket_no, files);
    else evidenceError = 'Photo upload is unavailable right now. Your ticket is open — please WhatsApp the photos to +91 92171 75546 quoting the ticket number.';
  }

  await Promise.all([
    sendBoth(deps, { to: ticket.customer_email, mail: T.customerConfirmation(ticket), wa: { phone: ticket.customer_phone, ...T.customerWhatsApp('received', ticket) } }),
    tellOwner(deps, T.ownerNewTicket(ticket, order)),
  ]);

  return ok({ ticket_no: ticket.ticket_no, respond_by: ticket.respond_by, due_at: ticket.due_at, uploads, evidence_error: evidenceError });
}

// ── Customer: evidence ─────────────────────────────────────────────────────

async function signMore(deps, body) {
  const { ticket, error } = await loadTicketFor(deps, body.ticket_no, body.contact);
  if (error) return error;
  const files = T.parseFileMetas(body.files);
  if (!files.ok) return fail(400, files.error);
  if (!files.files.length) return fail(400, 'Choose a file to attach.');
  if ((ticket.evidence || []).length + files.files.length > T.MAX_FILES_PER_TICKET) {
    return fail(409, `A ticket can hold ${T.MAX_FILES_PER_TICKET} files in all.`);
  }
  if (!deps.r2 || !deps.r2.configured) return fail(503, 'Photo upload is unavailable right now. Please WhatsApp the photos to +91 92171 75546 quoting your ticket number.');
  return ok({ uploads: signUploads(deps, ticket.ticket_no, files.files) });
}

/** The browser says the PUTs are done; check they really landed before listing them. */
async function attachEvidence(deps, body, { eventBody = null } = {}) {
  const { ticket, error } = await loadTicketFor(deps, body.ticket_no, body.contact);
  if (error) return error;
  const claimed = Array.isArray(body.files) ? body.files.slice(0, T.MAX_FILES_PER_SUBMISSION) : [];
  if (!claimed.length) return fail(400, 'Nothing to attach.');
  const have = Array.isArray(ticket.evidence) ? ticket.evidence : [];
  const haveKeys = new Set(have.map((e) => e.key));

  const accepted = [];
  const rejected = [];
  for (const c of claimed) {
    const key = String((c && c.key) || '');
    const type = String((c && c.type) || '').toLowerCase().split(';')[0].trim();
    const spec = T.EVIDENCE_TYPES[type];
    if (!T.isEvidenceKeyFor(key, ticket.ticket_no) || !spec) { rejected.push(T.cleanFileName(c && c.name)); continue; }
    if (haveKeys.has(key)) continue;
    const head = await safe('head', () => deps.r2.head(key));
    const sentType = head && head.contentType ? String(head.contentType).split(';')[0].trim().toLowerCase() : type;
    if (!head || !head.exists || head.size <= 0 || head.size > spec.maxBytes || sentType !== type) { rejected.push(T.cleanFileName(c && c.name)); continue; }
    accepted.push({ key, name: T.cleanFileName(c.name), type, size: head.size });
  }
  if (have.length + accepted.length > T.MAX_FILES_PER_TICKET) return fail(409, `A ticket can hold ${T.MAX_FILES_PER_TICKET} files in all.`);
  if (!accepted.length) {
    return fail(400, rejected.length ? `We could not receive: ${rejected.join(', ')}. Please try attaching again.` : 'Those files were already attached.');
  }

  const merged = [...have, ...accepted];
  const { error: upErr } = await deps.db.from(TICKETS)
    .update({ evidence: merged, updated_at: new Date(nowOf(deps)).toISOString() }).eq('id', ticket.id);
  if (upErr) return fail(500, 'Your files uploaded but could not be attached. Please try again.');
  await addEvent(deps, ticket.id, { actor: 'customer', kind: 'message', body: eventBody || `Attached ${accepted.length} file${accepted.length === 1 ? '' : 's'}.`, attachments: accepted });

  // Owner: small images ride along, so they can be judged from the inbox.
  const attachments = [];
  let budget = 8 * 1024 * 1024;
  const listing = [];
  for (const f of accepted) {
    let attached = false;
    if (T.evidenceKind(f.type) === 'image' && f.type !== 'image/heic' && f.size <= 2.5 * 1024 * 1024 && f.size <= budget && attachments.length < 4) {
      const got = await safe('fetch evidence', () => deps.r2.get(f.key));
      if (got && got.ok) { attachments.push({ filename: f.name, content: Buffer.from(got.body), contentType: f.type }); budget -= f.size; attached = true; }
    }
    listing.push({ ...f, attached });
  }
  const mail = T.ownerEvidence(ticket, { files: listing });
  await tellOwner(deps, { ...mail, attachments });

  return ok({ attached: accepted.length, rejected });
}

// ── Customer: look up / reply ──────────────────────────────────────────────

async function lookupTicket(deps, body) {
  const { ticket, error } = await loadTicketFor(deps, body.ticket_no, body.contact);
  if (error) return error;
  return ok({ ticket: T.publicTicket(ticket, await loadEvents(deps, ticket.id), nowOf(deps)) });
}

/** "I lost my ticket number": every ticket on an order the caller owns. */
async function findTickets(deps, body) {
  const orderId = T.cleanOrderId(body.order_id);
  if (!orderId) return fail(400, 'Enter your order ID.');
  const { data, error } = await deps.db.from(TICKETS).select('*').eq('order_id', orderId).order('created_at', { ascending: false });
  if (error) return MISSING_TABLE.test(error.message || '') ? fail(503, NO_TABLE) : fail(500, 'Could not look that up right now.');
  const mine = (data || []).filter((t) => T.contactMatches(t, body.contact));
  if (!mine.length) return fail(404, 'No tickets found for that order and contact.');
  return ok({ tickets: mine.map((t) => ({ ticket_no: t.ticket_no, status: t.status, status_label: T.STATUS_LABEL[t.status], category_label: (T.CATEGORY_BY_ID[t.category] || {}).label, created_at: t.created_at })) });
}

async function customerReply(deps, body) {
  const { ticket, error } = await loadTicketFor(deps, body.ticket_no, body.contact);
  if (error) return error;
  const message = String(body.message || '').replace(/\r\n/g, '\n').trim();
  if (message.length < 3) return fail(400, 'Please write your message.');
  if (message.length > T.MAX_MESSAGE) return fail(400, `Please keep it under ${T.MAX_MESSAGE} characters.`);
  const files = T.parseFileMetas(body.files);
  if (!files.ok) return fail(400, files.error);

  const now = nowOf(deps);
  const iso = new Date(now).toISOString();
  const patch = { last_customer_at: iso, updated_at: iso };
  let reopened = false;
  if (ticket.status === 'closed') {
    if (!T.canReopen(ticket, now)) return fail(409, `This ticket was closed more than ${T.REOPEN_WINDOW_DAYS} days ago. Please open a new ticket and mention ${ticket.ticket_no}.`);
    const other = await unresolvedTicketFor(deps, ticket.order_id, ticket.id);
    if (other.ticket) return alreadyOpen(other.ticket);
    const sla = T.slaDates(now);
    Object.assign(patch, { status: 'open', closed_at: null, resolution: null, reopened_count: (ticket.reopened_count || 0) + 1,
      respond_by: sla.respond_by, due_at: sla.due_at, delay_notices: 0, delay_notified_at: null, owner_reminded_at: null, first_response_at: null });
    reopened = true;
  } else if (ticket.status === 'waiting_customer') {
    // They have answered: the clock restarts with at least a day on it.
    const due = new Date(Math.max(new Date(ticket.due_at).getTime() || 0, now + T.RESPOND_HOURS * 3600 * 1000)).toISOString();
    Object.assign(patch, { status: 'in_progress', due_at: due, delay_notices: 0 });
  }
  if (files.files.length && ((ticket.evidence || []).length + files.files.length > T.MAX_FILES_PER_TICKET)) {
    return fail(409, `A ticket can hold ${T.MAX_FILES_PER_TICKET} files in all.`);
  }
  const { error: upErr } = await deps.db.from(TICKETS).update(patch).eq('id', ticket.id);
  if (upErr && reopened && String(upErr.message || '').includes(ONE_OPEN_INDEX)) {
    const other = await unresolvedTicketFor(deps, ticket.order_id, ticket.id);
    if (other.ticket) return alreadyOpen(other.ticket);
  }
  if (upErr) return fail(500, 'Could not send your message. Please try again.');

  if (reopened) await addEvent(deps, ticket.id, { actor: 'system', kind: 'status', body: 'Reopened by the customer.' });
  await addEvent(deps, ticket.id, { actor: 'customer', kind: 'message', body: message });

  let uploads = [];
  if (files.files.length && deps.r2 && deps.r2.configured) uploads = signUploads(deps, ticket.ticket_no, files.files);

  await tellOwner(deps, T.ownerCustomerReply({ ...ticket, ...patch }, message, files.files));
  return ok({ reopened, uploads, status: patch.status || ticket.status });
}

// ── Staff ──────────────────────────────────────────────────────────────────

async function loadById(deps, id) {
  const { data, error } = await deps.db.from(TICKETS).select('*').eq('id', id).maybeSingle();
  if (error) return { error: fail(500, error.message) };
  if (!data) return { error: fail(404, 'Ticket not found.') };
  return { ticket: data };
}

async function staffReply(deps, { id, message, status }) {
  const { ticket, error } = await loadById(deps, id);
  if (error) return error;
  const text = String(message || '').trim();
  if (text.length < 2) return fail(400, 'Write a reply first.');
  if (ticket.status === 'closed') return fail(409, 'This ticket is closed. Reopen it to reply.');
  const next = ['in_progress', 'waiting_customer'].includes(status) ? status : 'in_progress';
  const iso = new Date(nowOf(deps)).toISOString();
  const patch = { status: next, last_staff_at: iso, updated_at: iso, ...(ticket.first_response_at ? {} : { first_response_at: iso }) };
  const { error: upErr } = await deps.db.from(TICKETS).update(patch).eq('id', ticket.id);
  if (upErr) return fail(500, upErr.message);
  await addEvent(deps, ticket.id, { actor: 'staff', kind: 'message', body: text });
  const t = { ...ticket, ...patch };
  await sendBoth(deps, { to: t.customer_email, mail: T.customerReply(t, text) });
  return ok({ status: next, emailed: !!t.customer_email });
}

async function staffNote(deps, { id, body }) {
  const { ticket, error } = await loadById(deps, id);
  if (error) return error;
  const text = String(body || '').trim();
  if (!text) return fail(400, 'Write the note first.');
  await addEvent(deps, ticket.id, { actor: 'staff', kind: 'note', body: text, internal: true });
  return ok();
}

async function staffSetStatus(deps, { id, status }) {
  const { ticket, error } = await loadById(deps, id);
  if (error) return error;
  if (!['open', 'in_progress', 'waiting_customer'].includes(status)) return fail(400, 'Unknown status.');
  if (ticket.status === 'closed') return fail(409, 'This ticket is closed. Reopen it first.');
  const iso = new Date(nowOf(deps)).toISOString();
  const { error: upErr } = await deps.db.from(TICKETS).update({ status, updated_at: iso, last_staff_at: iso }).eq('id', ticket.id);
  if (upErr) return fail(500, upErr.message);
  await addEvent(deps, ticket.id, { actor: 'staff', kind: 'status', body: `Status set to ${T.STATUS_LABEL[status]}.`, internal: true });
  return ok({ status });
}

/** Closing requires a resolution: it is the message the customer receives. */
async function staffClose(deps, { id, resolution }) {
  const { ticket, error } = await loadById(deps, id);
  if (error) return error;
  const text = String(resolution || '').trim();
  if (text.length < 5) return fail(400, 'Write what was done to resolve it — the customer receives this.');
  if (ticket.status === 'closed') return fail(409, 'Already closed.');
  const iso = new Date(nowOf(deps)).toISOString();
  const patch = { status: 'closed', resolution: text.slice(0, 2000), closed_at: iso, updated_at: iso, last_staff_at: iso, ...(ticket.first_response_at ? {} : { first_response_at: iso }) };
  const { error: upErr } = await deps.db.from(TICKETS).update(patch).eq('id', ticket.id);
  if (upErr) return fail(500, upErr.message);
  await addEvent(deps, ticket.id, { actor: 'staff', kind: 'status', body: `Closed: ${patch.resolution}` });
  const t = { ...ticket, ...patch };
  await sendBoth(deps, { to: t.customer_email, mail: T.customerClosed(t), wa: { phone: t.customer_phone, ...T.customerWhatsApp('closed', t) } });
  return ok({ status: 'closed' });
}

async function staffReopen(deps, { id }) {
  const { ticket, error } = await loadById(deps, id);
  if (error) return error;
  if (ticket.status !== 'closed') return fail(409, 'Only a closed ticket can be reopened.');
  const other = await unresolvedTicketFor(deps, ticket.order_id, ticket.id);
  if (other.ticket) return fail(409, `Order ${ticket.order_id} already has an open ticket (${other.ticket.ticket_no}). Close that one first, or continue there.`, { existing_ticket: other.ticket.ticket_no });
  const now = nowOf(deps);
  const sla = T.slaDates(now);
  const iso = new Date(now).toISOString();
  const { error: upErr } = await deps.db.from(TICKETS).update({
    status: 'open', closed_at: null, resolution: null, reopened_count: (ticket.reopened_count || 0) + 1,
    respond_by: sla.respond_by, due_at: sla.due_at, delay_notices: 0, delay_notified_at: null, owner_reminded_at: null, updated_at: iso,
  }).eq('id', ticket.id);
  if (upErr && String(upErr.message || '').includes(ONE_OPEN_INDEX)) return fail(409, `Order ${ticket.order_id} already has an open ticket. Close that one first, or continue there.`);
  if (upErr) return fail(500, upErr.message);
  await addEvent(deps, ticket.id, { actor: 'staff', kind: 'status', body: 'Reopened by staff.', internal: true });
  return ok({ status: 'open' });
}

// ── The hourly watchdog ────────────────────────────────────────────────────

/**
 * Tell customers about delays, and the owner about neglect.
 * Each notice is CLAIMED with a conditional update before it is sent, so two
 * overlapping runs cannot both send it.
 */
async function runSlaSweep(deps, { dryRun = false, limit = 60 } = {}) {
  const now = nowOf(deps);
  const { data, error } = await deps.db.from(TICKETS).select('*').in('status', ['open', 'in_progress']).order('due_at', { ascending: true }).limit(500);
  if (error) {
    if (MISSING_TABLE.test(error.message || '')) return { ok: true, skipped: 'tickets table not created yet' };
    return { ok: false, error: error.message };
  }
  const out = { ok: true, dry_run: dryRun, checked: (data || []).length, delay_notices: [], owner_nudges: [], failed: [] };
  let sent = 0;
  for (const t of data || []) {
    if (sent >= limit) break;

    if (T.ownerNudgeDue(t, now)) {
      if (dryRun) { out.owner_nudges.push(t.ticket_no); sent += 1; }
      else {
        const claim = await deps.db.from(TICKETS).update({ owner_reminded_at: new Date(now).toISOString() })
          .eq('id', t.id).is('owner_reminded_at', null).select('id');
        if (!claim.error && claim.data && claim.data.length) {
          await tellOwner(deps, T.ownerNudge(t));
          out.owner_nudges.push(t.ticket_no); sent += 1;
        }
      }
    }

    if (T.delayNoticeDue(t, now)) {
      if (dryRun) { out.delay_notices.push(t.ticket_no); sent += 1; continue; }
      const n = Number(t.delay_notices) || 0;
      const claim = await deps.db.from(TICKETS)
        .update({ delay_notices: n + 1, delay_notified_at: new Date(now).toISOString() })
        .eq('id', t.id).eq('delay_notices', n).in('status', ['open', 'in_progress']).select('id');
      if (claim.error) { out.failed.push(`${t.ticket_no}: ${claim.error.message}`); continue; }
      if (!claim.data || !claim.data.length) continue;
      const fresh = { ...t, delay_notices: n + 1 };
      await Promise.all([
        sendBoth(deps, { to: t.customer_email, mail: T.customerDelay(fresh, now), wa: { phone: t.customer_phone, ...T.customerWhatsApp('delay', t) } }),
        tellOwner(deps, T.ownerOverdue(fresh, now)),
      ]);
      await addEvent(deps, t.id, { actor: 'system', kind: 'delay', body: `Told the customer this is taking longer than the promised 24–48 hours (notice ${n + 1}).` });
      out.delay_notices.push(t.ticket_no); sent += 1;
    }
  }
  return out;
}

module.exports = {
  createTicket, signMore, attachEvidence, lookupTicket, findTickets, customerReply,
  staffReply, staffNote, staffSetStatus, staffClose, staffReopen, runSlaSweep,
  loadEvents, MISSING_TABLE,
};
