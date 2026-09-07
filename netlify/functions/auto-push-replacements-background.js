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
 * go out the door. So a customer-raised replacement is pushed only once it has
 * sat untouched for REPLACEMENT_PUSH_GRACE_MINUTES (default 120) — long enough
 * to review and edit, short enough that nothing waits a day. Set the env var to
 * 0 to push as soon as the sweep sees it.
 *
 * The window does NOT apply to a replacement the owner created in the admin
 * panel: they picked the books themselves, so there is no claim to review, and
 * making them wait two hours was the whole complaint. Those are pushed inline
 * by admin-create-replacement; this sweep is the safety net that catches one
 * whose inline push failed, on the next run rather than two hours later.
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

// Skip reasons that resolve themselves: the first clears when the edit window
// closes, the second means the work is already done. Everything else is a
// replacement that will be skipped again on every future run, forever, which is
// the thing worth shouting about. Named, so the summary below cannot drift from
// the strings actually pushed.
const SKIP_WAITING = 'still inside the edit window';
const SKIP_DONE = 'already pushed';
const SELF_RESOLVING = new Set([SKIP_WAITING, SKIP_DONE]);

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

// The owner creating a replacement from the admin panel IS the review — there
// is no customer claim left to check — so those skip the edit window. Anything
// else (customer request, missing-book report on /track) still gets it.
function isOwnerCreated(order) {
  const cart = Array.isArray(order.cart_items) ? order.cart_items : [];
  const meta = (cart[0] || {})._replacement || {};
  return String(meta.created_by || '').toLowerCase() === 'admin';
}

async function runSweep(supabase, { dryRun = false } = {}) {
  const cutoff = new Date(Date.now() - graceMinutes() * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('status', 'replacement_pending')
    .is('nimbus_pushed_at', null)
    .is('tracking_id', null)
    .order('created_at', { ascending: true })
    .limit(MAX_PER_RUN);
  if (error) throw new Error(error.message);

  const out = { considered: (data || []).length, pushed: [], skipped: [], failed: [], dry_run: dryRun };

  for (const order of data || []) {
    const id = order.razorpay_order_id || order.id;
    // How long it has been sitting. The difference between "45 minutes old, of
    // course it hasn't gone" and "three days old and still skipped" is the
    // whole diagnosis, and it is not recoverable from a count.
    const created = order.created_at ? new Date(order.created_at).getTime() : NaN;
    const ageMinutes = Number.isFinite(created) ? Math.round((Date.now() - created) / 60000) : null;

    const why = shippable(order);
    if (why) { out.skipped.push({ id, reason: why, age_minutes: ageMinutes }); continue; }
    if (!isOwnerCreated(order) && String(order.created_at || '') > cutoff) {
      out.skipped.push({ id, reason: SKIP_WAITING, age_minutes: ageMinutes });
      continue;
    }
    if (dryRun) { out.pushed.push(id); continue; }

    const res = await pushToNimbusOnce(supabase, order);
    if (res.pushed) out.pushed.push(id);
    else if (res.reason === 'already_pushed') out.skipped.push({ id, reason: SKIP_DONE, age_minutes: ageMinutes });
    else out.failed.push({ id, reason: res.error || res.reason, age_minutes: ageMinutes });
  }

  // The counts alone cannot tell "waiting, will go by itself" from "stuck, will
  // never go", and only one of those needs a human. A replacement that fails
  // shippable() is skipped silently on every run with nothing anywhere saying
  // why -- it just sits in the Replacements tab looking pending. So: group the
  // reasons onto the summary line, then name the stuck ones individually.
  const byReason = new Map();
  for (const s of out.skipped) byReason.set(s.reason, (byReason.get(s.reason) || 0) + 1);
  const grouped = [...byReason].map(([reason, n]) => `${n}× ${reason}`).join(', ');

  console.log(`[replacement-push] considered ${out.considered} · pushed ${out.pushed.length}`
    + ` · skipped ${out.skipped.length} · failed ${out.failed.length}`
    + (grouped ? ` — skips: ${grouped}` : ''));

  for (const s of out.skipped) {
    if (SELF_RESOLVING.has(s.reason)) continue;
    console.warn(`[replacement-push] ${s.id} will NOT push on its own`
      + `${s.age_minutes === null ? '' : ` (${s.age_minutes} min old)`}: ${s.reason}`);
  }
  // Failures already log the courier's own message from pushToNimbusOnce; this
  // repeats only the id under this prefix so one grep gets the whole run.
  for (const f of out.failed) {
    console.error(`[replacement-push] ${f.id} push failed: ${f.reason}`);
  }

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
exports._isOwnerCreated = isOwnerCreated;
