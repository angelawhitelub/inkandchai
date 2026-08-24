/**
 * Durable holding pen for orders the database refused.
 *
 * Why this exists
 * ---------------
 * On 24 Aug the Supabase project was paused for an unpaid invoice. cod-order.js
 * treats its insert as non-fatal — it logged, emailed the customer a
 * confirmation, pushed the shipment to NimbusPost, and returned success. Twenty
 * orders (Rs 7,722) existed as real shipments and real customer promises with no
 * row in the database, and nobody knew until the admin list looked short. One
 * prepaid order was taken by Razorpay with no record at all.
 *
 * Making the insert fatal would be worse: the customer's money is already
 * captured by the time we get here, and failing the request would leave them
 * paid-and-orderless. The order must survive somewhere that does not depend on
 * the database being reachable.
 *
 * Netlify Blobs is that somewhere — a different service with a different failure
 * domain. A rejected insert is written there verbatim, and a scheduled replay
 * drains the pen once the database answers again. Nothing is lost and nothing
 * needs a human to notice.
 *
 * Design notes
 * ------------
 *  - The blob key is the order id, so a retry of the same order overwrites
 *    rather than duplicating.
 *  - Replay treats a 23505 unique violation as SUCCESS: it means the row arrived
 *    by another route (the payment webhook usually), so the pen should drop it.
 *  - Eventual consistency: strong consistency is unavailable in scheduled and
 *    background invocations, and nothing here reads its own write.
 *  - Every failure path here is swallowed and logged. This is the safety net; if
 *    the net itself tears, it must not also break the checkout it is protecting.
 */

const { getStore, connectLambda } = require('@netlify/blobs');

const STORE_NAME = 'lost-orders';
const MIRROR_STORE_NAME = 'orders-mirror';
const MAX_REPLAY_ATTEMPTS = 50;
// How far back the mirror reconcile looks. An order missing for longer than
// this is not something a sweep should quietly recreate — by then a human has
// either dealt with it or the absence is deliberate.
const MIRROR_RECONCILE_DAYS = 14;

/**
 * Blobs reads its credentials from the Lambda event in the classic handler
 * signature. Without connectLambda(event) first, getStore() throws
 * "The environment has not been configured to use Netlify Blobs".
 */
function openNamedStore(event, name) {
  try {
    if (event) connectLambda(event);
    // Eventual consistency, deliberately. Strong consistency needs an
    // `uncachedEdgeURL` that is absent in scheduled and background invocations,
    // and the failure only surfaces at read time — list() throws and the sweep
    // quietly finds nothing, which is precisely the silent-safety-net failure
    // this whole system exists to prevent. Nothing here needs read-after-write:
    // the replay runs on a five-minute timer and the reconcile looks back days.
    return getStore({ name });
  } catch (err) {
    console.error(`[order-fallback] blob store ${name} unavailable:`, err.message);
    return null;
  }
}

const openStore = (event) => openNamedStore(event, STORE_NAME);
const openMirrorStore = (event) => openNamedStore(event, MIRROR_STORE_NAME);

const keyFor = (row) => `${String(row?.razorpay_order_id || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_')}.json`;

// ── stash ──────────────────────────────────────────────────────────────────
async function stashWithStore(store, row, meta = {}) {
  if (!store) return { stashed: false, reason: 'no store' };
  const key = keyFor(row);
  try {
    const existing = await store.get(key, { type: 'json' }).catch(() => null);
    await store.setJSON(key, {
      row,
      source: meta.source || 'unknown',
      reason: String(meta.reason || '').slice(0, 500),
      stashed_at: existing?.stashed_at || new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      attempts: existing?.attempts || 0,
    });
    console.error(`[order-fallback] STASHED ${row?.razorpay_order_id} from ${meta.source}: ${meta.reason}`);
    return { stashed: true, key, firstTime: !existing };
  } catch (err) {
    // Last line of defence: at minimum get the payload into the function log,
    // where it can still be recovered by hand.
    console.error(`[order-fallback] STASH FAILED for ${row?.razorpay_order_id}: ${err.message}`);
    console.error('[order-fallback] payload:', JSON.stringify(row));
    return { stashed: false, reason: err.message };
  }
}

