/**
 * Scheduled: stock-delay-notify-scheduled -- daily, 12:30 IST (jobs.toml)
 *
 * Tells a customer that a book in their order is out of stock with us and our
 * supplier, that we are still trying to arrange it, and that they can request
 * to cancel the order or remove just that book (utils/stock-delay.js has the
 * rules and the words). Email always; WhatsApp through the approved template.
 *
 * Only an order with an AWB the courier has not picked up 72+ hours after it
 * was placed, and only when the courier, asked live, says it is still waiting.
 * Once per order (KV ORDER_FALLBACK, key below, 90 days), marked only once a
 * channel actually delivered.
 *
 * CUSTOMER-FACING, so OFF until STOCK_DELAY_NOTIFY = "on" (wrangler.toml
 * [vars]). Owner POST from the admin:
 *   { dry_run?: true, order_ids?: [...] }   dry_run (the default over HTTP)
 *   lists who would get what and sends nothing; dry_run:false sends, even
 *   while the cron is off, so a first batch can go out by hand.
 *
 * WhatsApp template STOCK_DELAY_TEMPLATE (default order_stock_delay), UTILITY:
 *   body:   Hi {{1}}, an update on your Ink & Chai order {{2}}: {{3}} is out
 *           of stock with us and with our supplier. We are still trying to
 *           arrange it and will ship as soon as we can. If you would rather not
 *           wait, you can request to cancel the order or remove that book.
 *   button: URL "Cancel or change order", https://inkandchai.in/order-help/{{1}}
 *           (the dynamic part is "?o=<order>&k=<signature>").
 * Until it is approved the same text goes as a plain message, which WhatsApp
 * delivers only inside the 24-hour window -- the email still goes.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const bindings = require('../../worker/shims/runtime-bindings');
const { listNotPicked } = require('./utils/not-picked-up-list');
const { checkPickups } = require('./utils/pickup-live');
const { soldOutSlugs } = require('./utils/sold-out');
const { sendEmail } = require('./utils/email');
const { sendWhatsApp, sendText } = require('./utils/whatsapp');
const sd = require('./utils/stock-delay');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const SENT_KEY = 'stock-delay-notified:v1';
const KEEP_DAYS = 90;
const PER_RUN = 60;
const LOOK_BACK_DAYS = 30;

const enabled = () => ['on', 'true', '1', 'yes'].includes(String(process.env.STOCK_DELAY_NOTIFY || 'off').trim().toLowerCase());

async function readSent(kv) {
  if (!kv) return {};
  try {
    const all = JSON.parse((await kv.get(SENT_KEY)) || '{}');
    const cutoff = Date.now() - KEEP_DAYS * 86400e3;
    return Object.fromEntries(Object.entries(all).filter(([, at]) => Date.parse(at) > cutoff));
  } catch (e) {
    // Unreadable must not mean "nobody notified": that would message everyone
    // again. Refuse the run instead.
    throw new Error(`sent list unreadable: ${e.message}`);
  }
}

async function markSent(kv, sent, ids) {
  if (!kv || !ids.length) return;
  const at = new Date().toISOString();
  for (const id of ids) sent[id] = at;
  await kv.put(SENT_KEY, JSON.stringify(sent), { expirationTtl: KEEP_DAYS * 86400 });
}

/** Who is due, with the message each would get. Sends nothing. */
async function plan(deps = {}, { orderIds = null, now = Date.now() } = {}) {
  const db = deps.db || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const kv = 'kv' in deps ? deps.kv : bindings.get('ORDER_FALLBACK');
  const sent = await readSent(kv);
  const { orders, rows } = await (deps.listNotPicked || listNotPicked)(db, { minHours: sd.MIN_HOURS, days: LOOK_BACK_DAYS, now });
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const want = orderIds ? new Set(orderIds.map((s) => String(s).toUpperCase())) : null;

  const skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  let due = [];
  for (const o of orders) {
    const id = String(o.razorpay_order_id || o.id).toUpperCase();
    if (want && !want.has(id)) continue;
    if (sent[id]) { skip('already notified'); continue; }
    const why = sd.skipReason(rowById.get(o.id), o, now);
    if (why) { skip(why); continue; }
    due.push(o);
  }

  // The courier's own word: only "still waiting" counts. Anything else --
  // moved, delivered, unknown -- and the customer is told nothing.
  if (due.length) {
    const live = await (deps.checkPickups || checkPickups)(due);
    due = due.filter((o) => {
      const st = (live.get(o.id) || {}).state || 'unknown';
      if (st === 'waiting') return true;
      skip(st === 'unknown' ? 'courier did not answer' : `courier says ${st}`);
      return false;
    });
  }
  due = due.slice(0, PER_RUN);

  // Emails are not in the Not Picked Up columns.
  const emails = new Map();
  if (due.length) {
    const { data, error } = await db.from('orders').select('id, customer_email').in('id', due.map((o) => o.id));
    if (error) throw new Error(`email lookup failed: ${error.message}`);
    for (const r of data || []) emails.set(r.id, r.customer_email || '');
  }
  const sold = await (deps.soldOutSlugs || soldOutSlugs)(db).catch(() => new Set());
  const items = due.map((o) => ({ order: { ...o, customer_email: emails.get(o.id) || '' }, msg: sd.messageFor(o, sold) }));
  return { kv, sent, items, skipped };
}

