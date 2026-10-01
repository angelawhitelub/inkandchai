'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const T = require('./support-ticket');
const A = require('./support-ticket-actions');

const H = 3600 * 1000;
const T0 = Date.parse('2026-10-02T06:00:00Z');

// ── An in-memory stand-in for the three tables ──────────────────────────────
function fakeDb(seed = {}) {
  const tables = { orders: [], support_tickets: [], support_ticket_events: [], ...seed };
  const from = (name) => {
    const q = { op: 'select', filters: [], payload: null, ord: null, lim: null, single: null };
    const api = {
      select() { return api; },
      insert(p) { q.op = 'insert'; q.payload = p; return api; },
      update(p) { q.op = 'update'; q.payload = p; return api; },
      eq(c, v) { q.filters.push((r) => r[c] === v); return api; },
      in(c, vs) { q.filters.push((r) => vs.includes(r[c])); return api; },
      is(c, v) { q.filters.push((r) => (r[c] ?? null) === v); return api; },
      ilike(c, v) { q.filters.push((r) => String(r[c] || '').toLowerCase() === String(v).toLowerCase()); return api; },
      order(c, { ascending } = {}) { q.ord = [c, ascending !== false]; return api; },
      limit(n) { q.lim = n; return api; },
      maybeSingle() { q.single = 'maybe'; return api; },
      single() { q.single = 'one'; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      const rows = tables[name];
      if (q.op === 'insert') {
        if (name === 'support_tickets' && rows.some((r) => r.ticket_no === q.payload.ticket_no)) {
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        const row = { id: crypto.randomUUID(), delay_notices: 0, reopened_count: 0, evidence: [], ...q.payload };
        rows.push(row);
        return { data: q.single ? row : [row], error: null };
      }
      let hit = rows.filter((r) => q.filters.every((f) => f(r)));
      if (q.op === 'update') { hit.forEach((r) => Object.assign(r, q.payload)); return { data: hit.map((r) => ({ id: r.id })), error: null }; }
      if (q.ord) hit = hit.slice().sort((a, b) => (a[q.ord[0]] > b[q.ord[0]] ? 1 : -1) * (q.ord[1] ? 1 : -1));
      if (q.lim) hit = hit.slice(0, q.lim);
      if (q.single) return { data: hit[0] || null, error: null };
      return { data: hit, error: null };
    }
    return api;
  };
  return { from, tables };
}

const ORDER = {
  razorpay_order_id: 'IC-20260930-ABCDE', customer_name: 'Asha Rao', customer_email: 'asha@example.com',
  customer_phone: '+91 98765 43210', status: 'delivered', amount_paise: 28900, razorpay_payment_id: 'OMO1',
  cart_items: [{ title: 'Some Book', qty: 1 }],
};

function setup({ now = T0, objects = {}, r2Configured = true, whatsappOn = false } = {}) {
  const db = fakeDb({ orders: [{ ...ORDER }] });
  const clock = { now };
  const mails = []; const waMsgs = [];
  const deps = {
    db, now: () => clock.now, whatsappOn, ownerEmail: T.OWNER_EMAIL_DEFAULT,
    sendEmail: async (m) => { mails.push(m); return { ok: true }; },
    sendWhatsApp: async (m) => { waMsgs.push(m); return { ok: true }; },
    r2: {
      configured: r2Configured,
      presign: (key, type) => `https://r2.test/${key}?type=${encodeURIComponent(type)}`,
      head: async (key) => objects[key] ? { exists: true, size: objects[key].size, contentType: objects[key].type } : { exists: false, status: 404 },
      get: async (key) => ({ ok: true, body: new Uint8Array(objects[key] ? objects[key].size : 4).buffer }),
    },
  };
  return { deps, db, clock, mails, waMsgs };
}

const valid = (over = {}) => ({
  order_id: 'IC-20260930-ABCDE', contact: 'asha@example.com', category: 'damaged_wrong',
  message: 'The book arrived with a torn cover and water damage.', ...over,
});

// ── Intake rules ────────────────────────────────────────────────────────────

test('an order id is mandatory, then the contact, topic and a real description', () => {
  assert.equal(T.parseNewTicket(valid({ order_id: '  ' })).field, 'order_id');
  assert.match(T.parseNewTicket(valid({ order_id: '' })).error, /order ID/i);
  assert.equal(T.parseNewTicket(valid({ contact: '' })).field, 'contact');
  assert.equal(T.parseNewTicket(valid({ category: 'nope' })).field, 'category');
  assert.equal(T.parseNewTicket(valid({ message: 'broken' })).field, 'message');
  assert.equal(T.parseNewTicket(valid({ message: 'x'.repeat(3001) })).field, 'message');
  assert.equal(T.parseNewTicket(valid()).ok, true);
});

test('attachments: only photos, short videos and PDFs, within size, five at a time', () => {
  const f = (type, size, name = 'a') => ({ type, size, name });
  assert.equal(T.parseFileMetas([f('image/jpeg', 1e6)]).ok, true);
  assert.equal(T.parseFileMetas([f('application/x-msdownload', 100, 'virus.exe')]).ok, false);
  assert.equal(T.parseFileMetas([f('text/html', 100)]).ok, false);
  assert.equal(T.parseFileMetas([f('image/png', 11 * 1048576)]).ok, false);
  assert.equal(T.parseFileMetas([f('video/mp4', 39 * 1048576)]).ok, true);
  assert.equal(T.parseFileMetas(Array(6).fill(f('image/png', 10))).ok, false);
  assert.equal(T.parseFileMetas([f('image/png', 0)]).ok, false);
  assert.equal(T.cleanFileName('../../etc/pa<ss>wd.png'), 'pa_ss_wd.png');
});

test('contact must be the order email or the order phone (last ten digits)', () => {
  assert.equal(T.contactMatches(ORDER, ' ASHA@example.com '), true);
  assert.equal(T.contactMatches(ORDER, '9876543210'), true);
  assert.equal(T.contactMatches(ORDER, '+919876543210'), true);
  assert.equal(T.contactMatches(ORDER, '98765'), false);
  assert.equal(T.contactMatches(ORDER, 'other@example.com'), false);
  assert.equal(T.contactMatches(ORDER, ''), false);
});

test('ticket numbers are typed back forgivingly', () => {
  assert.equal(T.normTicketNo('tkt-ab12cd'), 'TKT-AB12CD');
  assert.equal(T.normTicketNo(' TKT AB12CD '), 'TKT-AB12CD');
  assert.equal(T.normTicketNo('AB12CD'), 'TKT-AB12CD');
  assert.equal(T.normTicketNo('nope'), '');
  assert.match(T.newTicketNo(), /^TKT-[A-HJ-NP-Z2-9]{6}$/);
});

// ── Opening a ticket ────────────────────────────────────────────────────────

test('a valid ticket is stored with 24h/48h deadlines and the owner and customer are both emailed', async () => {
  const s = setup();
  const r = await A.createTicket(s.deps, valid());
  assert.equal(r.status, 200);
  const t = s.db.tables.support_tickets[0];
  assert.equal(t.order_id, 'IC-20260930-ABCDE');
  assert.equal(t.status, 'open');
  assert.equal(t.priority, 'high');
  assert.equal(new Date(t.respond_by).getTime(), T0 + 24 * H);
  assert.equal(new Date(t.due_at).getTime(), T0 + 48 * H);
  assert.equal(r.body.ticket_no, t.ticket_no);
  assert.equal(s.db.tables.support_ticket_events.length, 1);

  const owner = s.mails.find((m) => m.to === 'asfkhn234@gmail.com');
  assert.ok(owner, 'owner is emailed');
  assert.match(owner.subject, new RegExp(t.ticket_no));
  assert.match(owner.html, /torn cover/);
  const cust = s.mails.find((m) => m.to === 'asha@example.com');
  assert.match(cust.html, /24–48 hours/);
  assert.match(cust.subject, new RegExp(t.ticket_no));
});

test('the order id alone proves nothing: wrong contact and unknown order read the same and create nothing', async () => {
  const s = setup();
  const wrong = await A.createTicket(s.deps, valid({ contact: 'stranger@example.com' }));
  const unknown = await A.createTicket(s.deps, valid({ order_id: 'IC-20260101-ZZZZZ' }));
  assert.equal(wrong.status, 404);
  assert.deepEqual(wrong.body.error, unknown.body.error);
  assert.equal(s.db.tables.support_tickets.length, 0);
  assert.equal(s.mails.length, 0);
});

test('order ids are matched case-insensitively', async () => {
  const s = setup();
  const r = await A.createTicket(s.deps, valid({ order_id: 'ic-20260930-abcde' }));
  assert.equal(r.status, 200);
  assert.equal(s.db.tables.support_tickets[0].order_id, 'IC-20260930-ABCDE');
});

test('a second open ticket on the same order and topic is refused and points at the first', async () => {
  const s = setup();
  const first = await A.createTicket(s.deps, valid());
  const second = await A.createTicket(s.deps, valid());
  assert.equal(second.status, 409);
  assert.equal(second.body.existing_ticket, first.body.ticket_no);
  assert.equal(s.db.tables.support_tickets.length, 1);
  const other = await A.createTicket(s.deps, valid({ category: 'refund_payment' }));
  assert.equal(other.status, 200);
});

test('a colliding ticket number is retried, not failed', async () => {
  const s = setup();
  s.db.tables.support_tickets.push({ id: 'x', ticket_no: 'TKT-AAAAAA', order_id: 'other', status: 'closed' });
  const seq = [Buffer.alloc(6, 0), Buffer.from([1, 1, 1, 1, 1, 1])];
  s.deps.randomBytes = () => seq.shift();
  const r = await A.createTicket(s.deps, valid());
  assert.equal(r.status, 200);
  assert.equal(r.body.ticket_no, 'TKT-BBBBBB');
});

test('the missing table is a polite 503, not a crash', async () => {
  const s = setup();
  const real = s.db.from;
  s.db.from = (n) => (n === 'support_tickets'
    ? { select: () => ({ eq: () => ({ eq: () => ({ in: async () => ({ data: null, error: { message: 'relation "support_tickets" does not exist' } }) }) }) }) }
    : real(n));
  const r = await A.createTicket(s.deps, valid());
  assert.equal(r.status, 503);
});

// ── Evidence ────────────────────────────────────────────────────────────────

test('declared files get upload URLs bound to the new ticket', async () => {
  const s = setup();
  const r = await A.createTicket(s.deps, valid({ files: [{ name: 'cover.jpg', type: 'image/jpeg', size: 200000 }] }));
  assert.equal(r.body.uploads.length, 1);
  const u = r.body.uploads[0];
  assert.equal(T.isEvidenceKeyFor(u.key, r.body.ticket_no), true);
  assert.equal(T.isEvidenceKeyFor(u.key, 'TKT-ZZZZZZ'), false);
  assert.match(u.upload_url, /image%2Fjpeg/);
});

test('without storage the ticket still opens and says so', async () => {
  const s = setup({ r2Configured: false });
  const r = await A.createTicket(s.deps, valid({ files: [{ name: 'a.jpg', type: 'image/jpeg', size: 1000 }] }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.uploads, []);
  assert.match(r.body.evidence_error, /WhatsApp/);
});

test('attach lists only files that really landed, with the right type and size', async () => {
  const objects = {};
  const s = setup({ objects });
  const created = await A.createTicket(s.deps, valid({ files: [
    { name: 'good.jpg', type: 'image/jpeg', size: 1000 }, { name: 'missing.jpg', type: 'image/jpeg', size: 1000 },
    { name: 'huge.png', type: 'image/png', size: 1000 }, { name: 'liar.jpg', type: 'image/jpeg', size: 1000 }] }));
  const [good, missing, huge, liar] = created.body.uploads;
  objects[good.key] = { size: 5000, type: 'image/jpeg' };
  objects[huge.key] = { size: 50 * 1048576, type: 'image/png' };       // bigger than declared and allowed
  objects[liar.key] = { size: 5000, type: 'text/html' };               // stored as something else
  s.mails.length = 0;

  const r = await A.attachEvidence(s.deps, { ticket_no: created.body.ticket_no, contact: '9876543210', files: [good, missing, huge, liar] });
  assert.equal(r.status, 200);
  assert.equal(r.body.attached, 1);
  assert.equal(r.body.rejected.length, 3);
  const t = s.db.tables.support_tickets[0];
  assert.deepEqual(t.evidence.map((e) => e.name), ['good.jpg']);
  // The owner gets the small image attached.
  const mail = s.mails.find((m) => m.to === 'asfkhn234@gmail.com');
  assert.equal(mail.attachments.length, 1);
  assert.match(mail.subject, /Evidence added/);
});

test('a key minted for another ticket is never attached', async () => {
  const objects = {};
  const s = setup({ objects });
  const created = await A.createTicket(s.deps, valid());
  const foreign = `support/TKT-ZZZZZZ/${T0}-abcdef0123.jpg`;
  objects[foreign] = { size: 100, type: 'image/jpeg' };
  const r = await A.attachEvidence(s.deps, { ticket_no: created.body.ticket_no, contact: 'asha@example.com', files: [{ key: foreign, name: 'x.jpg', type: 'image/jpeg' }] });
  assert.equal(r.status, 400);
  assert.deepEqual(s.db.tables.support_tickets[0].evidence, []);
});

test('evidence needs the right contact', async () => {
  const s = setup();
  const created = await A.createTicket(s.deps, valid());
  const r = await A.signMore(s.deps, { ticket_no: created.body.ticket_no, contact: 'stranger@example.com', files: [{ name: 'a.jpg', type: 'image/jpeg', size: 10 }] });
  assert.equal(r.status, 404);
});

// ── Customer view and replies ───────────────────────────────────────────────

test('lookup shows the timeline without internal notes, and needs the contact', async () => {
  const s = setup();
  const created = await A.createTicket(s.deps, valid());
  const id = s.db.tables.support_tickets[0].id;
  await A.staffNote(s.deps, { id, body: 'customer is a repeat complainer, check courier' });
  await A.staffReply(s.deps, { id, message: 'We are checking with the courier.' });
  const r = await A.lookupTicket(s.deps, { ticket_no: created.body.ticket_no.toLowerCase(), contact: '9876543210' });
  assert.equal(r.status, 200);
  const bodies = r.body.ticket.timeline.map((e) => e.body);
  assert.ok(bodies.includes('We are checking with the courier.'));
  assert.equal(bodies.some((b) => /repeat complainer/.test(b)), false);
  assert.equal((await A.lookupTicket(s.deps, { ticket_no: created.body.ticket_no, contact: 'nobody@x.com' })).status, 404);
});

test('a customer can find their ticket numbers from the order id', async () => {
  const s = setup();
  await A.createTicket(s.deps, valid());
  const r = await A.findTickets(s.deps, { order_id: 'IC-20260930-ABCDE', contact: 'asha@example.com' });
  assert.equal(r.body.tickets.length, 1);
  assert.equal((await A.findTickets(s.deps, { order_id: 'IC-20260930-ABCDE', contact: 'x@y.com' })).status, 404);
});

test('replying to a ticket that is waiting on the customer restarts the clock with a day on it', async () => {
  const s = setup();
  const created = await A.createTicket(s.deps, valid());
  const id = s.db.tables.support_tickets[0].id;
  await A.staffReply(s.deps, { id, message: 'Please send a photo of the parcel label.', status: 'waiting_customer' });
  s.clock.now = T0 + 60 * H;     // well past the original 48h, but the ball was in their court
  const r = await A.customerReply(s.deps, { ticket_no: created.body.ticket_no, contact: 'asha@example.com', message: 'Here is the label photo.' });
  const t = s.db.tables.support_tickets[0];
  assert.equal(r.status, 200);
  assert.equal(t.status, 'in_progress');
  assert.equal(new Date(t.due_at).getTime(), T0 + 84 * H);
});

// ── Closing ────────────────────────────────────────────────────────────────

test('closing needs a resolution, closes the ticket and sends the customer that resolution', async () => {
  const s = setup();
  await A.createTicket(s.deps, valid());
  const t = s.db.tables.support_tickets[0];
  assert.equal((await A.staffClose(s.deps, { id: t.id, resolution: 'ok' })).status, 400);
  assert.equal(t.status, 'open');
  s.mails.length = 0;
  s.clock.now = T0 + 5 * H;
  const r = await A.staffClose(s.deps, { id: t.id, resolution: 'We sent a replacement copy today; AWB 14345123 — arrives in 3 days.' });
  assert.equal(r.status, 200);
  assert.equal(t.status, 'closed');
  assert.equal(new Date(t.closed_at).getTime(), T0 + 5 * H);
  assert.equal(new Date(t.first_response_at).getTime(), T0 + 5 * H);
  const mail = s.mails.find((m) => m.to === 'asha@example.com');
  assert.match(mail.subject, /closed/i);
  assert.match(mail.html, /replacement copy/);
  assert.equal((await A.staffClose(s.deps, { id: t.id, resolution: 'again again again' })).status, 409);
});

test('a closed ticket reopens on a customer reply within 7 days, not after', async () => {
  const s = setup();
  const created = await A.createTicket(s.deps, valid());
  const t = s.db.tables.support_tickets[0];
  await A.staffClose(s.deps, { id: t.id, resolution: 'Replacement sent today.' });
  s.clock.now = T0 + 3 * 24 * H;
  const re = await A.customerReply(s.deps, { ticket_no: created.body.ticket_no, contact: 'asha@example.com', message: 'It still has not arrived.' });
  assert.equal(re.body.reopened, true);
  assert.equal(t.status, 'open');
  assert.equal(t.reopened_count, 1);
  assert.equal(new Date(t.due_at).getTime(), s.clock.now + 48 * H);
  assert.equal(t.resolution, null);

  await A.staffClose(s.deps, { id: t.id, resolution: 'Chased the courier; delivered.' });
  s.clock.now += 8 * 24 * H;
  const late = await A.customerReply(s.deps, { ticket_no: created.body.ticket_no, contact: 'asha@example.com', message: 'Another problem now.' });
  assert.equal(late.status, 409);
  assert.equal(t.status, 'closed');
});

// ── The 24–48 hour promise ──────────────────────────────────────────────────

test('delay rules: waiting-on-customer and closed are never late; open and in-progress are, after 48h', () => {
  const base = { status: 'open', due_at: new Date(T0 + 48 * H).toISOString(), delay_notices: 0 };
  assert.equal(T.delayNoticeDue(base, T0 + 47 * H), false);
  assert.equal(T.delayNoticeDue(base, T0 + 48 * H), true);
  assert.equal(T.delayNoticeDue({ ...base, status: 'in_progress' }, T0 + 49 * H), true);
  assert.equal(T.delayNoticeDue({ ...base, status: 'waiting_customer' }, T0 + 99 * H), false);
  assert.equal(T.delayNoticeDue({ ...base, status: 'closed' }, T0 + 99 * H), false);
  // Repeats every further 48h, three notices at most.
  assert.equal(T.delayNoticeDue({ ...base, delay_notices: 1 }, T0 + 95 * H), false);
  assert.equal(T.delayNoticeDue({ ...base, delay_notices: 1 }, T0 + 96 * H), true);
  assert.equal(T.delayNoticeDue({ ...base, delay_notices: 3 }, T0 + 999 * H), false);
});

test('the sweep tells the customer once it is overdue, and the owner, and not twice', async () => {
  const s = setup();
  const created = await A.createTicket(s.deps, valid());
  const t = s.db.tables.support_tickets[0];
  s.mails.length = 0;

  s.clock.now = T0 + 30 * H;                      // late for a first reply, not yet for resolution
  const early = await A.runSlaSweep(s.deps);
  assert.deepEqual(early.delay_notices, []);
  assert.deepEqual(early.owner_nudges, [created.body.ticket_no]);
  assert.match(s.mails[0].subject, /No reply yet/);
  assert.equal(s.mails[0].to, 'asfkhn234@gmail.com');

  s.mails.length = 0;
  s.clock.now = T0 + 49 * H;
  const late = await A.runSlaSweep(s.deps);
  assert.deepEqual(late.delay_notices, [created.body.ticket_no]);
  const toCustomer = s.mails.find((m) => m.to === 'asha@example.com');
  assert.match(toCustomer.subject, /taking longer than expected/);
  assert.match(toCustomer.html, /sorry for the wait/);
  assert.ok(s.mails.find((m) => m.to === 'asfkhn234@gmail.com' && /OVERDUE/.test(m.subject)));
  assert.equal(t.delay_notices, 1);

  s.mails.length = 0;
  s.clock.now = T0 + 50 * H;
  const again = await A.runSlaSweep(s.deps);
  assert.deepEqual(again.delay_notices, []);
  assert.equal(s.mails.length, 0);

  s.clock.now = T0 + 97 * H;
  assert.deepEqual((await A.runSlaSweep(s.deps)).delay_notices, [created.body.ticket_no]);
});

test('a ticket that has been answered gets no owner nudge; a closed one is left alone entirely', async () => {
  const s = setup();
  await A.createTicket(s.deps, valid());
  const t = s.db.tables.support_tickets[0];
  await A.staffReply(s.deps, { id: t.id, message: 'Looking into it now.' });
  s.mails.length = 0;
  s.clock.now = T0 + 30 * H;
  assert.deepEqual((await A.runSlaSweep(s.deps)).owner_nudges, []);
  await A.staffClose(s.deps, { id: t.id, resolution: 'Sorted — refund issued.' });
  s.mails.length = 0;
  s.clock.now = T0 + 200 * H;
  const out = await A.runSlaSweep(s.deps);
  assert.equal(out.checked, 0);
  assert.equal(s.mails.length, 0);
});

test('two overlapping sweeps cannot both send the delay notice', async () => {
  const s = setup();
  await A.createTicket(s.deps, valid());
  s.mails.length = 0;
  s.clock.now = T0 + 49 * H;
  const [a, b] = await Promise.all([A.runSlaSweep(s.deps), A.runSlaSweep(s.deps)]);
  assert.equal(a.delay_notices.length + b.delay_notices.length, 1);
  assert.equal(s.mails.filter((m) => m.to === 'asha@example.com').length, 1);
});

test('a dry run sends and changes nothing', async () => {
  const s = setup();
  await A.createTicket(s.deps, valid());
  s.mails.length = 0;
  s.clock.now = T0 + 49 * H;
  const out = await A.runSlaSweep(s.deps, { dryRun: true });
  assert.equal(out.delay_notices.length, 1);
  assert.equal(s.mails.length, 0);
  assert.equal(s.db.tables.support_tickets[0].delay_notices, 0);
});

test('WhatsApp goes out only when switched on', async () => {
  const off = setup();
  await A.createTicket(off.deps, valid());
  assert.equal(off.waMsgs.length, 0);
  const on = setup({ whatsappOn: true });
  await A.createTicket(on.deps, valid());
  assert.equal(on.waMsgs[0].template, 'ticket_received');
  assert.equal(on.waMsgs[0].params[1].startsWith('TKT-'), true);
});

// ── The public handler ──────────────────────────────────────────────────────

test('the public handler: honeypot, foreign origin, and unknown actions', async () => {
  process.env.SUPABASE_URL = 'https://x.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'k';
  const { handle } = require('../support-ticket');
  const s = setup();
  const post = (body, headers = {}) => handle({ httpMethod: 'POST', headers, body: JSON.stringify(body) }, s.deps);

  const bot = await post({ ...valid(), action: 'create', website: 'http://spam.example' });
  assert.equal(bot.statusCode, 200);
  assert.equal(s.db.tables.support_tickets.length, 0, 'a bot gets a success and nothing is created');

  assert.equal((await post({ ...valid(), action: 'create' }, { origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await post({ action: 'wat' })).statusCode, 400);

  const real = await post({ ...valid(), action: 'create' }, { origin: 'https://inkandchai.in' });
  assert.equal(real.statusCode, 200);
  assert.equal(real.headers['Access-Control-Allow-Origin'], 'https://inkandchai.in');
  assert.equal(s.db.tables.support_tickets.length, 1);
});

test('the admin endpoint refuses anyone who is not an admin', async () => {
  process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-secret';
  const { handler } = require('../admin-support-tickets');
  const res = await handler({ httpMethod: 'GET', path: '/.netlify/functions/admin-support-tickets', headers: {}, queryStringParameters: {} });
  assert.equal(res.statusCode, 401);
});

test('admin: most urgent first, and evidence is served only from the ticket own keys', async () => {
  process.env.SUPABASE_URL = 'https://x.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'k';
  process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-secret';
  const { handle } = require('../admin-support-tickets');
  const s = setup();
  const mk = (n, over) => ({ id: crypto.randomUUID(), ticket_no: `TKT-AAAA${n}2`, order_id: 'o' + n, category: 'other', priority: 'normal', message: 'm', status: 'open',
    created_at: new Date(T0 + n * H).toISOString(), respond_by: new Date(T0 + 24 * H).toISOString(), due_at: new Date(T0 + 48 * H + n * H).toISOString(), evidence: [], ...over });
  const evKey = `support/TKT-AAAA42/${T0}-abcdef0123.jpg`;
  s.db.tables.support_tickets.push(mk(1, {}), mk(2, { priority: 'high' }), mk(3, { due_at: new Date(T0 - H).toISOString() }), mk(4, { evidence: [{ key: evKey, name: 'a.jpg', type: 'image/jpeg', size: 10 }, { key: 'support/TKT-OTHER9/1-abcdef0123.jpg', name: 'b.jpg', type: 'image/jpeg', size: 10 }] }));
  s.clock.now = T0 + 10 * H;
  const call = (q) => handle({ httpMethod: 'GET', headers: { 'x-admin-key': process.env.ADMIN_SECRET }, queryStringParameters: q }, s.deps);

  const list = JSON.parse((await call({ status: 'active' })).body);
  // overdue first, then high priority, then whichever is due soonest
  assert.deepEqual(list.tickets.map((t) => t.order_id), ['o3', 'o2', 'o1', 'o4']);
  assert.equal(list.tickets[0].overdue, true);
  assert.equal(list.counts.overdue, 1);

  const id = s.db.tables.support_tickets[3].id;
  const ok = await call({ evidence: id, i: '0' });
  assert.equal(ok.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(ok.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(ok.headers.get('Content-Security-Policy'), /sandbox/);
  assert.equal((await call({ evidence: id, i: '1' })).statusCode, 404, 'a key that is not this ticket\'s is never served');
  assert.equal((await call({ evidence: id, i: '7' })).statusCode, 404);
});

test('the support page offers exactly the categories the server accepts', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../../public/support/index.html'), 'utf8');
  const form = html.slice(html.indexOf('id="spForm"'), html.indexOf('id="spDone"'));
  const offered = [...form.matchAll(/<option value="([a-z_]+)">/g)].map((m) => m[1]);
  assert.deepEqual(offered.sort(), T.CATEGORIES.map((c) => c.id).sort());
});
