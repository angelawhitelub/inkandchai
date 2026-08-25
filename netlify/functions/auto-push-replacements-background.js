/**
 * Push pending replacement orders to the NimbusPost panel.
 *
 * WHY
 * ---
 * A replacement is created free (amount_paise 0, status `replacement_pending`)
 * by three paths — the customer's replacement request, the missing-book report
 * on /track, and the admin panel — and none of them pushed it anywhere. Paid
 * orders are pushed at checkout; a replacement had no checkout, and the AWB
 * sync cron only syncs orders already in the panel. So every replacement
 * sat in admin looking handled and shipped only if somebody remembered to push
 * it by hand. On the day this was written all 19 pending replacements were
 * unpushed, the oldest four days old.
 *
 * THE GRACE WINDOW
 * ----------------
 * Pushing the instant one is created would be worse than the disease:
 * update-replacement-items refuses to edit a replacement once `nimbus_pushed_at`
 * is set, because the parcel contents must not disagree with the label. The
 * owner would lose the chance to correct a customer's claim before free books
 * go out the door. So a replacement is pushed only once it has sat untouched
 * for REPLACEMENT_PUSH_GRACE_MINUTES (default 120) — long enough to review and
 * edit, short enough that nothing waits a day. Set the env var to 0 to push as
 * soon as the sweep sees it.
 *
 * Skipped, never pushed: anything without a delivery address or without books,
 * and anything already pushed or already carrying an AWB (pushToNimbusOnce
 * claims `nimbus_pushed_at` first, so a concurrent manual push cannot produce a
 * second shipment).
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { pushToNimbusOnce } = require('./utils/nimbus-push-once');

const CORS = { 'Content-Type': 'application/json' };
const DEFAULT_GRACE_MINUTES = 120;
const MAX_PER_RUN = 40;

function graceMinutes() {
  const raw = process.env.REPLACEMENT_PUSH_GRACE_MINUTES;
  if (raw === undefined || raw === '') return DEFAULT_GRACE_MINUTES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_GRACE_MINUTES;
}

// A replacement is only shippable when we know where to send it and what to put
// in the box. Both are cheap to check here and expensive to get wrong at the
// courier, which rejects the order and leaves the claim released.
function shippable(order) {
  const address = String(order.customer_address || '').trim();
  if (!address) return 'no delivery address';
  if (!/\d{6}/.test(address)) return 'address has no 6-digit pincode';
  if (!Array.isArray(order.cart_items) || !order.cart_items.length) return 'no books on the replacement';
  return '';
}

async function runSweep(supabase, { dryRun = false } = {}) {
  const cutoff = new Date(Date.now() - graceMinutes() * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('status', 'replacement_pending')
    .is('nimbus_pushed_at', null)
    .is('tracking_id', null)
    .lte('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(MAX_PER_RUN);
  if (error) throw new Error(error.message);

  const out = { considered: (data || []).length, pushed: [], skipped: [], failed: [], dry_run: dryRun };

  for (const order of data || []) {
    const id = order.razorpay_order_id || order.id;
    const why = shippable(order);
    if (why) { out.skipped.push({ id, reason: why }); continue; }
    if (dryRun) { out.pushed.push(id); continue; }

    const res = await pushToNimbusOnce(supabase, order);
    if (res.pushed) out.pushed.push(id);
    else if (res.reason === 'already_pushed') out.skipped.push({ id, reason: 'already pushed' });
    else out.failed.push({ id, reason: res.error || res.reason });
  }

  console.log(`[replacement-push] considered ${out.considered} · pushed ${out.pushed.length} · skipped ${out.skipped.length} · failed ${out.failed.length}`);
  return out;
}

exports.handler = async (event) => {
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;

  let dryRun = false;
  try { dryRun = !!JSON.parse(event.body || '{}').dry_run; } catch {}

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const result = await runSweep(supabase, { dryRun });
    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
  } catch (err) {
    console.error('[replacement-push] sweep failed:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

exports._runSweep = runSweep;
exports._shippable = shippable;
