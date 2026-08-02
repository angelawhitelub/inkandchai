#!/usr/bin/env node
/**
 * refix-cod-shipments.mjs — one-off repair for orders shipped as PREPAID that
 * were really COD (see the nimbuspost COD-classification fix).
 *
 * Those shipments carry collectable_amount 0, so the courier hands the parcel
 * over and collects nothing. This cancels each wrong shipment and re-pushes it
 * through the FIXED code path so a correct COD AWB is issued.
 *
 * SENDS NOTHING TO CUSTOMERS. It calls the NimbusPost cancel API and the
 * nimbuspost-ship endpoint directly; neither sends email or WhatsApp. The
 * customer-facing cancel-order.js (which does notify) is deliberately not used.
 *
 * SAFETY
 *   • Dry run unless --apply is passed.
 *   • Every precondition is re-checked per order at the moment of acting, not
 *     just when the list was built: still unpaid, still pushed as prepaid, still
 *     has the AWB we expect, and STILL HAS NOT MOVED. A parcel that started
 *     moving since the audit is skipped, never cancelled out from under a courier.
 *   • --limit N to pilot on one order before committing to the rest.
 *   • If the NimbusPost cancel fails, the order is left completely untouched —
 *     no DB write, no re-push. Better a stale wrong shipment than two live AWBs
 *     for one parcel.
 *
 * RUN (from the repo root)
 *   netlify dev:exec -- node scripts/refix-cod-shipments.mjs            # dry run
 *   netlify dev:exec -- node scripts/refix-cod-shipments.mjs --apply --limit 1
 *   netlify dev:exec -- node scripts/refix-cod-shipments.mjs --apply
 */

import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');
const LIMIT = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1])
  || Number(process.argv[process.argv.indexOf('--limit') + 1]) || 0;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const SITE = process.env.SITE_URL || 'https://inkandchai.in';
const NP_EMAIL = process.env.NIMBUSPOST_EMAIL;
const NP_PASSWORD = process.env.NIMBUSPOST_PASSWORD;

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_KEY, ADMIN_SECRET, NP_EMAIL, NP_PASSWORD })) {
  if (!v) { console.error(`✗ Missing ${k}. Run via:  netlify dev:exec -- node scripts/refix-cod-shipments.mjs`); process.exit(1); }
}

// ── HOLD ──────────────────────────────────────────────────────────────────────
// This script routes re-pushes through /nimbuspost-ship, which is NOT usable yet:
// npServiceability() posts the wrong payload (destination_pincode/cod instead of
// destination/payment_type, and no `origin`, which the API requires), so it
// returns ZERO couriers for every pincode and every re-push fails with "No
// couriers serviceable". A pilot run cancelled one real AWB before this was
// understood. Do not run with --apply until that helper is fixed and verified.
if (APPLY && !process.env.REFIX_I_KNOW_SHIP_IS_FIXED) {
  console.error('✗ Refusing to run: /nimbuspost-ship serviceability is broken (missing `origin`, wrong field names).');
  console.error('  Fix npServiceability first, verify a single re-push by hand, then set');
  console.error('  REFIX_I_KNOW_SHIP_IS_FIXED=1 to re-enable --apply.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const NP_BASE = 'https://api.nimbuspost.com/v1';

let npToken = null;
async function npAuth() {
  if (npToken) return npToken;
  const res = await fetch(`${NP_BASE}/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: NP_EMAIL, password: NP_PASSWORD }),
  });
  const j = await res.json();
  if (!j?.status || !j?.data) throw new Error('NimbusPost auth failed: ' + JSON.stringify(j).slice(0, 200));
  npToken = j.data;
  return npToken;
}

async function npCancel(awb) {
  const token = await npAuth();
  const res = await fetch(`${NP_BASE}/shipments/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ awb: String(awb) }),
  });
  const j = await res.json().catch(() => ({}));
  // NimbusPost reports an already-cancelled AWB as a failure; that is success
  // for our purposes — the shipment is not going out either way.
  const msg = String(j?.message || '').toLowerCase();
  if (j?.status) return { ok: true, already: false };
  if (/already|cancel/.test(msg)) return { ok: true, already: true, note: j.message };
  return { ok: false, error: j?.message || `HTTP ${res.status}` };
}

