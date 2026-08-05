#!/usr/bin/env node
/**
 * fix-phonepe-unreconciled.mjs — write the PhonePe payment back onto orders
 * that were paid in full but are still recorded as unpaid.
 *
 * Every order is re-verified against PhonePe's status API at the moment of the
 * write; nothing is trusted from a list. Only orders whose state is COMPLETED
 * and whose paid amount matches the order amount are touched.
 *
 * This does NOT stop the courier collecting COD — the AWB already carries a COD
 * instruction and only NimbusPost can change that. It fixes our own records so
 * nothing downstream keeps treating a paid order as COD.
 *
 * Deliberately does NOT notify anyone: these customers already have a payment
 * receipt, and a second "payment received" mail days later would confuse.
 *
 *   netlify dev:exec -- node scripts/fix-phonepe-unreconciled.mjs          # dry run
 *   netlify dev:exec -- node scripts/fix-phonepe-unreconciled.mjs --apply
 */

import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');
const DAYS = Number((process.argv.find(a => a.startsWith('--days=')) || '').split('=')[1]) || 120;
const HOST = process.env.PHONEPE_HOST || 'https://api.phonepe.com/apis';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function token() {
  const body = new URLSearchParams({
    client_id: process.env.PHONEPE_CLIENT_ID,
    client_secret: process.env.PHONEPE_CLIENT_SECRET,
    client_version: process.env.PHONEPE_CLIENT_VERSION || '1',
    grant_type: 'client_credentials',
  });
  const r = await fetch(`${HOST}/identity-manager/v1/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('PhonePe OAuth failed: ' + JSON.stringify(j));
  return j.access_token;
}

const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
// Supabase caps a select at 1000 rows, so page explicitly — an unpaginated
// query silently returns an arbitrary slice and the sweep quietly misses orders.
const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from('orders')
    .select('id,razorpay_order_id,status,amount_paise,razorpay_payment_id,tracking_id,customer_name,created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .range(from, from + 999);
  if (error) throw error;
  if (!data?.length) break;
  rows.push(...data);
  if (data.length < 1000) break;
}
const candidates = (rows || []).filter(o =>
  o.razorpay_order_id && !o.razorpay_payment_id && !['paid', 'refunded'].includes(String(o.status || '')));

const tok = await token();
let fixed = 0, skippedAmount = 0, notPaid = 0, failed = 0;

for (const o of candidates) {
  let j = {};
  try {
    const r = await fetch(`${HOST}/pg/checkout/v2/order/${encodeURIComponent(o.razorpay_order_id)}/status`,
      { headers: { Authorization: 'O-Bearer ' + tok } });
    if (r.status === 404) { notPaid++; continue; }
    j = await r.json().catch(() => ({}));
  } catch (e) { console.error(`  ! ${o.razorpay_order_id}: ${e.message}`); failed++; continue; }
  await new Promise(r => setTimeout(r, 120));

  if (String(j.state || '') !== 'COMPLETED') { notPaid++; continue; }

  const paidPaise = Number(j.amount) || 0;
  // Never mark an order paid on a part payment — a partial-COD deposit would
  // otherwise be recorded as settlement of the whole order.
  if (paidPaise < Number(o.amount_paise || 0)) {
    console.log(`  ~ ${o.razorpay_order_id} — PhonePe has ₹${paidPaise / 100} against an order of ₹${(o.amount_paise || 0) / 100}, leaving alone`);
    skippedAmount++;
    continue;
  }

  const d = j.paymentDetails?.[0] || {};
  const txn = d.transactionId || j.orderId || '';
  console.log(`  ${APPLY ? '✓' : '·'} ${o.razorpay_order_id}  ${o.customer_name || ''}  ₹${paidPaise / 100}  txn ${txn}  utr ${d.rail?.utr || '—'}  (was ${o.status})`);

  if (APPLY) {
    // Keep the shipping status — these are already dispatched. Only the payment
    // facts change, so the order stops reading as COD everywhere.
    const patch = { razorpay_payment_id: txn, shipment_payment_type: 'prepaid' };
    if (['cod_pending', 'pending_phonepe', 'confirmed', 'partial_cod_pending'].includes(String(o.status || ''))) {
      patch.status = 'paid';
    }
    const { error: uErr } = await sb.from('orders').update(patch).eq('id', o.id);
    if (uErr) { console.error(`    ✗ update failed: ${uErr.message}`); failed++; continue; }
  }
  fixed++;
}

console.log(`\n${APPLY ? 'updated' : 'would update'}: ${fixed}   amount mismatch left alone: ${skippedAmount}   no completed payment: ${notPaid}   failed: ${failed}`);
if (!APPLY) console.log('\n(dry run — pass --apply)');
