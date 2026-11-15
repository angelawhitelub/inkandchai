/**
 * Cancel an order in NimbusPost FOR GOOD (Partner API v2).
 *
 * WHY (owner, 15 Nov 2026): "cancel shipment cancels awb and refund charges to
 * wallet however order remains in new section which can get it booked twice
 * however cancel order cancels it completely".
 *
 * Every cancel path used to call the v1 `shipments/cancel` (by AWB). NimbusPost
 * documents what that does: "the order goes back to `created`, so you can book
 * it again". The next bulk "Ship" in the panel then booked it AGAIN, with a new
 * AWB -- 9 orders cancelled or refunded here were live with a second AWB on
 * 15 Nov (one refunded and already in transit).
 *
 * `POST /v2/orders/{orderId}/cancel` with `scope: "order"` cancels the order
 * itself; if it was booked, the shipment is cancelled with the courier too and
 * the charge refunded to the wallet. Nothing is left in New to re-book.
 *
 * It also sweeps every NimbusPost order for the same order: re-pushes under a
 * suffix (IC-…-c, -c2) and the order behind the AWB we know. A shipment the
 * courier already picked up cannot be cancelled; it is reported as `moving`
 * (ask for an RTO), never guessed at.
 *
 * Never throws. `handled: false` means v2 is not configured or NimbusPost has
 * no such order, so the caller can fall back to the old v1/panel calls.
 */

const { configured, makeV2Caller, listOrders } = require('./nimbuspost-v2');

// docs: Order lifecycle. Before pickup -> cancellable; the rest is too late.
const BEFORE_PICKUP = /^(created|new|booked|ready_to_ship|pickup_scheduled|pickup_rescheduled|pickup_pending|out_for_pickup|pickup_failed|pickup_exception)$/;
const CLOSED = /^(cancelled|canceled|lost|damaged|rto_lost|rto_damaged)$/;

const norm = (v) => String(v || '').trim().toLowerCase().replace(/[\s-]+/g, '_');

/** The numbers we may have pushed this order under (nimbuspost-order-push `suffix`). */
function numberVariants(orderNumber) {
  const b = String(orderNumber || '').trim();
  if (!b) return [];
  const out = new Set();
  for (const base of [b, b.toUpperCase()]) for (const sfx of ['', '-c', '-C', '-c2', '-C2']) out.add(base + sfx);
  return [...out];
}

/** Our IC-… number from a NimbusPost order_number (suffix stripped), upper case. */
function baseNumber(n) {
  return String(n || '').trim().toUpperCase().replace(/-C\d*$/, '');
}

function rowStatus(r) {
  return norm(r?.order_status || r?.status_tab || '');
}

/** What to do with one NimbusPost order. */
function classify(r) {
  const st = rowStatus(r);
  if (r?.cancelled_at || CLOSED.test(st)) return 'already';
  if (BEFORE_PICKUP.test(st)) return 'cancel';
  // Unknown or later states are never cancelled blind.
  return 'moving';
}

async function rowsFor(call, { orderNumber, awb, siblings }) {
  const byId = new Map();
  const add = (rows) => { for (const r of rows || []) if (r && r.order_id) byId.set(String(r.order_id), r); };
  const wantAwb = String(awb || '').trim().toUpperCase();
  if (wantAwb) {
    const hits = (await listOrders(call, { awb: wantAwb, order_status: 'all' }, { max: 20, pageSize: 20 }))
      .filter((r) => String(r?.shipment?.awb || '').trim().toUpperCase() === wantAwb);
    add(hits);
  }
  const bases = new Set();
  if (orderNumber) bases.add(baseNumber(orderNumber));
  if (siblings) for (const r of byId.values()) if (r.order_number) bases.add(baseNumber(r.order_number));
  for (const b of bases) {
    if (!b) continue;
    const variants = numberVariants(b);
    const hits = (await listOrders(call, { order_number: variants.join(','), order_status: 'all' }, { max: 50, pageSize: 50 }))
      .filter((r) => baseNumber(r.order_number) === b);
    add(hits);
  }
  return [...byId.values()];
}

/**
 * @param {{orderNumber?:string, awb?:string, reason?:string, siblings?:boolean}} what
 *   siblings (default true): also cancel the other NimbusPost orders under the
 *   same order number. nimbuspost-cancel-stray-awb passes false: there the order
 *   is live with another booking that must be kept.
 * @returns {Promise<{handled:boolean, ok:boolean, alreadyCancelled?:boolean,
 *   cancelled:Array, already:Array, moving:Array, failed:Array, error?:string, message:string}>}
 */
