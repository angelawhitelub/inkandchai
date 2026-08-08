#!/usr/bin/env node
/**
 * repair-truncated-addresses.mjs — undo the saved-address truncation bug.
 *
 * Until 8 Aug 2026 the checkout saved a customer's house/street line as
 * `address.split(',')[0]`, where `address` was "<street>, <city>, <state>,
 * <pin>". Any street containing a comma of its own — "Room 312, AHS Hostel",
 * "Flat 4B, Sunrise Apartments" — was cut at that comma before being stored in
 * customer_addresses and profiles. The ORDERS were always written in full; only
 * the saved copy was a fragment, and that fragment is what autofilled the next
 * time the customer checked out.
 *
 * So the complete address is recoverable: it is sitting in that same customer's
 * own past orders. This finds it and writes it back.
 *
 * Matching is deliberately strict — a row is only repaired when a past order of
 * the SAME customer has a street that extends the saved fragment exactly, at a
 * comma boundary. "Room 312" → "Room 312 , AHS Hostel" qualifies; anything that
 * merely looks similar does not. Ambiguous rows (two different completions) are
 * reported and skipped rather than guessed at.
 *
 *   netlify dev:exec -- node scripts/repair-truncated-addresses.mjs          # dry run
 *   netlify dev:exec -- node scripts/repair-truncated-addresses.mjs --apply
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

const APPLY = process.argv.includes('--apply');
// Some fragments have more than one completion — but because a completion must
// extend the fragment at a comma, they are always the same building written a
// few different ways ("F-802, Felicita CHS…" vs "F-802, Felicita Society…").
// With this flag the most recently used one wins, which is the address that
// customer last actually received a parcel at. Still better than a fragment.
const RESOLVE_AMBIGUOUS = process.argv.includes('--resolve-ambiguous');
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('✗ SUPABASE_URL / SUPABASE_SERVICE_KEY missing — run via netlify dev:exec');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const phoneKey = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The street line of a saved order, with the city/state/pin suffix removed. */
function orderStreet(address, { city, state, pincode }) {
  let out = norm(address);
  for (const part of [pincode, state, city]) {
    const token = norm(part);
    if (!token) continue;
    out = out.replace(new RegExp(',\\s*' + esc(token) + '\\s*$', 'i'), '').trim();
  }
  // Fall back to dropping the last three comma segments when the row's own
  // city/state/pin don't match what was on the order.
  if (out === norm(address)) {
    const parts = out.split(',');
    if (parts.length > 3) out = parts.slice(0, parts.length - 3).join(',').trim();
  }
  return out.replace(/,\s*$/, '').trim();
}

/**
 * Is `full` the same street as `fragment`, only complete?
 * True when `full` starts with the fragment and the very next thing is a comma
 * — exactly the cut the bug made. Nothing else counts as a match.
 */
function isTruncationOf(fragment, full) {
  const f = norm(fragment), t = norm(full);
  if (!f || !t || t.length <= f.length) return false;
  if (t.slice(0, f.length).toLowerCase() !== f.toLowerCase()) return false;
  return /^\s*,/.test(t.slice(f.length));
}

async function fetchAll(table, columns, filter) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(columns).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

const orders = await fetchAll('orders', 'user_id,customer_phone,customer_address,created_at');
const byUser = new Map(), byPhone = new Map();
for (const o of orders) {
  if (!o.customer_address) continue;
  if (o.user_id) (byUser.get(o.user_id) ?? byUser.set(o.user_id, []).get(o.user_id)).push(o);
  const p = phoneKey(o.customer_phone);
  if (p.length === 10) (byPhone.get(p) ?? byPhone.set(p, []).get(p)).push(o);
}
console.log(`Loaded ${orders.length} orders · ${byUser.size} by user · ${byPhone.size} by phone\n`);

/** Every distinct complete street this customer has ever shipped to. */
function completionsFor(row) {
  const candidates = [
    ...(byUser.get(row.user_id ?? row.id) || []),
    ...(byPhone.get(phoneKey(row.phone)) || []),
  ];
  const hits = new Map();   // street -> newest created_at
  for (const o of candidates) {
    const street = orderStreet(o.customer_address, row);
    if (!isTruncationOf(row.address, street)) continue;
    const prev = hits.get(street);
    if (!prev || o.created_at > prev) hits.set(street, o.created_at);
  }
  return [...hits.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1)).map(([street]) => street);
}

const report = { repaired: [], ambiguous: [], intact: 0, noMatch: 0 };

for (const [table, keyCol] of [['customer_addresses', 'user_id'], ['profiles', 'id']]) {
  const cols = table === 'profiles'
    ? 'id,name,phone,address,pincode,city,state'
    : 'id,user_id,name,phone,address,pincode,city,state';
  const rows = (await fetchAll(table, cols)).filter(r => norm(r.address));

  for (const row of rows) {
    // A saved street that already contains a comma was never truncated.
    if (norm(row.address).includes(',')) { report.intact++; continue; }

    const options = completionsFor({ ...row, user_id: row[keyCol] });
    if (!options.length) { report.noMatch++; continue; }
    if (options.length > 1 && !RESOLVE_AMBIGUOUS) {
      report.ambiguous.push({ table, id: row.id, name: row.name, from: row.address, options });
      continue;
    }

    // options[0] is the most recently used completion.
    const entry = { table, id: row.id, name: row.name, from: row.address, to: options[0],
      ...(options.length > 1 ? { resolved: options.length } : {}) };
    report.repaired.push(entry);
  }
}

// Write the before/after set to disk BEFORE touching anything, so every change
// can be undone from a file rather than from this terminal's scrollback.
if (APPLY && report.repaired.length) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `/tmp/address-repair-rollback-${stamp}.json`;
  fs.writeFileSync(path, JSON.stringify(report.repaired, null, 1));
  console.log(`Rollback snapshot → ${path}\n`);
  for (const r of report.repaired) {
    const { error } = await sb.from(r.table).update({ address: r.to }).eq('id', r.id);
    if (error) { r.error = error.message; console.error(`✗ ${r.table}/${r.id}: ${error.message}`); }
  }
}

for (const r of report.repaired) {
  console.log(`${APPLY ? '✔' : '·'} ${r.table.padEnd(19)} ${String(r.name || '').slice(0, 22).padEnd(22)} "${r.from}"\n${' '.repeat(45)}→ "${r.to}"${r.resolved ? `   [newest of ${r.resolved} variants]` : ''}`);
}
if (report.ambiguous.length) {
  console.log('\nSkipped — more than one possible completion, not guessing:');
  for (const a of report.ambiguous) {
    console.log(`  ${a.table}/${a.id} ${a.name || ''} "${a.from}"`);
    for (const o of a.options) console.log(`      • ${o}`);
  }
}
console.log(`\n${APPLY ? 'Repaired' : 'Would repair'}: ${report.repaired.length}`
  + ` · ambiguous (skipped): ${report.ambiguous.length}`
  + ` · already complete: ${report.intact}`
  + ` · no past order to recover from: ${report.noMatch}`);
if (!APPLY) console.log('\nDry run — nothing written. Re-run with --apply to save these.');
