#!/usr/bin/env node
/**
 * cancel-cod-panel-orders.mjs — cancel the leftover NimbusPost PANEL orders for
 * the COD orders that were shipped as prepaid.
 *
 * cancel-cod-shipments.mjs cancelled the AWBs. The panel order behind each one
 * still sits in the Orders list as "New", and NimbusPost refuses to reuse an
 * order_number, so those rows have to go before the corrected CSV can be
 * uploaded.
 *
 * Cancels ONLY the order numbers listed in cod-fix-suppress-ids.txt — the same
 * 35. Genuinely prepaid orders sitting in the same panel list (verified against
 * our own payment records) are never touched.
 *
 * Uses POST /orders/cancel with the panel row's internal id, deliberately NOT
 * cancelNimbusOrder(): that helper short-circuits to cancelling the SHIPMENT
 * whenever the row still carries an AWB, which is already done and would leave
 * the panel order in place — the exact thing this script exists to remove.
 *
 *   netlify dev:exec -- node scripts/cancel-cod-panel-orders.mjs           # dry run
 *   netlify dev:exec -- node scripts/cancel-cod-panel-orders.mjs --apply
 */

import { readFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const KEY = process.env.NIMBUSPOST_API_KEY;
if (!KEY) { console.error('✗ NIMBUSPOST_API_KEY missing — run via netlify dev:exec'); process.exit(1); }

const PANEL = 'https://ship.nimbuspost.com/api';
const wanted = new Set(readFileSync('/Users/ausaf/Downloads/cod-fix-suppress-ids.txt', 'utf8')
  .split(',').map(s => s.trim()).filter(Boolean));
console.log(`looking for ${wanted.size} order numbers in the panel…`);

// Scan the panel for those order numbers, newest first.
const found = new Map();
for (let page = 1; page <= 30 && found.size < wanted.size; page++) {
  const url = new URL(`${PANEL}/orders`);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', '100');
  url.searchParams.set('sort', 'desc');
  url.searchParams.set('sort_by', 'id');
  const res = await fetch(url, { headers: { Accept: 'application/json', 'NP-API-KEY': KEY } });
  const j = await res.json().catch(() => ({}));
  const rows = j?.data?.data || j?.data || [];
  if (!rows.length) break;
  for (const r of rows) {
    const num = String(r.order_number || r.order_no || '').trim();
    if (wanted.has(num) && !found.has(num)) found.set(num, r);
  }
}

const missing = [...wanted].filter(n => !found.has(n));
console.log(`found in panel : ${found.size}`);
console.log(`not in panel   : ${missing.length}${missing.length ? ' (already gone — nothing to cancel)' : ''}\n`);

if (!APPLY) {
  for (const [num, r] of found) {
    console.log(`  would cancel panel order ${num}  (id ${r.id ?? r.order_id}, status "${r.status ?? r.order_status ?? '?'}")`);
  }
  console.log('\n(dry run — pass --apply)');
  process.exit(0);
}

let ok = 0, already = 0, failed = 0;
for (const [num, row] of found) {
  const panelId = row.id ?? row.order_id;
  if (!panelId) { console.error(`  ✗ ${num} — no panel id on the row`); failed++; continue; }
  // multipart/form-data only; let fetch set the boundary (a manual Content-Type
  // strips it and NimbusPost rejects the request).
  const form = new FormData();
  form.append('id', String(panelId));
  const res = await fetch(`${PANEL}/orders/cancel`, {
    method: 'POST', headers: { Accept: 'application/json', 'NP-API-KEY': KEY }, body: form,
  });
  const j = await res.json().catch(() => ({}));
  const msg = String(j.message || '').toLowerCase();
  if (msg.includes('already') && msg.includes('cancel')) { console.log(`  ✓ ${num} — already cancelled`); already++; }
  else if (res.ok && j.status !== false) { console.log(`  ✓ ${num} — panel order cancelled`); ok++; }
  else { console.error(`  ✗ ${num} — ${j.message || 'HTTP ' + res.status}`); failed++; }
  await new Promise(r => setTimeout(r, 500));
}
console.log(`\ncancelled=${ok}  already=${already}  failed=${failed}`);
