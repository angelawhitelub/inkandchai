#!/usr/bin/env node
/**
 * Close orders that are stuck in the refund loop but never took any money.
 *
 * Orders are pre-inserted at checkout (phonepe-create-order) BEFORE the customer
 * pays. When the payment then FAILED, the webhook cancelled the row but also
 * wrote the failed attempt's transaction id into razorpay_payment_id. The refund
 * cron sweeps (status in OWED_STATUSES) + (payment id is not a Razorpay 'pay_'
 * id), so those rows were submitted for refund on every run and rejected every
 * time with "Order not in completed state" — 89 of them by 2026-08-09. They show
 * as REFUND FAILED in the admin panel, which buries genuine refund failures.
 *
 * This script does NOT trust that error message on its own. For every candidate
 * it asks PhonePe for the order's real state and only closes the row when
 * PhonePe confirms the payment never completed AND no refund exists. Anything
 * ambiguous is reported and left exactly as it is.
 *
 * Usage (env comes from Netlify):
 *   netlify dev:exec node scripts/close-never-paid-orders.mjs            # dry run
 *   netlify dev:exec node scripts/close-never-paid-orders.mjs --apply    # write
 *
 * A rollback snapshot of every row it is about to change is written to
 * /tmp/never-paid-rollback-<stamp>.json before the first write.
 */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getOrderStatus, refundStateFromOrder } = require('../netlify/functions/utils/phonepe-core.js');
const { PAYMENT_FAILED_REASON, NEVER_CAPTURED_ERROR } =
  require('../netlify/functions/utils/payment-failed.js');

// APPLY=1 as well as --apply: `netlify dev:exec` swallows unknown flags before
// they reach the script, so the env var is the form that actually works there.
const APPLY = process.argv.includes('--apply') || process.env.APPLY === '1';
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing — run through `netlify dev:exec`.');
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Supabase caps an unpaginated select at 1000 rows.
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

const STUCK_STATUSES = ['refund_failed', 'refund_pending'];

const rows = await fetchAll(() => db.from('orders').select('*').in('status', STUCK_STATUSES));
const candidates = rows.filter(o => NEVER_CAPTURED_ERROR.test(String(o.refund_last_error || '')));

console.log(`${rows.length} orders in ${STUCK_STATUSES.join('/')}; `
          + `${candidates.length} rejected as "not in completed state".\n`);
if (!candidates.length) { console.log('Nothing to do.'); process.exit(0); }

const toClose = [];
const leaveAlone = [];

for (const o of candidates) {
  const displayId = o.razorpay_order_id || o.id;
  let res;
  try {
    res = await getOrderStatus(displayId);
  } catch (e) {
    leaveAlone.push({ displayId, why: `status lookup threw: ${e.message}` });
    continue;
  }
  const state = String(res?.data?.state || res?.data?.status || '').toUpperCase();
  const refundState = refundStateFromOrder(res?.data);

  // Only ever close on a positive, unambiguous answer from PhonePe.
  if (!res.ok && res.status !== 404) {
    leaveAlone.push({ displayId, why: `lookup HTTP ${res.status}` });
  } else if (refundState) {
    // A refund exists at the gateway — this is NOT a never-paid order.
    leaveAlone.push({ displayId, why: `gateway shows a refund (${refundState})` });
  } else if (state === 'COMPLETED' || state === 'SUCCESS' || state === 'PAID') {
    leaveAlone.push({ displayId, why: `gateway says the payment COMPLETED — genuinely owed` });
  } else if (state === 'FAILED' || state === 'DECLINED' || state === 'EXPIRED'
             || state === 'PENDING' || res.status === 404 || !state) {
    toClose.push({ order: o, displayId, state: state || (res.status === 404 ? 'NOT_FOUND' : 'UNKNOWN') });
  } else {
    leaveAlone.push({ displayId, why: `unrecognised gateway state "${state}"` });
  }
  await new Promise(r => setTimeout(r, 120));   // gentle pacing vs PhonePe
}

console.log(`Will close ${toClose.length}; leaving ${leaveAlone.length} alone.\n`);
for (const { displayId, state, order } of toClose) {
  console.log(`  close  ${displayId}  ₹${(order.amount_paise || 0) / 100}  gateway=${state}  attempts=${order.refund_attempts}`);
}
if (leaveAlone.length) {
  console.log('\nLeft untouched (check these by hand):');
  for (const l of leaveAlone) console.log(`  keep   ${l.displayId}  — ${l.why}`);
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to make these changes.');
  process.exit(0);
}
if (!toClose.length) { console.log('\nNothing to write.'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const rollbackPath = `/tmp/never-paid-rollback-${stamp}.json`;
writeFileSync(rollbackPath, JSON.stringify(toClose.map(t => t.order), null, 2));
console.log(`\nRollback snapshot: ${rollbackPath}`);

let ok = 0, failed = 0;
for (const { order, displayId } of toClose) {
  // Close it as what it always was: a checkout whose payment failed. Clearing
  // the payment id is what actually keeps it out of the refund sweep, since that
  // sweep keys off "has a non-Razorpay payment id".
  const { error } = await db.from('orders').update({
    status: 'cancelled',
    razorpay_payment_id: null,
    refund_state: null,
    refund_id: null,
    refund_last_error: null,
    cancellation_reason: PAYMENT_FAILED_REASON,
    cancelled_at: order.cancelled_at || order.created_at,
  }).eq('id', order.id);
  if (error) { failed++; console.error(`  FAILED ${displayId}: ${error.message}`); }
  else ok++;
}
console.log(`\nClosed ${ok}; ${failed} errors.`);
