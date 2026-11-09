/**
 * One order, one parcel: the hard guard every courier booking path calls
 * before it books, pushes or exports an order.
 *
 * WHY
 * ---
 * Every path used to check only OUR tracking_id. But a booking can exist that
 * our row does not know about:
 *   - XpressBees books from the panel and pushes the AWB back; push-backs get
 *     lost (28 Sep: 10 booked rows with no AWB here), so the order still looks
 *     unshipped and the next path books it again. IC-20261104-Y3KMW: in transit
 *     with XpressBees, then booked with Ekart as well (9 Nov).
 *   - A NimbusPost panel draft gets a courier assigned in the panel later.
 *   - iThink holds a pushed order until its AWB comes back.
 * So before booking anywhere we ask the XpressBees panel itself, live, and
 * honour every "already handed to a courier" marker on our row.
 *
 * RULES (no force flag bypasses them)
 *   1. tracking_id on the order                      -> refuse, every courier
 *   2. XpressBees panel row for this order is booked  -> refuse, every courier
 *      (not 'new', not 'cancelled'; the AWB field is often blank on booked rows)
 *   3. pushed to the NimbusPost panel                 -> refuse other couriers
 *   4. pushed to iThink or Shiprocket                 -> refuse other couriers
 *      (3 and 4 lift only for orders the admin NAMES in released_elsewhere,
 *      after cancelling them in that panel; never for an "all" run)
 *   5. the XpressBees panel cannot be read            -> refuse (fail closed)
 *
 * Usage, like preorderChecker:
 *   const guard = await bookingGuard({ courier: 'ekart' });
 *   const block = guard(order);   // null = safe; else { kind, reason }
 */
const xb = require('./xpressbees');

const PAGE_LIMIT = 200;
const MAX_PAGES = 25;
const CACHE_MS = 90 * 1000;

const COURIERS = new Set(['xpressbees', 'nimbuspost', 'ekart', 'delhivery', 'ithink', 'shiprocket', 'dtdc']);

/** Panel order numbers carry re-import suffixes (-P, -C1, -R2, -D). */
function baseOrderNumber(n) {
  return String(n || '').trim().toUpperCase().replace(/-(P|C\d*|D|R\d*)$/i, '');
}

function panelState(row) {
  const status = String(row && row.status || '').trim().toLowerCase();
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (status === 'new') return String(row.awb_numbers || row.awb_number || '').trim() ? 'booked' : 'queued';
  return 'booked';
}

let _cache = null;
let _cacheAt = 0;
let _inflight = null;

/** order number -> { state: 'booked'|'queued'|'cancelled', awb } from the XpressBees panel. */
async function readPanelIndex(panelOrders) {
  const seen = new Set();
  const index = new Map();
  const rank = { booked: 3, queued: 2, cancelled: 1 };
  for (let p = 1; p <= MAX_PAGES; p += 1) {
    let out;
    try {
      out = await panelOrders({ params: { limit: String(PAGE_LIMIT), page_no: String(p) } });
    } catch (e) {
      if (p > 1 && /no data found/i.test(e.message)) break;
      throw e;
    }
    const fresh = (out.rows || []).filter((r) => !seen.has(String(r.id)));
    for (const r of out.rows || []) seen.add(String(r.id));
    for (const r of fresh) {
      const key = baseOrderNumber(r.order_number);
      if (!key) continue;
      const state = panelState(r);
      const prev = index.get(key);
      // Several rows for one order: the most "alive" one decides.
      if (!prev || rank[state] > rank[prev.state]) {
        index.set(key, { state, awb: String(r.awb_numbers || r.awb_number || '').trim() || null });
      }
    }
    if (!fresh.length) break;
  }
  return index;
}

/** Cached ~90 s and shared by concurrent callers, so a batch reads the panel once. */
async function xbPanelIndex({ deps = {} } = {}) {
  if (deps.panelOrders) return readPanelIndex(deps.panelOrders);
  if (_cache && Date.now() - _cacheAt < CACHE_MS) return _cache;
  if (!_inflight) {
    _inflight = readPanelIndex(xb.panelOrders)
      .then((index) => { _cache = index; _cacheAt = Date.now(); return index; })
      .finally(() => { _inflight = null; });
  }
  return _inflight;
}

