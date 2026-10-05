/**
 * The customer's return requests, for the WhatsApp bot's ORDER CONTEXT.
 *
 * Before this the bot could see an order but not that a return had been asked
 * for, so "where is my return / pickup kab hoga / wapas mila?" got a forward
 * delivery status back. Each return now comes with where the reverse pickup is
 * and whether it has reached us, from the tracking the hourly job saves
 * (return-tracking-scheduled.js), read live when that is missing or stale.
 *
 * Read-only. Promises nothing: refund wording is limited to what the row says.
 */

const { trackReturns, STAGES } = require('./return-tracking');

const STALE_MS = 90 * 60 * 1000;
const LIVE_TIMEOUT_MS = 7000;
const WINDOW_DAYS = 120;

const fmt = (t) => {
  const d = t ? new Date(t) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';
};
const rs = (paise) => `₹${Math.round((Number(paise) || 0) / 100)}`;

/** Facts about the refund only; the bot must not add a date or promise. */
function refundLine(ret, received) {
  const amt = ret.refund_amount_paise ? ` of ${rs(ret.refund_amount_paise)}` : '';
  switch (ret.refund_status) {
    case 'awaiting_return_delivery':
      return received
        ? `Refund${amt} to the original payment method is released once the return reaches us; it has reached us, so it is being processed.`
        : `Refund${amt} to the original payment method is released automatically once the returned books reach us.`;
    case 'refunding': return `Refund${amt} is being processed right now.`;
    case 'refunded': case 'completed':
      return `Refund${amt} has been issued${ret.refunded_at ? ` on ${fmt(ret.refunded_at)}` : ''}${ret.refund_ref ? ` (reference ${ret.refund_ref})` : ''}.`;
    case 'manual_payout_pending':
      return `Refund${amt} will be paid by our team${ret.upi_id ? ' to the UPI ID they gave' : ret.bank_account ? ' to the bank account they gave' : ''} after the returned books reach us and are checked.${!ret.upi_id && !ret.bank_account ? ' We have NO UPI ID or bank account for this refund: ask the customer for their UPI ID.' : ''}`;
    case 'manual_refund_pending': return `Refund${amt} will be issued by our team from our side; it is in their queue.`;
    case 'wallet_issued': return `Store credit was issued${ret.wallet_code ? ` (code ${ret.wallet_code})` : ''}.`;
    default: return ret.refund_method ? `Refund method chosen: ${ret.refund_method}.` : '';
  }
}

function statusLine(ret) {
  switch (ret.status) {
    case 'pending': return 'Return request received, waiting for our team to review it.';
    case 'approved': return 'Return approved. The reverse pickup has not been booked yet; our team books it and the customer gets the courier and tracking ID on WhatsApp.';
    case 'pushed_to_nimbus': return 'Return approved and sent to our courier partner. The pickup tracking ID has not been assigned yet.';
    case 'pickup_scheduled': return 'Reverse pickup booked with the courier.';
    case 'rejected': return 'Return request was declined by our team.';
    default: return `Return status: ${ret.status || 'unknown'}.`;
  }
}

function describeReturn(ret, view) {
  const lines = [`RETURN for order ${ret.order_display_id || ret.order_id} (requested ${fmt(ret.created_at) || '—'})`];
  const items = Array.isArray(ret.items) ? ret.items.map((i) => `${i?.title || 'Book'} ×${i?.qty || 1}`).join(', ') : '';
  if (items) lines.push(`Books being returned: ${items}`);
  lines.push(statusLine(ret));
  let received = !!ret.return_delivered_at;
  if (ret.awb) {
    lines.push(`Return pickup: ${ret.courier_name || 'Courier'} AWB ${ret.awb}`);
    if (view && !view.error) {
      received = received || view.stage === 'delivered';
      lines.push(`Return tracking: ${STAGES[view.stage]?.label || view.stage}${view.last_scan ? ` — latest scan: ${view.last_scan}${view.last_scan_at ? ` (${fmt(view.last_scan_at)})` : ''}` : ''}`);
      if (view.stage === 'delivered') lines.push(`The returned parcel was DELIVERED BACK TO US${view.delivered_at ? ` on ${fmt(view.delivered_at)}` : ''}.`);
      if (view.stage === 'pickup_failed') lines.push('The courier could not collect it on the last attempt; they usually retry. If the customer was available, tell them we will ask the courier to reattempt.');
      if (view.stage === 'returned_to_customer') lines.push('The courier marked this return as sent back to the customer instead of to us. Apologise and tell them our team will rebook the pickup.');
      if (view.stage === 'cancelled') lines.push('The courier cancelled this pickup. Tell them our team will rebook it.');
    } else {
      lines.push('Return tracking: not available right now (do not guess where it is).');
    }
  }
  const refund = refundLine(ret, received);
  if (refund) lines.push(refund);
  return lines.join('\n');
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
}

/**
 * @param db supabase client
 * @param from the customer's WhatsApp number
 * @param orderIds IC-… ids the conversation named (their returns are included
 *        even when the return was filed under another phone number)
 */
async function returnsContext(db, from, orderIds = [], deps = {}) {
  const track = deps.trackReturns || trackReturns;
  const ten = String(from || '').replace(/\D/g, '').slice(-10);
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const ors = [];
  if (ten.length === 10) ors.push(`customer_phone.eq.${ten}`, `customer_phone.eq.91${ten}`, `customer_phone.eq.+91${ten}`);
  const ids = [...new Set(orderIds.map((i) => String(i).toUpperCase()).filter((i) => /^IC-[A-Z0-9-]+$/.test(i)))].slice(0, 5);
  for (const id of ids) ors.push(`order_display_id.eq.${id}`);
  if (!ors.length) return '';

  const { data, error } = await db.from('return_requests').select('*')
    .or(ors.join(',')).gte('created_at', since)
    .order('created_at', { ascending: false }).limit(3);
  if (error || !data || !data.length) return '';

  // Saved tracking if it is fresh, otherwise ask the courier (bounded, so a slow
  // courier API cannot hold the reply up).
  const views = new Map();
  const stale = data.filter((r) => r.awb && !r.return_delivered_at
    && !(r.tracking_status && r.tracking_checked_at && Date.now() - Date.parse(r.tracking_checked_at) < STALE_MS));
  if (stale.length) {
    const live = await withTimeout(track(stale.map((r) => r.awb)).catch(() => null), LIVE_TIMEOUT_MS);
    if (live) for (const [k, v] of live) views.set(k, v);
  }
  const viewFor = (r) => {
    const live = views.get(String(r.awb || '').trim());
    if (live && !live.error) return live;
    if (r.tracking_status || r.return_delivered_at) {
      return {
        stage: r.return_delivered_at ? 'delivered' : r.tracking_status,
        last_scan: r.tracking_last_scan || '', last_scan_at: r.tracking_last_scan_at || '',
        delivered_at: r.return_delivered_at || '',
      };
    }
    return live || null;
  };

  return 'Customer\'s RETURN requests (looked up in our database). For a return, "delivered" means the books reached US. '
    + 'Answer return questions from this block only: give the courier, AWB and latest scan, never invent a pickup date or a refund date, '
    + 'and say a refund is done only if this block says it was issued.\n'
    + data.map((r) => describeReturn(r, viewFor(r))).join('\n---\n');
}

module.exports = { returnsContext, describeReturn, refundLine };