async function cancelNimbusOrderForGood({ orderNumber, awb, reason = 'Order cancelled by the store', siblings = true, dryRun = false } = {}, deps = {}) {
  const empty = { cancelled: [], already: [], moving: [], failed: [] };
  if (!deps.v2Fetch && !configured()) return { handled: false, ok: false, ...empty, error: 'NimbusPost v2 key not configured', message: '' };
  const call = makeV2Caller(deps);
  let rows;
  try {
    rows = await rowsFor(call, { orderNumber, awb, siblings: siblings !== false });
  } catch (e) {
    return { handled: false, ok: false, ...empty, error: `NimbusPost lookup failed: ${e.message}`, message: '' };
  }
  if (!rows.length) return { handled: false, ok: false, ...empty, error: 'Not found in NimbusPost', message: '' };

  const out = { ...empty };
  for (const r of rows) {
    const item = { order_id: String(r.order_id), order_number: r.order_number || '', awb: String(r?.shipment?.awb || ''), status: rowStatus(r) };
    const kind = classify(r);
    if (kind === 'already') { out.already.push(item); continue; }
    if (kind === 'moving') { out.moving.push(item); continue; }
    if (dryRun) { (out.would_cancel = out.would_cancel || []).push(item); continue; }
    try {
      const res = await call(`/v2/orders/${encodeURIComponent(item.order_id)}/cancel`, {
        method: 'POST', body: { scope: 'order', reason: String(reason).slice(0, 200) },
      });
      const d = res.data || {};
      const code = String(d?.error?.code || '');
      if (res.httpStatus === 200 && d.success === true && d.data?.cancelled !== false) {
        out.cancelled.push(item);
      } else if (/NOT_CANCELLABLE/i.test(code) || /picked up/i.test(JSON.stringify(d.error || ''))) {
        out.moving.push({ ...item, error: d?.error?.message || code });
      } else if (/already/i.test(JSON.stringify(d.error || d.message || ''))) {
        out.already.push(item);
      } else {
        out.failed.push({ ...item, error: `HTTP ${res.httpStatus}: ${String(d?.error?.message || d?.message || res.raw || '').slice(0, 160)}` });
      }
    } catch (e) {
      out.failed.push({ ...item, error: e.message });
    }
  }

  const label = (x) => `${x.order_number || x.order_id}${x.awb ? ` (AWB ${x.awb})` : ''}`;
  const parts = [];
  if (out.cancelled.length) parts.push(`NimbusPost order cancelled for good: ${out.cancelled.map(label).join(', ')}.`);
  if (out.moving.length) parts.push(`Already picked up in NimbusPost, NOT cancelled -- ask for an RTO: ${out.moving.map((x) => `${label(x)} [${x.status}]`).join(', ')}.`);
  if (out.failed.length) parts.push(`NimbusPost would not cancel ${out.failed.map((x) => `${label(x)}: ${x.error}`).join('; ')} -- cancel it in NimbusPost (Cancel order, not Cancel shipment).`);
  if (!parts.length && out.already.length) parts.push('Already cancelled in NimbusPost.');
  if (dryRun) {
    return { handled: true, ok: true, dry_run: true, ...out, would_cancel: out.would_cancel || [],
      message: `Would cancel for good: ${(out.would_cancel || []).map(label).join(', ') || 'nothing'}.` };
  }
  return {
    handled: true,
    ok: !out.failed.length && !out.moving.length,
    alreadyCancelled: !out.cancelled.length && !out.failed.length && !out.moving.length && out.already.length > 0,
    ...out,
    error: out.failed.length || out.moving.length ? parts.join(' ') : undefined,
    message: parts.join(' '),
  };
}

/**
 * Fold a cancel-for-good result into the courier-cancel result the admin shows
 * (utils/courier-shipment-cancel: { action, message }). The worse outcome wins,
 * so a NimbusPost copy that could not be stopped is never hidden behind an
 * XpressBees "cancelled".
 */
const RANK = { none: -1, already_cancelled: 0, cancelled: 1, not_supported: 2, moving: 3, error: 4 };
function withNimbus(courier, np) {
  if (!np || !np.handled) return courier;
  const acted = np.cancelled.length + np.moving.length + np.failed.length;
  if (!acted) {
    if (courier && courier.action === 'not_supported') return { ...courier, action: 'already_cancelled', message: np.message || courier.message };
    return courier;
  }
  const action = np.failed.length ? 'error' : np.moving.length ? 'moving' : 'cancelled';
  if (!courier || courier.action === 'none' || courier.action === 'not_supported') {
    return { action, courier: 'NimbusPost', awb: courier && courier.awb, message: np.message };
  }
  const worst = (RANK[action] ?? 0) > (RANK[courier.action] ?? 0) ? action : courier.action;
  return { ...courier, action: worst, message: `${courier.message || ''} ${np.message}`.trim() };
}

module.exports = { cancelNimbusOrderForGood, withNimbus, classify, numberVariants, baseNumber };