/** Forget the cached panel read (after a booking changes it, and in tests). */
function resetPanelCache() { _cache = null; _cacheAt = 0; }

const orderKey = (order) => String((order && (order.razorpay_order_id || order.id)) || '');

/**
 * The pure rule, for one order, given what the panel says.
 * `released`: order ids the admin named and confirmed are cancelled in the
 * NimbusPost / iThink panel. It lifts rules 3 and 4 only, never 1 or 2.
 * @returns {{kind: string, reason: string}|null}
 */
function blockReason(order, courier, panelRow, released, { rebookingAwb = null } = {}) {
  if (!order) return { kind: 'missing', reason: 'no order' };
  const id = orderKey(order);
  const awb = String(order.tracking_id || '').trim();
  // An XpressBees re-book (cancel_existing) replaces exactly the AWB on the
  // order, after cancelling it live. That AWB, and a panel row that is that
  // same booking, are what it is allowed past; nothing else.
  const rebook = !!rebookingAwb && awb === String(rebookingAwb).trim();
  if (rebook && panelRow && panelRow.state === 'booked' && (!panelRow.awb || panelRow.awb === awb)) panelRow = null;
  if (awb && !rebook) return { kind: 'has_awb', reason: `already has AWB ${awb}${order.courier_name ? ` (${order.courier_name})` : ''}` };
  if (panelRow && panelRow.state === 'booked') {
    return {
      kind: 'xb_panel_booked',
      reason: `XpressBees panel already has ${id} booked${panelRow.awb ? ` (AWB ${panelRow.awb})` : ''}; its AWB never reached our records. Sync it, do not book again`,
    };
  }
  const isReleased = released && released.has(id.toUpperCase());
  if (order.nimbus_pushed_at && courier !== 'nimbuspost' && !isReleased) {
    return { kind: 'pushed_elsewhere', reason: 'already pushed to the NimbusPost panel; cancel it there first, then confirm' };
  }
  if (order.ithink_pushed_at && courier !== 'ithink' && !isReleased) {
    return { kind: 'pushed_elsewhere', reason: 'already pushed to iThink; cancel it there first, then confirm' };
  }
  if (order.shiprocket_order_id && courier !== 'shiprocket' && !isReleased) {
    return { kind: 'pushed_elsewhere', reason: `already in Shiprocket as ${order.shiprocket_order_id}; cancel it there first, then confirm` };
  }
  return null;
}

/**
 * Load what is needed once per batch and return a checker.
 * @param {{courier: string, released?: string[], deps?: object}} opts
 * @returns {Promise<(order) => ({kind, reason}|null)>}
 */
async function bookingGuard({ courier, released = [], deps = {} } = {}) {
  if (!COURIERS.has(courier)) throw new Error(`bookingGuard: unknown courier ${courier}`);
  const releasedSet = new Set((released || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean));
  let index;
  try {
    index = await xbPanelIndex({ deps });
  } catch (e) {
    const out = {
      kind: 'guard_unavailable',
      reason: `could not read the XpressBees panel to rule out an existing booking (${String(e.message || e).slice(0, 120)}); not booking blind, try again in a minute`,
    };
    const blockAll = () => out;
    blockAll.unavailable = out.reason;
    return blockAll;
  }
  const check = (order, opts) => blockReason(order, courier, index.get(baseOrderNumber(orderKey(order))), releasedSet, opts);
  check.panelRows = index.size;
  return check;
}

/** One-order form for paths that book a single order deep inside a helper. Throws. */
async function assertBookable(order, courier, opts = {}) {
  const guard = await bookingGuard({ courier, ...opts });
  const block = guard(order);
  if (block) {
    const err = new Error(`Not booked: ${block.reason}`);
    err.guard = block;
    throw err;
  }
}

/** `released_elsewhere` from a request: only for named orders, never for "all". */
function releasedFrom(body, namedIds) {
  if (!body || !Array.isArray(body.released_elsewhere)) return [];
  const named = new Set((namedIds || []).map((s) => String(s).trim().toUpperCase()));
  return body.released_elsewhere.map((s) => String(s).trim().toUpperCase()).filter((s) => named.has(s));
}

module.exports = {
  bookingGuard, assertBookable, blockReason, releasedFrom,
  xbPanelIndex, resetPanelCache, baseOrderNumber, panelState,
};