async function stashLostOrder(event, row, meta) {
  return stashWithStore(openStore(event), row, meta);
}

// ── replay ─────────────────────────────────────────────────────────────────
async function replayWithStore(store, supabase, { limit = 100 } = {}) {
  const out = { found: 0, restored: 0, deduped: 0, failed: 0, abandoned: 0, errors: [] };
  if (!store || !supabase) { out.errors.push('missing store or supabase'); return out; }

  let listing;
  try { listing = await store.list(); }
  catch (err) { out.errors.push(`list failed: ${err.message}`); return out; }

  const blobs = (listing?.blobs || []).slice(0, limit);
  out.found = blobs.length;

  for (const b of blobs) {
    let entry;
    try { entry = await store.get(b.key, { type: 'json' }); }
    catch (err) { out.failed++; out.errors.push(`${b.key}: read ${err.message}`); continue; }
    if (!entry?.row) { await store.delete(b.key).catch(() => {}); continue; }

    // Existence check before the insert. 23505 alone is not enough cover: only
    // razorpay_payment_id carries a unique index, and COD/pending rows have that
    // column NULL, so a replayed COD order that had meanwhile been re-created by
    // hand would insert a second copy instead of colliding.
    const orderId = entry.row.razorpay_order_id;
    if (orderId) {
      const { data: already, error: lookupErr } = await supabase
        .from('orders').select('id').eq('razorpay_order_id', orderId).maybeSingle();
      if (lookupErr) {
        // Database still unhappy — leave the row parked and try again next run.
        out.failed++;
        out.errors.push(`${orderId}: lookup ${lookupErr.message}`);
        continue;
      }
      if (already) {
        out.deduped++;
        await store.delete(b.key).catch(() => {});
        continue;
      }
    }

    const { error } = await supabase.from('orders').insert(entry.row);

    if (!error) {
      out.restored++;
      await store.delete(b.key).catch(() => {});
      console.log(`[order-fallback] restored ${entry.row.razorpay_order_id}`);
      continue;
    }
    // Already there — arrived via the webhook or an earlier replay. Drop it.
    if (error.code === '23505') {
      out.deduped++;
      await store.delete(b.key).catch(() => {});
      continue;
    }

    const attempts = (entry.attempts || 0) + 1;
    out.failed++;
    out.errors.push(`${entry.row.razorpay_order_id}: ${error.message}`);
    // Never delete on failure. A permanently broken row is parked, not binned,
    // so it can still be fixed by hand — losing it is the bug we are fixing.
    if (attempts >= MAX_REPLAY_ATTEMPTS) out.abandoned++;
    await store.setJSON(b.key, { ...entry, attempts, last_error: error.message, last_attempt_at: new Date().toISOString() })
      .catch(() => {});
  }
  return out;
}

// ── mirror ─────────────────────────────────────────────────────────────────
// The pen above only catches orders the database REFUSED. It cannot catch an
// order the database accepted and then lost — a restored-from-backup project,
// a bad migration, a row deleted by mistake. The mirror is the answer to that:
// every order is written here at checkout, unconditionally, in a service that
// has nothing to do with Supabase. It is never read by the storefront and never
// replayed automatically except by the reconcile below.

