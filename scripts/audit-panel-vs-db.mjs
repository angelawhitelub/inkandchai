#!/usr/bin/env node
/**
 * audit-panel-vs-db.mjs — compare what NimbusPost will collect against what the
 * order actually owes.
 *
 * The partial-COD failure (IC-20260804-79V71) left the DB row perfectly
 * correct and only the PANEL wrong: the Razorpay webhook pushed the shipment as
 * prepaid/₹63 before the browser callback marked the order partial COD, so no
 * amount of database auditing can see it. This walks the panel instead and
 * flags every row whose payment_method / order_amount disagrees with the order.
 *
 *   netlify dev:exec -- node scripts/audit-panel-vs-db.mjs
 */

import { createClient } from '@supabase/supabase-js';

const KEY = process.env.NIMBUSPOST_API_KEY;
if (!KEY) { console.error('✗ NIMBUSPOST_API_KEY missing — run via netlify dev:exec'); process.exit(1); }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const meta = (o) => (Array.isArray(o.cart_items) ? o.cart_items : [])
  .map(i => i?._payment || i?.__payment).find(Boolean) || {};

// ── what we owe, per order ──────────────────────────────────────────────────
const orders = new Map();
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from('orders')
    .select('razorpay_order_id,status,amount_paise,advance_paid_paise,razorpay_payment_id,cart_items,tracking_id,created_at')
    .order('created_at', { ascending: false })
    .range(from, from + 999);
  if (error) throw error;
  if (!data?.length) break;
  for (const o of data) if (o.razorpay_order_id) orders.set(o.razorpay_order_id.toUpperCase(), o);
  if (data.length < 1000) break;
}
console.log(`loaded ${orders.size} orders from the DB`);

// ── what the panel will collect ─────────────────────────────────────────────
const panel = [];
for (let page = 1; page <= 50; page++) {
  const url = new URL('https://ship.nimbuspost.com/api/orders');
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', '100');
  url.searchParams.set('sort', 'desc');
  url.searchParams.set('sort_by', 'id');
  const res = await fetch(url, { headers: { Accept: 'application/json', 'NP-API-KEY': KEY } });
  const j = await res.json().catch(() => ({}));
  const rows = j?.data?.data || j?.data || [];
  if (!Array.isArray(rows) || !rows.length) break;
  panel.push(...rows);
  if (rows.length < 100) break;
}
console.log(`scanned ${panel.length} panel orders\n`);

const bad = [];
for (const r of panel) {
  const num = String(r.order_number || r.order_no || '').trim().toUpperCase();
  const o = orders.get(num);
  if (!o) continue;
  if (String(r.status || '').toLowerCase() === 'cancelled') continue;

  const m = meta(o);
  const balance = Number(m.balance || 0);
  const isPartial = o.status === 'partial_cod_pending'
    || Number(o.advance_paid_paise || 0) > 0
    || balance > 0;
  if (!isPartial) continue;

  const shouldCollect = Math.round(balance);
  const panelType = String(r.payment_method || '').toLowerCase();
  const panelAmt = Math.round(Number(r.order_amount) || 0);
  if (panelType === 'cod' && panelAmt === shouldCollect) continue;

  bad.push({ num, panelType, panelAmt, shouldCollect, o, r });
}

console.log(`── partial-COD shipments the panel will get WRONG: ${bad.length}\n`);
for (const b of bad) {
  console.log(`  ⚠ ${b.num}`);
  console.log(`      panel  : ${b.panelType} ₹${b.panelAmt}   (panel status "${b.r.status}", awb ${b.r.awb_number || b.o.tracking_id || '—'})`);
  console.log(`      should : COD ₹${b.shouldCollect}   (shortfall ₹${b.shouldCollect - (b.panelType === 'cod' ? b.panelAmt : 0)})`);
  console.log(`      order  : status ${b.o.status}, paid ₹${(b.o.amount_paise || 0) / 100}, ${b.o.created_at?.slice(0, 10)}`);
}
const loss = bad.reduce((t, b) => t + (b.shouldCollect - (b.panelType === 'cod' ? b.panelAmt : 0)), 0);
console.log(`\ntotal that would go uncollected: ₹${loss.toLocaleString('en-IN')}`);
