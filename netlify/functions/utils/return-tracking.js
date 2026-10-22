/**
 * Where is a customer's RETURN parcel right now?
 *
 * A return is a reverse shipment: the courier collects from the customer and
 * delivers to our Delhi office. So for these AWBs "Delivered" means delivered
 * BACK TO US, which is the opposite of what the same word means everywhere
 * else in this codebase. Nothing here may be fed to code that reads forward
 * order statuses.
 *
 * Reverse pickups are booked two ways (process-return.js):
 *   - through NimbusPost (its XpressBees / Delhivery reverse services), or
 *   - directly on our XpressBees account (action 'xpressbees').
 * The AWB alone does not say which, so NimbusPost is asked first for all of
 * them in one batch and XpressBees directly for any it does not know.
 *
 * "RTO" is also inverted: the origin of a reverse shipment is the CUSTOMER, so
 * an RTO-delivered (RT-DL) scan means the parcel went back to them, not to us.
 * That is its own stage and never counts as received.
 *
 * Read-only. Never throws for a single AWB: a lookup that fails is reported as
 * stage 'unknown' with the reason, so one bad AWB cannot hide the rest.
 */

const rto = require('./rto-refund');

/**
 * Stages, in the order a return travels. `rank` lets a later scan win over an
 * earlier one when a courier's headline status lags its own history.
 */
const STAGES = {
  unknown:          { rank: 0, label: 'Status unknown' },
  awaiting_pickup:  { rank: 1, label: 'Waiting for courier pickup' },
  pickup_failed:    { rank: 2, label: 'Pickup attempt failed' },
  picked_up:        { rank: 3, label: 'Picked up from customer' },
  in_transit:       { rank: 4, label: 'On the way to us' },
  out_for_delivery: { rank: 5, label: 'Out for delivery to us' },
  delivered:        { rank: 6, label: 'Delivered back to us' },
  cancelled:        { rank: 7, label: 'Pickup cancelled' },
  returned_to_customer: { rank: 8, label: 'Courier sent it back to the customer' },
};

/**
 * One courier status string -> stage. Order matters: "pickup failed" must be
 * read before "pickup", "undelivered" before "delivered".
 */