const paid = o => Boolean(o.razorpay_payment_id) || Number(o.advance_paid_paise || 0) > 0 || o.status === 'paid';

async function main() {
  const { data: all, error } = await supabase.from('orders')
    .select('id,razorpay_order_id,status,shipment_payment_type,razorpay_payment_id,advance_paid_paise,amount_paise,tracking_id,courier_name,shipment_moved_at,last_nimbuspost_status,delivered_at')
    .eq('shipment_payment_type', 'prepaid')
    .order('created_at', { ascending: false });
  if (error) throw error;

  let targets = (all || []).filter(o =>
    !paid(o) && Number(o.amount_paise || 0) > 0 && o.tracking_id
    && !o.delivered_at && !o.shipment_moved_at && !o.last_nimbuspost_status
    && !['cancelled', 'refunded'].includes(String(o.status)));
  if (LIMIT) targets = targets.slice(0, LIMIT);

  console.log(`mode        : ${APPLY ? 'APPLY (live)' : 'DRY RUN'}`);
  console.log(`targets     : ${targets.length}`);
  console.log(`to collect  : Rs ${(targets.reduce((a, o) => a + Number(o.amount_paise), 0) / 100).toLocaleString('en-IN')}\n`);
  if (!targets.length) return;

  if (!APPLY) {
    targets.forEach(o => console.log(`  would fix ${o.razorpay_order_id}  Rs${o.amount_paise / 100}  AWB ${o.tracking_id} (${o.courier_name})`));
    console.log('\n(dry run — pass --apply to act. Start with --apply --limit 1.)');
    return;
  }

  let fixed = 0, skipped = 0, failed = 0;
  for (const t of targets) {
    const id = t.razorpay_order_id;
    // Re-read immediately before acting: the audit list may be minutes old and a
    // pickup scan in that gap must win.
    const { data: o } = await supabase.from('orders').select('*').eq('id', t.id).maybeSingle();
    if (!o || o.shipment_moved_at || o.last_nimbuspost_status || o.delivered_at
        || o.tracking_id !== t.tracking_id || paid(o)) {
      console.log(`  ⏭  ${id} — changed since the audit, leaving it alone`);
      skipped++; continue;
    }

    const cancel = await npCancel(o.tracking_id);
    if (!cancel.ok) {
      console.error(`  ✗ ${id} — NP cancel failed (${cancel.error}); order left untouched`);
      failed++; continue;
    }

    // Clear the AWB or the ship endpoint will skip this order as "already has
    // tracking". Status is deliberately left as-is: COD is now decided by
    // captured money, not by the status label, and rewriting it to cod_pending
    // could expose the order to the stale-COD auto-cancel job.
    const { error: updErr } = await supabase.from('orders').update({
      tracking_id: null, courier_name: null, tracking_url: null,
      awb_assigned_at: null, shipment_payment_type: null,
    }).eq('id', o.id);
    if (updErr) { console.error(`  ✗ ${id} — DB clear failed: ${updErr.message}`); failed++; continue; }

    const res = await fetch(`${SITE}/.netlify/functions/nimbuspost-ship`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_SECRET },
      body: JSON.stringify({ order_ids: [id] }),
    });
    const j = await res.json().catch(() => ({}));
    const ok = j?.results?.[0]?.awb;
    if (ok) {
      const { data: after } = await supabase.from('orders')
        .select('tracking_id,shipment_payment_type').eq('id', o.id).maybeSingle();
      console.log(`  ✓ ${id}  Rs${o.amount_paise / 100}  ${t.tracking_id} → ${after?.tracking_id}  [${after?.shipment_payment_type}]`
        + (after?.shipment_payment_type === 'cod' ? '' : '  ⚠ NOT COD — CHECK THIS'));
      fixed++;
    } else {
      console.error(`  ✗ ${id} — re-push failed: ${JSON.stringify(j).slice(0, 300)}`);
      console.error(`     Old AWB ${t.tracking_id} IS CANCELLED and the order now has no AWB — re-push it from the admin panel.`);
      failed++;
    }
    await new Promise(r => setTimeout(r, 700));   // be gentle with the NP API
  }
  console.log(`\nfixed=${fixed}  skipped=${skipped}  failed=${failed}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
