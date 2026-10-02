/**
 * Orders the courier has not picked up, 48 hours or more after they were placed.
 *
 * Two kinds, because they need different people to act:
 *   not_booked       no AWB at all — nobody has created a shipment yet.
 *   awaiting_pickup  an AWB exists but the parcel has not moved. status
 *                    'shipped' does NOT mean picked up: it is set the moment an
 *                    AWB is created (see cancel-order.js). Movement is recorded
 *                    separately, in shipment_moved_at, by the XpressBees and
 *                    NimbusPost webhooks/syncs, and in the raw courier text.
 *
 * Delhivery / DTDC / Amazon shipments booked outside NimbusPost send us no
 * scans, so "no movement recorded" there may just mean "no feed". Those rows
 * are marked confirmed:false rather than hidden — the admin can check them by
 * hand; XpressBees ones can be checked live from the tab.
 */
const { statusImpliesMovement } = require('./nimbuspost-track');
const { isDefinitelyCod } = require('./order-payment-kind');
const { isReplacementOrder } = require('./replacement-order');

const UNBOOKED = ['paid', 'confirmed', 'cod_pending', 'partial_cod_pending', 'replacement_pending'];
const DEFAULT_MIN_HOURS = 48;
const HOUR = 60 * 60 * 1000;

// Courier text that positively says "waiting for pickup".
const PENDING_RE = /pending|not picked|pickup not done|pickup scheduled|manifest|booked|awb assigned|ready to ship|^new$/;

function hoursBetween(from, to) {
  const t = new Date(from).getTime();
  return Number.isFinite(t) ? (to - t) / HOUR : null;
}

function paymentLabel(order) {
  if (isReplacementOrder(order)) return 'replacement';
  const st = String(order.status || '').toLowerCase();
  if (st === 'partial_cod_pending' || Number(order.advance_paid_paise || 0) > 0) return 'partial_cod';
  return isDefinitelyCod(order) ? 'cod' : 'prepaid';
}

function pincodeOf(address) {
  const m = String(address || '').match(/\b\d{6}\b(?!.*\b\d{6}\b)/s);
  return m ? m[0] : '';
}

/** One order → a row for the tab, or null when it does not belong there. */
function classify(order, now = Date.now(), minHours = DEFAULT_MIN_HOURS) {
  const ageHours = hoursBetween(order.created_at, now);
  if (ageHours == null || ageHours < minHours) return null;

  const status = String(order.status || '').toLowerCase();
  const awb = String(order.tracking_id || '').trim();
  const base = {
    id: order.id,
    order_id: order.razorpay_order_id || order.id,
    status,
    created_at: order.created_at,
    age_hours: Math.floor(ageHours),
    customer_name: order.customer_name || '',
    pincode: pincodeOf(order.customer_address),
    amount_rs: Math.round(Number(order.amount_paise || 0) / 100),
    payment: paymentLabel(order),
  };

  if (!awb) {
    if (!UNBOOKED.includes(status)) return null;
    return { ...base, bucket: 'not_booked', nimbus_pushed_at: order.nimbus_pushed_at || null, confirmed: true };
  }

  // Anything past 'shipped' (in transit, delivered, rto…) has moved, and
  // terminal statuses (cancelled, refunded) are not shipping at all.
  if (status !== 'shipped' && !UNBOOKED.includes(status)) return null;
  if (order.shipment_moved_at) return null;

  const scans = [order.last_courier_status, order.last_nimbuspost_status]
    .map((s) => String(s || '').toLowerCase().trim())
    .filter(Boolean);
  if (scans.some(statusImpliesMovement)) return null;

  const bookedAt = order.awb_assigned_at || order.shipped_at || null;
  const sinceBooking = bookedAt ? hoursBetween(bookedAt, now) : null;
  return {
    ...base,
    bucket: 'awaiting_pickup',
    courier: order.courier_name || '',
    tracking_id: awb,
    tracking_url: order.tracking_url || '',
    booked_at: bookedAt,
    hours_since_booking: sinceBooking == null ? null : Math.floor(sinceBooking),
    last_scan: order.last_courier_status || order.last_nimbuspost_status || '',
    // True only when the courier itself said it is waiting. False = no scan
    // recorded, which for a courier without a feed proves nothing either way.
    confirmed: scans.some((s) => PENDING_RE.test(s)),
  };
}

function summarize(rows) {
  const counts = { total: rows.length, not_booked: 0, awaiting_pickup: 0, awaiting_confirmed: 0, by_courier: {} };
  for (const r of rows) {
    counts[r.bucket]++;
    if (r.bucket === 'awaiting_pickup') {
      if (r.confirmed) counts.awaiting_confirmed++;
      const c = r.courier || 'Unknown';
      counts.by_courier[c] = (counts.by_courier[c] || 0) + 1;
    }
  }
  return counts;
}

module.exports = { classify, summarize, paymentLabel, UNBOOKED, DEFAULT_MIN_HOURS };
