/**
 * Cancel the courier shipment when an order is cancelled from the admin panel.
 *
 * WHY
 * ---
 * Cancelling in admin changed our status and nothing else. On 28 Sept 2026
 * ten orders cancelled by hand still had live XpressBees shipments: three
 * waiting for pickup, four in transit, one coming back, and two DELIVERED --
 * COD parcels handed over for orders our books said were cancelled. Nothing
 * warned anyone, even as our own tracking sync recorded them moving.
 *
 * WHAT IT DOES
 * ------------
 * XpressBees only, where the API can cancel by AWB:
 *   waiting for pickup  -> cancelled with XpressBees, checked LIVE first
 *   already cancelled   -> nothing to do
 *   picked up or later  -> NOT cancelled (the parcel is in a van; voiding its
 *                          AWB would only make it untraceable), and the admin
 *                          is told, so they can ask XpressBees for an RTO
 * Any other courier is reported back as NOT cancelled, so the admin knows to
 * do it in that courier's panel -- the silence was the problem.
 *
 * Never throws: the order is already cancelled when this runs, and a courier
 * failure must come back as a message, not undo or fail the cancellation.
 */

const xb = require('./xpressbees');

// Same allowlist as xpressbees-ship.js: an unrecognised state is refused.
const CANCELLABLE = /^\s*(pending pickup|booked|manifested?|awaiting pickup|data received)\s*$/i;
const ALREADY_CANCELLED = /cancel/i;

/** Current status, the way admin-xpressbees-track reads it (history is newest-first). */
function liveStatus(d) {
  const history = (Array.isArray(d?.history) ? d.history : [])
    .slice()
    .sort((x, y) => String(x.event_time || '').localeCompare(String(y.event_time || '')));
  const last = history.length ? history[history.length - 1] : null;
  return String(d?.status || last?.status_code || last?.message || '').trim();
}

async function cancelCourierShipment(order, deps = {}) {
  const client = deps.xb || xb;
  const awb = String(order?.tracking_id || '').trim();
  const courier = String(order?.courier_name || '').trim();
  if (!awb) return { action: 'none' };

  if (!/xpress/i.test(courier)) {
    return {
      action: 'not_supported', courier, awb,
      message: `${courier || 'Courier'} shipment ${awb} was NOT cancelled automatically. Cancel it in the ${courier || 'courier'} panel.`,
    };
  }

  let state;
  try {
    state = liveStatus(await client.track(awb));
  } catch (e) {
    return { action: 'error', courier, awb,
             message: `Could not read the XpressBees status of ${awb}, so the shipment was NOT cancelled: ${e.message}` };
  }

  if (ALREADY_CANCELLED.test(state)) {
    return { action: 'already_cancelled', courier, awb, state, message: `XpressBees shipment ${awb} was already cancelled.` };
  }
  if (!CANCELLABLE.test(state)) {
    return {
      action: 'moving', courier, awb, state,
      message: `XpressBees shipment ${awb} is "${state || 'unknown'}", too late to cancel. `
             + 'Ask XpressBees support to return it (RTO) before delivery.',
    };
  }

  try {
    await client.cancel(awb);
    return { action: 'cancelled', courier, awb, state, message: `XpressBees shipment ${awb} cancelled.` };
  } catch (e) {
    return { action: 'error', courier, awb, state,
             message: `XpressBees would not cancel ${awb} (${state}): ${e.message}. Cancel it in the XpressBees panel.` };
  }
}

/** Stamp what the courier said, so the order list shows it. Best-effort. */
async function recordCourierCancel(supabase, orderId, result) {
  if (!result || !['cancelled', 'already_cancelled'].includes(result.action)) return;
  try {
    await supabase.from('orders')
      .update({ last_courier_status: 'cancelled', last_courier_status_at: new Date().toISOString() })
      .eq('id', orderId);
  } catch (e) {
    console.warn('[courier-shipment-cancel] could not record:', e.message);
  }
}

module.exports = { cancelCourierShipment, recordCourierCancel, liveStatus, CANCELLABLE };
