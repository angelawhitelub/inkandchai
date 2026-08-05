#!/usr/bin/env node
/**
 * audit-partial-cod.mjs — find partial-COD orders that will collect the wrong
 * amount (or nothing) at the door.
 *
 * A partial COD order is one where the customer paid a ~10% deposit online and
 * owes the balance to the courier. It goes wrong when the deposit payment is
 * recorded as an ordinary prepaid payment: status lands on 'paid' instead of
 * 'partial_cod_pending' and cart_items[0]._payment is never written, so
 * nimbuspost-order-push sees a razorpay_payment_id, no balance and no advance,
 * calls it fully prepaid, and ships it with the DEPOSIT as the declared value
 * and nothing to collect.
 *
 * Detection is deliberately independent of those same signals: an order is
 * suspect when the money captured is far below what the cart is worth.
 *
 *   netlify dev:exec -- node scripts/audit-partial-cod.mjs
 *   netlify dev:exec -- node scripts/audit-partial-cod.mjs IC-20260804-79V71
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const only = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;

const meta = (o) => (Array.isArray(o.cart_items) ? o.cart_items : [])
  .map(i => i?._payment || i?.__payment).find(Boolean) || {};
const subtotal = (o) => (Array.isArray(o.cart_items) ? o.cart_items : [])
  .reduce((s, i) => s + (Number(i.price) || 0) * Math.max(1, Number(i.qty || i.quantity) || 1), 0);

if (only) {
  const { data: o } = await supabase.from('orders').select('*').eq('razorpay_order_id', only).maybeSingle();
  if (!o) { console.error(`✗ ${only} not found`); process.exit(1); }
  const m = meta(o);
  console.log(JSON.stringify({
    id: o.razorpay_order_id,
    status: o.status,
    amount_paise: o.amount_paise,
    amount_rs: (o.amount_paise || 0) / 100,
    cart_subtotal_rs: subtotal(o),
    advance_paid_paise: o.advance_paid_paise,
    razorpay_payment_id: o.razorpay_payment_id,
    shipment_payment_type: o.shipment_payment_type,
    tracking_id: o.tracking_id,
    _payment: m,
    created_at: o.created_at,
    cart: (o.cart_items || []).map(i => ({ t: i.title || i.name, p: i.price, q: i.qty || i.quantity })),
  }, null, 2));
  process.exit(0);
}

// Sweep every order that captured money online. Partial COD is only possible
// when something was paid, so pure-COD rows can't have this failure.
const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase.from('orders')
    .select('razorpay_order_id,id,status,amount_paise,advance_paid_paise,razorpay_payment_id,shipment_payment_type,tracking_id,cart_items,customer_name,customer_phone,created_at')
    .order('created_at', { ascending: false })
    .range(from, from + 999);
  if (error) throw error;
  if (!data?.length) break;
  rows.push(...data);
  if (data.length < 1000) break;
}
console.log(`scanned ${rows.length} orders\n`);

const declared = [];  // correctly flagged partial COD
const suspect = [];   // paid far less than the cart is worth, but not flagged

for (const o of rows) {
  const m = meta(o);
  const paidRs = (Number(o.amount_paise) || 0) / 100;
  const cartRs = subtotal(o);
  const isDeclared = o.status === 'partial_cod_pending'
    || String(m.mode || '') === 'partial_cod'
    || Number(o.advance_paid_paise || 0) > 0
    || Number(m.balance || 0) > 0;

  if (isDeclared) { declared.push({ o, m, paidRs, cartRs }); continue; }

  // Not flagged. Only a problem if money WAS captured and it falls well short
  // of the cart — a real prepaid order pays the full value, and a pure COD
  // order captures nothing at all.
  if (!o.razorpay_payment_id && o.status !== 'paid') continue;
  if (cartRs <= 0 || paidRs <= 0) continue;
  // 10% deposits land near 0.10; allow slack for shipping and coupons before
  // calling it a shortfall.
  if (paidRs >= cartRs * 0.6) continue;
  suspect.push({ o, m, paidRs, cartRs });
}

console.log(`── correctly flagged partial COD: ${declared.length}`);
const declBad = declared.filter(d => d.o.shipment_payment_type === 'prepaid');
console.log(`   of those, pushed to NimbusPost as PREPAID: ${declBad.length}`);
for (const d of declBad) {
  console.log(`   ⚠ ${d.o.razorpay_order_id}  paid ₹${d.paidRs}  cart ₹${d.cartRs}  awb ${d.o.tracking_id || '—'}  status ${d.o.status}`);
}

console.log(`\n── NOT flagged but paid far below cart value: ${suspect.length}`);
for (const s of suspect) {
  console.log(`   ⚠ ${s.o.razorpay_order_id}  paid ₹${s.paidRs}  cart ₹${s.cartRs}  short ₹${(s.cartRs - s.paidRs).toFixed(0)}  status ${s.o.status}  ship_type ${s.o.shipment_payment_type || '—'}  awb ${s.o.tracking_id || '—'}  ${s.o.created_at?.slice(0,10)}`);
}
const exposure = suspect.reduce((t, s) => t + (s.cartRs - s.paidRs), 0);
console.log(`\nuncollected exposure on unflagged orders: ₹${exposure.toLocaleString('en-IN')}`);