function stageOf(raw) {
  const s = String(raw || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return 'unknown';
  if (/cancel/.test(s)) return 'cancelled';
  if (/^rt( |$)|\brto\b|return(ed)? to origin|rt dl|rt it/.test(s)) return /deliver|rt dl/.test(s) && !/undeliver/.test(s) ? 'returned_to_customer' : 'in_transit';
  if (/(pick ?up|pickup).*(fail|exception|not (done|picked)|attempt|reschedul|unsuccess)|not picked|customer (not available|refused)|refused|shipment not ready/.test(s)) return 'pickup_failed';
  if (/undeliver|not delivered|delivery (fail|exception|attempt)|ndr/.test(s)) return 'in_transit';
  if (/^dl$|\bdelivered\b/.test(s)) return 'delivered';
  if (/out for delivery|^ofd$/.test(s)) return 'out_for_delivery';
  if (/picked|pickup done|pick up done|^pu$|^pp$/.test(s)) return 'picked_up';
  if (/transit|^it$|reached|received at|arrived|hub|bagg|dispatch|connected|forwarded|shipped|sorting|in scan|outscan|departed/.test(s)) return 'in_transit';
  if (/pending|booked|manifest|scheduled|assigned|created|new|ready|awaiting|open|^pp$|out for pick ?up|ofp/.test(s)) return 'awaiting_pickup';
  return 'unknown';
}

const XB_CODES = {
  // XpressBees reverse shipments report their own short codes.
  PP: 'awaiting_pickup', OFP: 'awaiting_pickup', PND: 'pickup_failed',
  PUD: 'picked_up', PKD: 'picked_up', PU: 'picked_up',
  IT: 'in_transit', RAD: 'in_transit', EX: 'in_transit',
  OFD: 'out_for_delivery', DL: 'delivered', CAN: 'cancelled',
  // Return-to-origin codes: for a reverse parcel the origin is the customer.
  RT: 'in_transit', 'RT-IT': 'in_transit', 'RT-DL': 'returned_to_customer',
};

function scanStage(scan) {
  const code = String(scan?.status_code || '').toUpperCase().trim();
  if (code && XB_CODES[code]) return XB_CODES[code];
  return stageOf(scan?.status || scan?.message || scan?.status_code);
}

function eventTime(scan) {
  return String(scan?.event_time || scan?.date || scan?.time || scan?.created_at || scan?.updated_at || '').trim();
}

/** Courier timestamps are "YYYY-MM-DD HH:MM[:SS]" in IST; return ISO or ''. */
function toIso(t) {
  const m = String(t || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return '';
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4] || '00'}+05:30`);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/**
 * A courier payload (NimbusPost track/bulk row or XpressBees track data) ->
 * one normalised view. `history` is newest first.
 */
function normalise(payload, source) {
  const history = (Array.isArray(payload?.history) ? payload.history : [])
    .map((h) => ({
      at: toIso(eventTime(h)) || eventTime(h),
      status: String(h?.message || h?.status || h?.status_code || '').trim(),
      code: String(h?.status_code || '').trim(),
      location: String(h?.location || h?.city || '').trim(),
      stage: scanStage(h),
    }))
    .filter((h) => h.status || h.code)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const headline = String(payload?.status || '').trim();
  let stage = stageOf(headline);
  // The delivered-back scan is what everything downstream depends on, so a
  // delivered scan anywhere in the history counts even when the headline lags.
  const deliveredScan = history.find((h) => h.stage === 'delivered');
  const bounced = stage === 'returned_to_customer' || history.some((h) => h.stage === 'returned_to_customer');
  if (bounced) stage = 'returned_to_customer';
  else if (deliveredScan) stage = 'delivered';
  else if (history[0] && STAGES[history[0].stage].rank > STAGES[stage].rank) stage = history[0].stage;
  // A cancellation is final only when it is the latest thing that happened.
  if (stage === 'cancelled' && history[0] && history[0].stage !== 'cancelled' && !/cancel/i.test(headline)) {
    stage = history[0].stage;
  }

  const latest = history[0] || null;
  return {
    source,
    stage,
    label: STAGES[stage].label,
    status: headline || latest?.status || '',
    last_scan: latest ? [latest.status, latest.location].filter(Boolean).join(' · ') : '',
    last_scan_at: latest?.at || '',
    delivered_at: stage !== 'delivered' ? '' : (deliveredScan?.at || latest?.at || ''),
    history: history.slice(0, 30),
  };
}

async function defaultXbTrack(awb) {
  return require('./xpressbees').track(awb);
}

/**
 * Live tracking for many return AWBs.
 * @returns Map<awb, normalised view | { stage:'unknown', error }>
 */
async function trackReturns(awbs, deps = {}) {
  const npTrackMany = deps.npTrackMany || rto.npTrackMany;
  const xbTrack = deps.xbTrack || defaultXbTrack;
  const list = [...new Set(awbs.map((a) => String(a || '').trim()).filter(Boolean))];
  const out = new Map();
  if (!list.length) return out;

  let np = new Map();
  let npError = '';
  try { np = await npTrackMany(list); } catch (e) { npError = e.message; }

  // A payload for some other AWB is worse than none: it would put another
  // parcel's scans on this return.
  const sameAwb = (d, awb) => !d?.awb_number || String(d.awb_number).trim() === awb;

  for (const awb of list) {
    const row = np.get(awb);
    if (row && sameAwb(row, awb) && (Array.isArray(row.history) ? row.history.length : 0) + (row.status ? 1 : 0) > 0) {
      out.set(awb, { awb, ...normalise(row, 'nimbuspost'), raw: deps.raw ? row : undefined });
      continue;
    }
    try {
      const d = await xbTrack(awb);
      if (!sameAwb(d, awb)) throw new Error(`tracking returned a different AWB (${d.awb_number})`);
      out.set(awb, { awb, ...normalise(d, 'xpressbees'), raw: deps.raw ? d : undefined });
    } catch (e) {
      out.set(awb, {
        awb, source: '', stage: 'unknown', label: STAGES.unknown.label, status: '',
        last_scan: '', last_scan_at: '', delivered_at: '', history: [],
        error: [npError && `NimbusPost: ${npError}`, `XpressBees: ${String(e.message || e).slice(0, 160)}`].filter(Boolean).join(' · '),
      });
    }
  }
  return out;
}

module.exports = { trackReturns, normalise, stageOf, STAGES };
