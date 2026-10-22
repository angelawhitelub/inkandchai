/**
 * Netlify Function: admin-support-tickets   (admin)
 *
 *   GET  ?status=active|waiting|closed|all&q=…   → { tickets, counts }
 *   GET  ?id=<uuid>                              → { ticket, events, order }
 *   GET  ?evidence=<uuid>&i=<n>                  → the n-th attached file, streamed
 *   POST { action:'reply',  id, message, status? }     emails the customer
 *   POST { action:'note',   id, body }                 internal, never shown to the customer
 *   POST { action:'status', id, status }               open | in_progress | waiting_customer
 *   POST { action:'close',  id, resolution }           emails the customer the resolution
 *   POST { action:'reopen', id }
 *
 * Evidence lives in a private bucket and is served only here, behind the admin
 * session, with headers that stop a hostile upload from running as a page.
 */

const { requireAdmin } = require('./utils/admin-auth');
const T = require('./utils/support-ticket');
const A = require('./utils/support-ticket-actions');
const D = require('./utils/support-ticket-deps');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decorate(t, now) {
  return { ...t, overdue: T.isOverdue(t, now), category_label: (T.CATEGORY_BY_ID[t.category] || {}).label || t.category, evidence_count: (t.evidence || []).length };
}

async function list(deps, q, now) {
  const { data, error } = await deps.db.from('support_tickets')
    .select('id,ticket_no,order_id,customer_name,customer_email,customer_phone,category,priority,message,status,created_at,respond_by,due_at,first_response_at,closed_at,evidence,delay_notices,last_customer_at,last_staff_at,reopened_count')
    .order('created_at', { ascending: false }).limit(500);
  if (error) {
    if (A.MISSING_TABLE.test(error.message || '')) return json(200, { tickets: [], counts: null, table_missing: true });
    return json(500, { error: error.message });
  }
  const all = (data || []).map((t) => decorate(t, now));
  const counts = { active: 0, waiting: 0, closed: 0, overdue: 0, unanswered: 0 };
  for (const t of all) {
    if (t.status === 'closed') counts.closed += 1;
    else if (t.status === 'waiting_customer') counts.waiting += 1;
    else counts.active += 1;
    if (t.overdue) counts.overdue += 1;
    if (t.status === 'open' && !t.first_response_at) counts.unanswered += 1;
  }
  const status = String(q.status || 'active');
  const needle = String(q.q || '').trim().toLowerCase();
  let rows = all.filter((t) => status === 'all' || (status === 'closed' ? t.status === 'closed'
    : status === 'waiting' ? t.status === 'waiting_customer' : (t.status === 'open' || t.status === 'in_progress')));
  if (needle) {
    rows = rows.filter((t) => [t.ticket_no, t.order_id, t.customer_name, t.customer_email, t.customer_phone, t.message]
      .some((v) => String(v || '').toLowerCase().includes(needle)));
  }
  // Most urgent first: overdue, then high priority, then the one due soonest.
  if (status !== 'closed' && status !== 'all') {
    rows.sort((a, b) => (b.overdue - a.overdue) || ((b.priority === 'high') - (a.priority === 'high')) || (new Date(a.due_at) - new Date(b.due_at)));
  }
  return json(200, { tickets: rows.map(({ message, ...t }) => ({ ...t, preview: String(message || '').slice(0, 140) })), counts });
}

async function detail(deps, id, now) {
  const { data: ticket, error } = await deps.db.from('support_tickets').select('*').eq('id', id).maybeSingle();
  if (error) return json(500, { error: error.message });
  if (!ticket) return json(404, { error: 'Ticket not found' });
  const events = await A.loadEvents(deps, ticket.id);
  const { data: order } = await deps.db.from('orders').select('razorpay_order_id,status,courier_name,tracking_id,amount_paise,razorpay_payment_id,cart_items,created_at,refund_state')
    .eq('razorpay_order_id', ticket.order_id).limit(1).maybeSingle();
  return json(200, {
    ticket: decorate(ticket, now),
    events: events.map((e) => ({ ...e, attachments: (e.attachments || []).map((a) => ({ name: a.name, type: a.type, size: a.size, index: (ticket.evidence || []).findIndex((x) => x.key === a.key) })) })),
    order: order ? {
      id: order.razorpay_order_id, status: order.status, courier: order.courier_name, awb: order.tracking_id,
      amount: Math.round((Number(order.amount_paise) || 0) / 100), prepaid: !!order.razorpay_payment_id, refund_state: order.refund_state || null,
      items: (Array.isArray(order.cart_items) ? order.cart_items : []).filter((i) => i && i.title).map((i) => ({ title: i.title, qty: i.qty || 1 })),
    } : null,
  });
}

async function evidence(deps, id, index) {
  if (!deps.r2 || !deps.r2.configured) return json(503, { error: 'Storage is not configured' });
  const { data: ticket } = await deps.db.from('support_tickets').select('ticket_no,evidence').eq('id', id).maybeSingle();
  const file = ticket && Array.isArray(ticket.evidence) ? ticket.evidence[index] : null;
  // The key must be one this ticket minted, whatever the row says.
  if (!file || !T.isEvidenceKeyFor(file.key, ticket.ticket_no)) return json(404, { error: 'No such file' });
  const got = await deps.r2.get(file.key);
  if (!got || !got.ok) return json(404, { error: 'File not found in storage' });
  const bytes = Buffer.from(got.body);
  const type = T.EVIDENCE_TYPES[file.type] ? file.type : 'application/octet-stream';
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': type,
      'Content-Length': String(bytes.length),
      'Content-Disposition': `inline; filename="${T.cleanFileName(file.name).replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:; media-src 'self'",
    },
  });
}

async function handle(event, injected) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return json(500, { error: 'Supabase is not configured.' });
  const deps = injected || D.realDeps();
  const now = deps.now ? deps.now() : Date.now();

  try {
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      if (q.evidence) {
        if (!UUID.test(q.evidence)) return json(400, { error: 'Bad id' });
        return await evidence(deps, q.evidence, Number(q.i));
      }
      if (q.id) {
        if (!UUID.test(q.id)) return json(400, { error: 'Bad id' });
        return await detail(deps, q.id, now);
      }
      return await list(deps, q, now);
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    if (!UUID.test(String(body.id || ''))) return json(400, { error: 'Bad id' });
    const run = { reply: A.staffReply, note: A.staffNote, status: A.staffSetStatus, close: A.staffClose, reopen: A.staffReopen }[body.action];
    if (!run) return json(400, { error: 'Unknown action' });
    const res = await run(deps, body);
    return json(res.status, res.body);
  } catch (e) {
    console.error('[admin-support-tickets]', e);
    return json(500, { error: e.message });
  }
}

exports.handler = (event) => handle(event);
exports.handle = handle;
