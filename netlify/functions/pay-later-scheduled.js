/**
 * Scheduled function: pay-later-scheduled   (hourly, jobs.toml)
 *
 * Pay Later (utils/pay-later) after delivery:
 *   1. a delivered, unpaid Pay Later order with no link yet → Razorpay link
 *      created and emailed (Razorpay also SMSes it), due DUE_DAYS later;
 *   2. a link already out → asked whether it was paid (the webhook is the
 *      fast path; this is the net under it);
 *   3. past the due date and still unpaid → marked overdue, owner told once.
 * Only touches orders whose cart says mode 'pay_later'. Admin may POST to run now.
 */
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const PL = require('./utils/pay-later');
const notify = require('./utils/pay-later-notify');
const { sendPayLaterLink, syncLink, saveMeta } = require('./utils/pay-later-link');

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function handle(event = {}, deps = {}) {
  if (event.rawUrl && !deps.skipAuth) {
    const blocked = requireAdmin(event, { 'Content-Type': 'application/json' });
    if (blocked) return blocked;
  }
  const db = deps.db || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const now = deps.now || Date.now();
  const out = { links_sent: [], paid: [], overdue: [], errors: [] };
  try {
    const { data, error } = await db.from('orders').select('*')
      .eq('cart_items->0->_payment->>mode', 'pay_later')
      .eq('status', 'delivered')
      .is('razorpay_payment_id', null)
      .order('created_at', { ascending: true })
      .limit(300);
    if (error) throw new Error(error.message);

    const overdueNow = [];
    for (const order of data || []) {
      if (!PL.isUnpaidPayLater(order)) continue;
      const id = order.razorpay_order_id;
      const meta = PL.payLaterMeta(order) || {};
      try {
        if (!meta.link_url) {
          const r = await sendPayLaterLink(db, order, deps);
          if (r.ok) out.links_sent.push(id); else out.errors.push(`${id}: ${r.error}`);
          continue;
        }
        const s = await syncLink(db, order, deps);
        if (s.ok && !s.skipped && !s.status) { out.paid.push(id); continue; }
        if (meta.due_at && Date.parse(meta.due_at) < now && meta.state !== 'overdue') {
          const saved = await saveMeta(db, order, (m) => ({ ...m, state: 'overdue', overdue_at: new Date(now).toISOString() }));
          if (saved) { out.overdue.push(id); overdueNow.push(`${id} · ₹${Math.round(order.amount_paise / 100)} · ${order.customer_name || ''} ${order.customer_phone || ''}`); }
        }
      } catch (e) {
        out.errors.push(`${id}: ${e.message}`);
      }
    }
    if (overdueNow.length) await (deps.ownerAlert || notify.ownerAlert)(`⏰ Pay Later overdue (${overdueNow.length}):\n${overdueNow.join('\n')}`);
    if (out.errors.length) console.warn('[pay-later] errors', out.errors);
    console.log(`[pay-later] links ${out.links_sent.length}, paid ${out.paid.length}, overdue ${out.overdue.length}`);
    return json(200, { ok: true, ...out });
  } catch (e) {
    console.error('[pay-later]', e.message);
    return json(500, { error: e.message });
  }
}

exports.handler = (event) => handle(event);
exports._test = { handle };
