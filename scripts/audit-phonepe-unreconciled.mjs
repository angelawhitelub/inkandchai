#!/usr/bin/env node
/**
 * audit-phonepe-unreconciled.mjs — find orders the customer HAS paid for on
 * PhonePe but which our DB still treats as unpaid.
 *
 * IC-20260802-F9S56 was paid in full by UPI one minute after checkout, stayed
 * 'cod_pending' here, and shipped COD — so the courier was about to collect
 * ₹1,381 a second time. phonepe-reconcile only ever re-checks orders sitting on
 * status='pending_phonepe', so an order that reached any other status with a
 * completed payment behind it is invisible to it.
 *
 * PhonePe's status endpoint is keyed by our own order id, so every unpaid order
 * can simply be asked about directly. Read-only: reports, changes nothing.
 *
 *   netlify dev:exec -- node scripts/audit-phonepe-unreconciled.mjs [--days=120]
 */

import { createClient } from '@supabase/supabase-js';

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
// Anything that already carries a gateway payment id is reconciled by
// definition. Everything else in this window is a candidate.
// Supabase caps a select at 1000 rows, so page explicitly — an unpaginated
// query silently returns an arbitrary slice and the sweep quietly misses orders.
const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from('orders')
    .select('razorpay_order_id,status,amount_paise,razorpay_payment_id,tracking_id,customer_name,customer_phone,customer_email,created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .range(from, from + 999);
  if (error) throw error;
  if (!data?.length) break;
  rows.push(...data);
  if (data.length < 1000) break;
}

const candidates = (rows || []).filter(o =>
  !o.razorpay_payment_id && !['paid', 'refunded'].includes(String(o.status || '')));
console.log(`${rows.length} orders in the last ${DAYS} days — ${candidates.length} carry no payment id\n`);

const tok = await token();
const paid = [];
let checked = 0, notFound = 0, pending = 0;

for (const o of candidates) {
  const id = o.razorpay_order_id;
  if (!id) continue;
  let j = {};
  try {
    const r = await fetch(`${HOST}/pg/checkout/v2/order/${encodeURIComponent(id)}/status`,
      { headers: { Authorization: 'O-Bearer ' + tok } });
    if (r.status === 404) { notFound++; checked++; continue; }
    j = await r.json().catch(() => ({}));
  } catch (e) { console.error(`  ! ${id}: ${e.message}`); continue; }
  checked++;
  const state = String(j.state || '');
  if (state === 'COMPLETED') {
    const d = j.paymentDetails?.[0] || {};
    paid.push({ o, amountRs: (Number(j.amount) || 0) / 100, txn: d.transactionId || '', utr: d.rail?.utr || '', when: d.timestamp ? new Date(d.timestamp).toISOString() : '' });
  } else if (state) pending++;
  if (checked % 25 === 0) process.stderr.write(`  …${checked}/${candidates.length}\n`);
  await new Promise(r => setTimeout(r, 120));   // stay well inside PhonePe's rate limit
}

console.log(`checked ${checked} · no PhonePe order ${notFound} · started but not completed ${pending}\n`);
console.log(`══ PAID ON PHONEPE BUT NOT MARKED PAID HERE: ${paid.length} ══\n`);
for (const p of paid) {
  const shipping = !['cancelled', 'refunded'].includes(p.o.status);
  console.log(`  ${shipping ? '⚠' : ' '} ${p.o.razorpay_order_id}  ${p.o.customer_name || ''}  ${p.o.customer_phone || ''}`);
  console.log(`      order  : status ${p.o.status}, ₹${(p.o.amount_paise || 0) / 100}, awb ${p.o.tracking_id || '—'}, ${p.o.created_at?.slice(0, 10)}`);
  console.log(`      paid   : ₹${p.amountRs} on ${p.when.slice(0, 16)}  UTR ${p.utr}  txn ${p.txn}`);
  if (shipping && p.o.tracking_id) console.log(`      RISK   : shipment is live — the courier will collect ₹${(p.o.amount_paise || 0) / 100} a SECOND time`);
}
const dbl = paid.filter(p => p.o.tracking_id && !['cancelled', 'refunded'].includes(p.o.status));
console.log(`\nlive shipments at risk of double collection: ${dbl.length}  (₹${dbl.reduce((t, p) => t + (p.o.amount_paise || 0) / 100, 0).toLocaleString('en-IN')})`);