async function deliver({ order, msg }, deps = {}) {
  const email = deps.sendEmail || sendEmail;
  const wa = deps.sendWhatsApp || sendWhatsApp;
  const text = deps.sendText || sendText;
  const out = { order: msg.id, email: null, whatsapp: null };
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(order.customer_email || '')) {
    try {
      const r = await email({ to: order.customer_email, subject: msg.subject, html: msg.html });
      out.email = r && r.ok === false ? 'failed' : 'sent';
    } catch (e) { out.email = `failed: ${e.message}`; }
  }
  if (order.customer_phone) {
    const t = await wa({
      to: order.customer_phone,
      template: process.env.STOCK_DELAY_TEMPLATE || 'order_stock_delay',
      params: msg.params,
      urlButtonParam: sd.linkQuery(msg.id),
    }).catch((e) => ({ ok: false, error: e.message }));
    if (t.ok) out.whatsapp = 'template';
    else {
      const p = await text(order.customer_phone, msg.text).catch((e) => ({ ok: false, error: e.message }));
      out.whatsapp = p.ok ? 'text' : 'failed';
    }
  }
  out.ok = out.email === 'sent' || out.whatsapp === 'template' || out.whatsapp === 'text';
  return out;
}

async function run({ dryRun = true, orderIds = null } = {}, deps = {}) {
  const { kv, sent, items, skipped } = await plan(deps, { orderIds });
  if (dryRun) {
    return {
      dry_run: true, due: items.length, skipped,
      orders: items.map(({ order, msg }) => ({
        order: msg.id, created_at: order.created_at, courier: order.courier_name, awb: order.tracking_id,
        book: msg.phrase, can_remove_book: msg.canRemove, link: msg.link, text: msg.text,
        email: !!order.customer_email, whatsapp: !!order.customer_phone,
      })),
    };
  }
  const results = [];
  for (const it of items) results.push(await deliver(it, deps));
  const delivered = results.filter((r) => r.ok).map((r) => String(r.order).toUpperCase());
  try { await markSent(kv, sent, delivered); } catch (e) { console.warn('[stock-delay] mark sent:', e.message); }
  return { dry_run: false, due: items.length, notified: delivered.length, skipped, results };
}

exports.handler = async (event = {}) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const fromCron = !!(event.headers && event.headers['x-cloudflare-cron']);
  let opts = { dryRun: true };
  if (fromCron) {
    if (!enabled()) return json(200, { ok: true, enabled: false });
    opts = { dryRun: false };
  } else {
    const block = requireAdmin(event, CORS);
    if (block) return block;
    let body = {};
    try { body = JSON.parse(event.body || '{}') || {}; } catch { body = {}; }
    opts = { dryRun: body.dry_run !== false, orderIds: Array.isArray(body.order_ids) ? body.order_ids : null };
  }
  try {
    const r = await run(opts);
    console.log('[stock-delay]', JSON.stringify({ ...r, results: undefined, orders: undefined }));
    return json(200, { enabled: enabled(), ...r });
  } catch (e) {
    console.error('[stock-delay]', e);
    return json(500, { error: e.message });
  }
};

exports._test = { plan, run, deliver, SENT_KEY };
