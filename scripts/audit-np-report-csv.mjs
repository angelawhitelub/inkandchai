#!/usr/bin/env node
/**
 * audit-np-report-csv.mjs — take a NimbusPost B2C order-report CSV and check
 * every row marked `prepaid` against our own payment records.
 *
 * The panel's Payment Type is the only thing standing between a COD order and
 * the courier collecting nothing at the door, and it is set at push time from
 * whatever the order row happened to say then. This re-derives the truth from
 * captured money — a Razorpay/PhonePe payment id, or a partial-COD balance —
 * and reports every row where the panel disagrees.
 *
 *   netlify dev:exec -- node scripts/audit-np-report-csv.mjs <report.csv>
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const file = process.argv[2];
if (!file) { console.error('usage: audit-np-report-csv.mjs <report.csv>'); process.exit(1); }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Minimal RFC4180 splitter — these reports quote addresses containing commas.
function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim());
const head = splitCsvLine(lines[0]);
const col = (name) => head.indexOf(name);
const iId = col('Order ID*'), iAmt = col('Order Amount'), iColl = col('Collectable Amount'),
      iType = col('Payment Type*'), iStatus = col('Status'), iIvr = col('IVR Status');

const rows = lines.slice(1).map(l => {
  const c = splitCsvLine(l);
  return {
    id: String(c[iId] || '').trim().toUpperCase(),
    amount: Number(c[iAmt]) || 0,
    collectable: Number(c[iColl]) || 0,
    type: String(c[iType] || '').trim().toLowerCase(),
    status: String(c[iStatus] || '').trim(),
    ivr: String(c[iIvr] || '').trim(),
  };
}).filter(r => r.id);

console.log(`${rows.length} rows in the report — ${rows.filter(r => r.type === 'prepaid').length} marked prepaid\n`);

const { data: orders } = await sb.from('orders')
  .select('razorpay_order_id,status,amount_paise,advance_paid_paise,razorpay_payment_id,cart_items,created_at,customer_name')
  .in('razorpay_order_id', rows.map(r => r.id));
const byId = new Map((orders || []).map(o => [String(o.razorpay_order_id).toUpperCase(), o]));

const meta = (o) => (Array.isArray(o.cart_items) ? o.cart_items : [])
  .map(i => i?._payment || i?.__payment).find(Boolean) || {};
const subtotal = (o) => (Array.isArray(o.cart_items) ? o.cart_items : [])
  .reduce((s, i) => s + (Number(i.price) || 0) * Math.max(1, Number(i.qty || i.quantity) || 1), 0);

const wrong = [], ok = [], unknown = [];
for (const r of rows) {
  if (r.type !== 'prepaid') continue;
  const o = byId.get(r.id);
  if (!o) { unknown.push(r); continue; }

  const m = meta(o);
  const balance = Number(m.balance || 0);
  const isPartial = o.status === 'partial_cod_pending'
    || Number(o.advance_paid_paise || 0) > 0 || balance > 0;
  const paidRs = (Number(o.amount_paise) || 0) / 100;
  // Prepaid is only true when a gateway actually captured the FULL value.
  const trulyPrepaid = !isPartial && Boolean(o.razorpay_payment_id);

  if (trulyPrepaid) { ok.push({ r, o, paidRs }); continue; }
  wrong.push({
    r, o, paidRs, isPartial,
    shouldCollect: Math.round(isPartial ? balance : (paidRs || subtotal(o))),
  });
}

console.log(`✓ genuinely prepaid (gateway captured the full amount): ${ok.length}`);
console.log(`⚠ marked prepaid but NOT paid in full: ${wrong.length}`);
console.log(`? in the report but not in our DB: ${unknown.length}\n`);

for (const w of wrong) {
  console.log(`  ⚠ ${w.r.id}  ${w.o.customer_name || ''}`);
  console.log(`      panel  : prepaid ₹${w.r.amount} (collectable ₹${w.r.collectable}, ${w.r.status}${w.r.ivr ? `, IVR ${w.r.ivr}` : ''})`);
  console.log(`      truth  : ${w.isPartial ? 'PARTIAL COD' : 'no gateway payment'} — order status ${w.o.status}, captured ₹${w.paidRs}, payment id ${w.o.razorpay_payment_id || 'none'}`);
  console.log(`      should : COD ₹${w.shouldCollect}`);
}
for (const u of unknown) console.log(`  ? ${u.id} — not found in orders table (panel ₹${u.amount}, ${u.status})`);

const loss = wrong.reduce((t, w) => t + w.shouldCollect, 0);
if (wrong.length) console.log(`\nuncollected if these ship as-is: ₹${loss.toLocaleString('en-IN')}`);
