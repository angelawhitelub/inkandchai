#!/usr/bin/env node
/**
 * np-panel-lookup.mjs — dump the raw NimbusPost panel row(s) for one or more of
 * our order numbers, so a "why is this prepaid?" question can be answered from
 * what the panel actually holds rather than from a screenshot.
 *
 *   netlify dev:exec -- node scripts/np-panel-lookup.mjs IC-20260804-79V71
 */

const KEY = process.env.NIMBUSPOST_API_KEY;
if (!KEY) { console.error('✗ NIMBUSPOST_API_KEY missing — run via netlify dev:exec'); process.exit(1); }

const wanted = new Set(process.argv.slice(2).map(s => s.trim().toUpperCase()).filter(Boolean));
if (!wanted.size) { console.error('usage: np-panel-lookup.mjs <ORDER_NUMBER> [...]'); process.exit(1); }

const found = new Map();
for (let page = 1; page <= 20 && found.size < wanted.size; page++) {
  const url = new URL('https://ship.nimbuspost.com/api/orders');
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', '100');
  url.searchParams.set('sort', 'desc');
  url.searchParams.set('sort_by', 'id');
  const res = await fetch(url, { headers: { Accept: 'application/json', 'NP-API-KEY': KEY } });
  const j = await res.json().catch(() => ({}));
  const rows = j?.data?.data || j?.data || [];
  if (!Array.isArray(rows) || !rows.length) break;
  for (const r of rows) {
    const num = String(r.order_number || r.order_no || '').trim().toUpperCase();
    if (wanted.has(num) && !found.has(num)) found.set(num, r);
  }
}

for (const num of wanted) {
  const r = found.get(num);
  if (!r) { console.log(`${num}: NOT FOUND in the last 20 pages`); continue; }
  console.log(`\n══ ${num} ══`);
  console.log(JSON.stringify(r, null, 2));
}
