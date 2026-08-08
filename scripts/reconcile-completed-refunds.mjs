#!/usr/bin/env node
/**
 * Mark orders 'refunded' when PhonePe confirms the refund already COMPLETED.
 *
 * Retries used to mint `REFUND-<order>-<Date.now()>` and overwrite
 * orders.refund_id, so a refund that succeeded under an earlier id became
 * invisible and the order sat at refund_failed forever. For some orders the
 * STORED id is itself the one that completed — the success simply was never
 * detected. Those can be corrected with certainty: ask PhonePe about every
 * merchant refund id the order could have used (utils/refund-id.js) and only
 * write when one of them comes back COMPLETED.
 *
 * Sends NO customer notification. Several of these completed weeks ago and a
 * "your refund is on its way" message now would be worse than silence; whether
 * to tell anyone is a separate, deliberate decision.
 *
 * Usage:
 *   netlify dev:exec node scripts/reconcile-completed-refunds.mjs           # dry run
 *   APPLY=1 netlify dev:exec node scripts/reconcile-completed-refunds.mjs   # write
 *
 * (`netlify dev:exec` swallows unknown --flags, hence the env var.)
 */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getRefundStatus } = require('../netlify/functions/utils/phonepe-core.js');
const { knownRefundIds } = require('../netlify/functions/utils/refund-id.js');

const APPLY = process.argv.includes('--apply') || process.env.APPLY === '1';
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing — run through `netlify dev:exec`.');
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

const rows = await fetchAll(() => db.from('orders').select('*')
  .in('status', ['refund_failed', 'refund_pending']));
console.log(`${rows.length} orders in refund_failed/refund_pending — checking every known refund id…\n`);

const completed = [];
const other = [];

for (const o of rows) {
  const displayId = o.razorpay_order_id || o.id;
  let hit = null;
  for (const rid of knownRefundIds(o)) {
    let s;
    try { s = await getRefundStatus(rid); } catch { continue; }
    const state = String(s.state || s.data?.state || '').toUpperCase();
    if (state === 'COMPLETED') {
      hit = { rid, gatewayRef: s.data?.refundId || null, amount: s.data?.amount ?? null };
      break;
    }
    await new Promise(r => setTimeout(r, 80));
  }
  if (hit) completed.push({ order: o, displayId, ...hit });
  else other.push(displayId);
  await new Promise(r => setTimeout(r, 80));
}

console.log(`CONFIRMED COMPLETED at PhonePe: ${completed.length}`);
for (const c of completed) {
  const asked = (c.order.amount_paise || 0) / 100;
  const got = c.amount != null ? c.amount / 100 : null;
  const flag = got != null && Math.round(got * 100) !== Math.round(asked * 100) ? '  ⚠ AMOUNT DIFFERS' : '';
  console.log(`  ${c.displayId}  ₹${got ?? '?'} refunded (order ₹${asked})  ${c.rid}  gw=${c.gatewayRef || '-'}${flag}`);
}
console.log(`\nnot confirmed, left untouched: ${other.length}`);

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with APPLY=1.'); process.exit(0); }
if (!completed.length) { console.log('\nNothing to write.'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const rollbackPath = `/tmp/completed-refunds-rollback-${stamp}.json`;
writeFileSync(rollbackPath, JSON.stringify(completed.map(c => c.order), null, 2));
console.log(`\nRollback snapshot: ${rollbackPath}`);

let ok = 0, failed = 0;
for (const c of completed) {
  // Full vs partial: PhonePe's own refunded amount decides, not our assumption.
  const refunded = c.amount != null ? Number(c.amount) : Number(c.order.amount_paise || 0);
  const isFull = refunded >= Number(c.order.amount_paise || 0);
  const payload = {
    status: isFull ? 'refunded' : 'partially_refunded',
    refund_state: 'COMPLETED',
    refund_id: c.rid,                 // the id that actually completed
    refund_last_error: null,
    refund_updated_at: new Date().toISOString(),
  };
  if (c.gatewayRef) payload.phonepe_refund_id = c.gatewayRef;
  let { error } = await db.from('orders').update(payload).eq('id', c.order.id);
  // sql/orders_phonepe_refund_id.sql may not have been run yet.
  if (error && /phonepe_refund_id/i.test(error.message || '')) {
    const { phonepe_refund_id, ...withoutRef } = payload;
    ({ error } = await db.from('orders').update(withoutRef).eq('id', c.order.id));
  }
  if (error) { failed++; console.error(`  FAILED ${c.displayId}: ${error.message}`); }
  else ok++;
}
console.log(`\nCorrected ${ok}; ${failed} errors. No customer notifications sent.`);
