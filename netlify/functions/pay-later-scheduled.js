/**
 * Scheduled function: pay-later-scheduled   (hourly, jobs.toml)
 *
 * Pay Later (utils/pay-later) after delivery:
 *   1. a delivered, unpaid Pay Later order with no link yet → Razorpay link
 *      created and emailed (Razorpay also SMSes it), due DUE_DAYS later;
 *   2. a link already out → asked whether it was paid (the webhook is the
 *      fast path; this is the net under it);
 *   3. past the due date and still unpaid → marked overdue, owner told once.
 * AutoPay (utils/pay-later-mandate): an order with an active mandate is
 * charged on the day it is delivered instead of being sent a link; the link
 * goes out only if there is no mandate or the debit fails. A bank mandate still
 * waiting for the bank is checked each hour first.
 * Only touches orders whose cart says mode 'pay_later'. Admin may POST to run now.
 */
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const PL = require('./utils/pay-later');
const notify = require('./utils/pay-later-notify');
const { sendPayLaterLink, syncLink, saveMeta } = require('./utils/pay-later-link');
const Mandate = require('./utils/pay-later-mandate');

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
  const out = { links_sent: [], charged: [], paid: [], overdue: [], errors: [] };
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
        const md = meta.mandate || {};
        if (md.status === 'pending') await (deps.refreshMandate || Mandate.refreshMandate)(db, order, deps);
        const fresh = md.status === 'pending' ? await reload(db, order) : order;
        const mm = (PL.payLaterMeta(fresh) || {}).mandate || {};
        // AutoPay: charge on the delivery day; Razorpay debits after its notice.
        if (mm.status === 'active' && !mm.charge_order_id && !meta.link_url) {
          const r = await (deps.chargeMandate || Mandate.chargeMandate)(db, fresh, deps);
          if (r.ok) { out.charged.push(id); await saveMeta(db, await reload(db, fresh), (m) => ({ ...m, state: 'autopay_charged', due_at: m.due_at || PL.dueDate(new Date(now).toISOString()) })); continue; }
          out.errors.push(`${id}: AutoPay ${r.error}`);
        } else if (mm.charge_status === 'pending') {
          const s = await (deps.syncCharge || Mandate.syncCharge)(db, fresh, { ...deps, now });
          if (s.paid) { out.paid.push(id); continue; }
          if (!s.failed) continue; // still inside Razorpay's retry days
          // Failed for good: fall through to the payment link.
        }
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

async function reload(db, order) {
  const { data } = await db.from('orders').select('*').eq('id', order.id).limit(1);
  return (data && data[0]) || order;
}

exports.handler = (event) => handle(event);
exports._test = { handle };
