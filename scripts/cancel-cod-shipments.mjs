#!/usr/bin/env node
/**
 * cancel-cod-shipments.mjs — cancel the wrong PREPAID shipments so they can be
 * re-created as COD by hand (NimbusPost bulk CSV).
 *
 * CANCEL ONLY. It does not re-push — /nimbuspost-ship cannot create shipments
 * (its payload is missing every consignee field) and NimbusPost refuses to
 * reuse an order_number, so recreation happens in the panel.
 *
 * SENDS NOTHING TO CUSTOMERS, provided NOTIFY_SUPPRESS_ORDER_IDS lists these
 * orders and the site has been redeployed since. Cancelling in NimbusPost
 * raises a 'cancelled' webhook, which would otherwise email and WhatsApp the
 * customer. This script refuses to run if the guard is not in place.
 *
 * Per order, immediately before acting, it re-checks: still unpaid, still holds
 * the AWB we expect, and STILL HAS NOT MOVED. Anything that changed is skipped —
 * a parcel already with a courier is never cancelled out from under it.
 *
 * After a successful cancel the AWB is cleared and the status set to
 * cod_pending, so the order is clean for re-creation and the AWB sync can
 * attach the new waybill. Safe from the stale-COD auto-cancel, which needs
 * seven days without an AWB.
 *
 *   netlify dev:exec -- node scripts/cancel-cod-shipments.mjs            # dry run
 *   netlify dev:exec -- node scripts/cancel-cod-shipments.mjs --apply
 */

import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const NP_BASE = 'https://api.nimbuspost.com/v1';

let token = null;
async function npAuth() {
  if (token) return token;
  const j = await (await fetch(`${NP_BASE}/users/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.NIMBUSPOST_EMAIL, password: process.env.NIMBUSPOST_PASSWORD }),
  })).json();
  if (!j?.data) throw new Error('NimbusPost auth failed');
  token = j.data;
  return token;
}

async function npCancelShipment(awb) {
  const t = await npAuth();
  const j = await (await fetch(`${NP_BASE}/shipments/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: JSON.stringify({ awb: String(awb) }),
  })).json().catch(() => ({}));
  if (j?.status) return { ok: true };
  // An already-cancelled AWB reports as a failure; that is still the state we want.
  if (/already|cancel/i.test(String(j?.message || ''))) return { ok: true, already: true };
  return { ok: false, error: j?.message || 'unknown' };
}

const paid = o => Boolean(o.razorpay_payment_id) || Number(o.advance_paid_paise || 0) > 0 || o.status === 'paid';

const { data: all } = await supabase.from('orders')
  .select('id,razorpay_order_id,status,shipment_payment_type,razorpay_payment_id,advance_paid_paise,amount_paise,tracking_id,courier_name,shipment_moved_at,last_nimbuspost_status,delivered_at')
  .eq('shipment_payment_type', 'prepaid').order('amount_paise', { ascending: false });

const targets = (all || []).filter(o =>
  !paid(o) && Number(o.amount_paise || 0) > 0 && o.tracking_id
  && !o.delivered_at && !o.shipment_moved_at && !o.last_nimbuspost_status
  && !['cancelled', 'refunded'].includes(String(o.status)));

console.log(`mode    : ${APPLY ? 'APPLY (live)' : 'DRY RUN'}`);
console.log(`targets : ${targets.length}   value Rs ${(targets.reduce((a, o) => a + Number(o.amount_paise), 0) / 100).toLocaleString('en-IN')}\n`);

if (APPLY) {
  const suppressed = String(process.env.NOTIFY_SUPPRESS_ORDER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const missing = targets.filter(o => !suppressed.includes(o.razorpay_order_id));
  if (missing.length) {
    console.error(`✗ Refusing to cancel: ${missing.length} of these orders are NOT in NOTIFY_SUPPRESS_ORDER_IDS,`);
    console.error(`  so the cancellation webhook would email and WhatsApp those customers.`);
    console.error(`  First: ${missing.slice(0, 3).map(o => o.razorpay_order_id).join(', ')}`);
    process.exit(1);
  }
  console.log(`notification guard: all ${targets.length} orders are suppressed ✓\n`);
}

if (!APPLY) {
  targets.forEach(o => console.log(`  would cancel ${o.razorpay_order_id}  Rs${o.amount_paise / 100}  AWB ${o.tracking_id} (${o.courier_name})`));
  console.log('\n(dry run — pass --apply)');
} else {
  let done = 0, skipped = 0, failed = 0;
  const log = [];
  for (const t of targets) {
    const { data: o } = await supabase.from('orders').select('*').eq('id', t.id).maybeSingle();
    if (!o || o.tracking_id !== t.tracking_id || o.shipment_moved_at || o.last_nimbuspost_status || o.delivered_at || paid(o)) {
      console.log(`  ⏭  ${t.razorpay_order_id} — changed since the scan, left alone`);
      skipped++; continue;
    }
    const r = await npCancelShipment(o.tracking_id);
    if (!r.ok) { console.error(`  ✗ ${t.razorpay_order_id} — ${r.error}`); failed++; continue; }
    await supabase.from('orders').update({
      tracking_id: null, courier_name: null, tracking_url: null,
      awb_assigned_at: null, shipment_payment_type: null,
      nimbus_pushed_at: null, status: 'cod_pending',
    }).eq('id', o.id);
    console.log(`  ✓ ${t.razorpay_order_id}  Rs${o.amount_paise / 100}  AWB ${t.tracking_id} cancelled${r.already ? ' (was already)' : ''}`);
    log.push({ order: t.razorpay_order_id, collect: o.amount_paise / 100, old_awb: t.tracking_id });
    done++;
    await new Promise(r2 => setTimeout(r2, 600));
  }
  console.log(`\ncancelled=${done}  skipped=${skipped}  failed=${failed}`);
  const fs = await import('node:fs');
  fs.writeFileSync('/Users/ausaf/Downloads/cod-cancelled-log.json', JSON.stringify(log, null, 2));
}