async function mirrorWithStore(store, row, meta = {}) {
  if (!store) return { mirrored: false, reason: 'no store' };
  const key = keyFor(row);
  try {
    const existing = await store.get(key, { type: 'json' }).catch(() => null);
    // A tombstone means an admin deleted this order on purpose. Re-mirroring it
    // would let the reconcile resurrect it, so the tombstone wins.
    if (existing?.deleted_at) return { mirrored: false, reason: 'tombstoned' };
    await store.setJSON(key, {
      row,
      source: meta.source || 'unknown',
      mirrored_at: existing?.mirrored_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return { mirrored: true, key };
  } catch (err) {
    console.error(`[order-mirror] mirror failed for ${row?.razorpay_order_id}: ${err.message}`);
    return { mirrored: false, reason: err.message };
  }
}

// Deliberate deletions must not come back. The entry is kept as a tombstone
// rather than removed, because a missing key and a deleted order look identical
// to the reconcile — and one of those should be restored while the other must
// never be.
async function tombstoneWithStore(store, orderId, reason = '') {
  if (!store || !orderId) return { tombstoned: false };
  const key = keyFor({ razorpay_order_id: orderId });
  try {
    const existing = await store.get(key, { type: 'json' }).catch(() => null);
    await store.setJSON(key, {
      ...(existing || {}),
      deleted_at: new Date().toISOString(),
      deleted_reason: String(reason || '').slice(0, 200),
    });
    return { tombstoned: true, key };
  } catch (err) {
    console.error(`[order-mirror] tombstone failed for ${orderId}: ${err.message}`);
    return { tombstoned: false, reason: err.message };
  }
}

/**
 * Compare the mirror against the orders table and put back anything the
 * database no longer has. This is what catches a silent loss: on 24 Aug the
 * project was unreachable for eight hours and twelve paid orders simply were
 * not there, with nothing in any log to say so.
 */
async function reconcileWithStore(store, supabase, { days = MIRROR_RECONCILE_DAYS, limit = 500, dryRun = false } = {}) {
  const out = { checked: 0, present: 0, tombstoned: 0, stale: 0, restored: 0, failed: 0, missing: [], errors: [] };
  if (!store || !supabase) { out.errors.push('missing store or supabase'); return out; }

  let listing;
  try { listing = await store.list(); }
  catch (err) { out.errors.push(`list failed: ${err.message}`); return out; }

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  for (const b of (listing?.blobs || []).slice(0, limit)) {
    let entry;
    try { entry = await store.get(b.key, { type: 'json' }); }
    catch (err) { out.errors.push(`${b.key}: read ${err.message}`); continue; }
    if (!entry?.row) continue;
    if (entry.deleted_at) { out.tombstoned++; continue; }

    const mirroredAt = Date.parse(entry.mirrored_at || '') || 0;
    if (mirroredAt && mirroredAt < cutoff) { out.stale++; continue; }

    const orderId = entry.row.razorpay_order_id;
    if (!orderId) continue;
    out.checked++;

    const { data: row, error } = await supabase
      .from('orders').select('id').eq('razorpay_order_id', orderId).maybeSingle();
    if (error) { out.failed++; out.errors.push(`${orderId}: lookup ${error.message}`); continue; }
    if (row) { out.present++; continue; }

    out.missing.push(orderId);
    if (dryRun) continue;

    const { error: insErr } = await supabase.from('orders').insert(entry.row);
    if (insErr && insErr.code !== '23505') {
      out.failed++;
      out.errors.push(`${orderId}: insert ${insErr.message}`);
      continue;
    }
    out.restored++;
    console.error(`[order-mirror] RESTORED ${orderId} — it was in the mirror but gone from the database`);
  }
  return out;
}

async function mirrorOrder(event, row, meta) {
  return mirrorWithStore(openMirrorStore(event), row, meta);
}

async function tombstoneMirroredOrder(event, orderId, reason) {
  return tombstoneWithStore(openMirrorStore(event), orderId, reason);
}

async function reconcileMirror(event, supabase, opts) {
  return reconcileWithStore(openMirrorStore(event), supabase, opts);
}

async function replayLostOrders(event, supabase, opts) {
  return replayWithStore(openStore(event), supabase, opts);
}

async function countLostOrders(event) {
  const store = openStore(event);
  if (!store) return null;
  try { return ((await store.list())?.blobs || []).length; }
  catch { return null; }
}

module.exports = {
  STORE_NAME, MIRROR_STORE_NAME, MAX_REPLAY_ATTEMPTS, MIRROR_RECONCILE_DAYS,
  stashLostOrder, replayLostOrders, countLostOrders,
  mirrorOrder, tombstoneMirroredOrder, reconcileMirror,
  // exported for tests, which inject a fake store rather than reaching Netlify
  stashWithStore, replayWithStore, mirrorWithStore, tombstoneWithStore, reconcileWithStore, keyFor,
};
