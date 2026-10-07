/**
 * Ask the courier itself whether a booked parcel has been picked up.
 *
 * The Not Picked Up tab started from what we store, and for most bookings we
 * store nothing after the AWB: Delhivery and Amazon parcels booked through
 * iThink, and DTDC / Ekart / Bluedart ones booked through NimbusPost, send us
 * no scans. On 3 Oct 2026 IC-20260915-IYCBK (Delhivery 21025863355960) sat in
 * the tab as "no scan yet · booked 14d ago" when Delhivery's own page said
 * Delivered. So "no scan recorded" is not evidence of anything, and the tab
 * and the bulk cancel both have to ask.
 *
 * One AWB can be known to several systems (booked in iThink on Delhivery's
 * network, say), so each is asked and the first that knows it wins:
 *   XpressBees courier            -> XpressBees API (direct bookings only)
 *   Delhivery courier             -> Delhivery's tracking API (direct bookings)
 *   pushed to iThink              -> iThink track
 *   pushed to NimbusPost          -> NimbusPost bulk track
 *   Amazon Shipping courier       -> track.amazon.in's public tracker JSON (the
 *                                    iThink track API does not know these AWBs;
 *                                    IC-20260919-XOHQB sat in the tab "no answer"
 *                                    after being delivered on 25 Sep)
 *
 * States, from the courier's words:
 *   waiting    booked, not yet picked up -- the only state a bulk cancel acts on
 *   moved      anything after pickup, including delivered and RTO
 *   cancelled  the courier has voided the AWB
 *   unknown    nobody answered, or the answer was not a status
 * Anything not positively "waiting" is never treated as cancellable.
 */
'use strict';

const { liveStatus: xbLiveStatus } = require('./courier-shipment-cancel');

// Exact phrases only. A bare "pending" is NOT here: in Delhivery's vocabulary
// it means "at the destination hub, pending delivery", i.e. long after pickup.
const WAITING = new Set([
  'manifested', 'not picked', 'not picked up', 'pickup pending', 'pending pickup',
  'pickup scheduled', 'pickup not done', 'pickup rescheduled', 'pickup exception',
  'pickup failed', 'booked', 'awb assigned', 'awb generated', 'ready to ship',
  'new', 'open', 'data received', 'shipment booked', 'order placed', 'awaiting pickup',
  'manifest generated', 'pickup generated', 'out for pickup',
]);
const NOT_A_STATUS = /not found|invalid|no data|no record|error|unauthori[sz]ed|lookup failed/;

const norm = (s) => String(s || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

function pickupState(status) {
  const s = norm(status);
  if (!s || NOT_A_STATUS.test(s)) return 'unknown';
  if (/cancel/.test(s) && !/rto|return/.test(s)) return 'cancelled';
  if (WAITING.has(s)) return 'waiting';
  return 'moved';
}

function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { _raw: text.slice(0, 300) }; }
}

// ── Delhivery (direct account) ────────────────────────────────────────────
async function trackDelhivery(awbs, fetchFn = fetch) {
  const token = process.env.DELHIVERY_API_TOKEN;
  const out = new Map();
  if (!token || !awbs.length) return out;
  const base = process.env.DELHIVERY_BASE || 'https://track.delhivery.com';
  for (const part of chunk(awbs, 50)) {
    try {
      const res = await fetchFn(`${base}/api/v1/packages/json/?waybill=${encodeURIComponent(part.join(','))}`, {
        headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
      });
      const data = await readJson(res);
      for (const s of Array.isArray(data.ShipmentData) ? data.ShipmentData : []) {
        const sh = s.Shipment || {};
        const awb = String(sh.AWB || '').trim();
        if (!awb) continue;
        const st = sh.Status || {};
        // An unpicked shipment that is cancelled stays "Manifested"; only the
        // instructions say so.
        const cancelled = /cancel/i.test(String(st.Instructions || '')) && /manifest/i.test(String(st.Status || ''));
        out.set(awb, { status: cancelled ? 'Cancelled' : String(st.Status || ''), detail: String(st.Instructions || '').slice(0, 120) });
      }
    } catch (_) { /* that chunk stays unknown */ }
  }
  return out;
}

// ── iThink ────────────────────────────────────────────────────────────────
const ITHINK_TRACK_URL = process.env.ITHINK_TRACK_URL || 'https://api.ithinklogistics.com/api_v3/order/track.json';

async function trackIthink(awbs, fetchFn = fetch) {
  const out = new Map();
  const access = process.env.ITHINK_ACCESS_TOKEN;
  const secret = process.env.ITHINK_SECRET_KEY;
  if (!access || !secret || !awbs.length) return out;
  for (const part of chunk(awbs, 10)) {
    try {
      const res = await fetchFn(ITHINK_TRACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { awb_number_list: part.join(','), access_token: access, secret_key: secret } }),
      });
      const data = await readJson(res);
      const rows = data && typeof data.data === 'object' && data.data ? data.data : {};
      for (const [key, rec] of Object.entries(rows)) {
        if (!rec || typeof rec !== 'object') continue;
        if (rec.message && !/success/i.test(String(rec.message))) continue;
        const awb = String(rec.awb_no || key).trim();
        const status = String(rec.current_status || rec.current_status_code || '');
        if (awb && status) {
          const last = rec.last_scan_details || {};
          out.set(awb, { status, detail: String(last.status || last.scan_location || rec.courier || '').slice(0, 120) });
        }
      }
    } catch (_) { /* unknown */ }
  }
  return out;
}

// ── NimbusPost ────────────────────────────────────────────────────────────
async function trackNimbus(awbs, deps = {}) {
  const out = new Map();
  if (!awbs.length) return out;
  const np = deps.nimbus || require('./nimbuspost-cancel');
  let rows = [];
  try { rows = await np.trackNimbusShipments(awbs); } catch (_) { return out; }
  for (const row of rows) {
    const awb = String(row?.awb_number || row?.awb || np.awbFromRow?.(row) || '').trim();
    const status = np.shipmentStatusFromRow ? np.shipmentStatusFromRow(row) : String(row?.status || '');
    if (awb && status) out.set(awb, { status, detail: '' });
  }
  return out;
}

// ── Amazon Shipping ───────────────────────────────────────────────────────
// The public tracking page's own JSON. A parcel counts as waiting only while
// its event history holds nothing past label creation: any scan after that
// (PickupDone, Received, Departed, Delivered…) means it left our hands.
const AMAZON_PRE_PICKUP = /^(creationconfirmed|created|labelcreated|shipmentcreated|pickupscheduled|pickupattempted|pickuprescheduled|readyforpickup)$/i;

function amazonState(json) {
  const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v) || {};
  const history = parse(json.eventHistory);
  const tracker = parse(json.progressTracker);
  const events = Array.isArray(history.eventHistory) ? history.eventHistory : [];
  const codes = events.map((e) => String(e && e.eventCode || '')).filter(Boolean);
  const summary = String((tracker.summary && tracker.summary.status) || '').trim();
  if (!codes.length && !summary) return null;
  if (codes.some((c) => /cancel/i.test(c)) && !codes.some((c) => /pickupdone|received|departed|deliver/i.test(c))) {
    return { status: 'Cancelled', detail: summary };
  }
  if (codes.length && codes.every((c) => AMAZON_PRE_PICKUP.test(c))) return { status: 'Not Picked', detail: summary || 'label created' };
  // Past pickup. Say what Amazon says, but never a phrase that reads as waiting.
  const words = summary && !WAITING.has(norm(summary)) ? summary : `In transit (${codes[codes.length - 1] || 'scanned'})`;
  return { status: words, detail: codes[codes.length - 1] || '' };
}

async function trackAmazon(awbs, fetchFn = fetch) {
  const out = new Map();
  for (const part of chunk(awbs, 5)) {
    await Promise.all(part.map(async (awb) => {
      try {
        const res = await fetchFn(`https://track.amazon.in/api/tracker/${encodeURIComponent(awb)}`, {
          headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36' },
        });
        const data = await readJson(res);
        const st = data && !data._raw ? amazonState(data) : null;
        if (st && st.status) out.set(awb, st);
      } catch (_) { /* unknown */ }
    }));
  }
  return out;
}

// ── XpressBees ────────────────────────────────────────────────────────────
async function trackXpressbees(awbs, deps = {}) {
  const out = new Map();
  const client = deps.xb || require('./xpressbees');
  for (const part of chunk(awbs, 8)) {
    await Promise.all(part.map(async (awb) => {
      try {
        const status = xbLiveStatus(await client.track(awb));
        if (status) out.set(awb, { status, detail: '' });
      } catch (_) { /* unknown */ }
    }));
  }
  return out;
}

/** Which systems may know this order's AWB, most authoritative first. */
function channelsFor(order) {
  const courier = String(order.courier_name || '');
  const list = [];
  if (/xpress/i.test(courier)) list.push('xpressbees');
  if (/delhivery/i.test(courier)) list.push('delhivery');
  if (/amazon/i.test(courier)) list.push('amazon');
  if (order.ithink_pushed_at) list.push('ithink');
  if (order.nimbus_pushed_at || order.last_nimbuspost_status) list.push('nimbuspost');
  // XpressBees AWBs booked through NimbusPost answer "Record not found" on the
  // XpressBees API, and a booking with no push stamp still came from somewhere.
  for (const c of ['ithink', 'nimbuspost']) if (!list.includes(c)) list.push(c);
  return list;
}

/**
 * @param {object[]} orders  rows with tracking_id, courier_name, *_pushed_at
 * @returns {Promise<Map<string, {awb, channel, status, detail, state}>>} keyed by order uuid
 */
async function checkPickups(orders, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const withAwb = orders.filter((o) => String(o.tracking_id || '').trim());
  const want = { xpressbees: new Set(), delhivery: new Set(), amazon: new Set(), ithink: new Set(), nimbuspost: new Set() };
  for (const o of withAwb) for (const c of channelsFor(o)) want[c].add(String(o.tracking_id).trim());

  const [xbMap, dlMap, amMap, itMap, npMap] = await Promise.all([
    trackXpressbees([...want.xpressbees], deps),
    trackDelhivery([...want.delhivery], fetchFn),
    trackAmazon([...want.amazon], fetchFn),
    trackIthink([...want.ithink], fetchFn),
    trackNimbus([...want.nimbuspost], deps),
  ]);
  const maps = { xpressbees: xbMap, delhivery: dlMap, amazon: amMap, ithink: itMap, nimbuspost: npMap };

  const out = new Map();
  for (const o of orders) {
    const awb = String(o.tracking_id || '').trim();
    if (!awb) { out.set(o.id, { awb: '', channel: null, status: '', detail: '', state: 'unknown' }); continue; }
    let hit = null;
    for (const c of channelsFor(o)) {
      const rec = maps[c].get(awb);
      if (rec) { hit = { channel: c, ...rec }; break; }
    }
    out.set(o.id, hit
      ? { awb, channel: hit.channel, status: hit.status, detail: hit.detail, state: pickupState(hit.status) }
      : { awb, channel: null, status: '', detail: '', state: 'unknown' });
  }
  return out;
}

// ── Cancelling ────────────────────────────────────────────────────────────
// Each returns { ok, message }. ok is true ONLY on an explicit success reply:
// a refund follows from it, so "the call did not error" is not enough.
const ITHINK_CANCEL_URL = process.env.ITHINK_CANCEL_URL || 'https://api.ithinklogistics.com/api_v3/order/cancel.json';

async function cancelIthink(awb, fetchFn = fetch) {
  const res = await fetchFn(ITHINK_CANCEL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { access_token: process.env.ITHINK_ACCESS_TOKEN, secret_key: process.env.ITHINK_SECRET_KEY, awb_numbers: String(awb) } }),
  });
  const data = await readJson(res);
  const entries = data && typeof data.data === 'object' && data.data ? Object.values(data.data) : [];
  const mine = entries.find((e) => e && String(e.refnum || e.awb_no || e.awb || awb) === String(awb)) || entries[0];
  const words = String((mine && (mine.status || '')) || '') + ' ' + String((mine && (mine.remark || mine.message || '')) || '');
  const ok = !!mine && /success/i.test(words) && !/fail|not|unable|error/i.test(String(mine.status || ''));
  // An outright refusal comes back as { status: 'error', html_message: '<p>…</p>' }.
  const said = words.trim() || String((data && (data.html_message || data.message)) || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return { ok, message: ok ? `iThink cancelled ${awb}.` : `iThink did not confirm cancelling ${awb}: ${(said || JSON.stringify(data)).slice(0, 200)}` };
}

async function cancelDelhivery(awb, fetchFn = fetch) {
  const token = process.env.DELHIVERY_API_TOKEN;
  if (!token) return { ok: false, message: 'DELHIVERY_API_TOKEN not set' };
  const base = process.env.DELHIVERY_BASE || 'https://track.delhivery.com';
  const res = await fetchFn(`${base}/api/p/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Token ${token}` },
    body: JSON.stringify({ waybill: String(awb), cancellation: 'true' }),
  });
  const data = await readJson(res);
  const ok = res.ok !== false && data.status === true;
  return { ok, message: ok ? `Delhivery cancelled ${awb}.` : `Delhivery did not confirm cancelling ${awb}: ${String(data.remark || data.error || data._raw || '').slice(0, 160)}` };
}

/**
 * Cancel a parcel that checkPickups found WAITING, with whichever system
 * answered for it. Never throws.
 */
async function cancelAtCourier(order, live, deps = {}) {
  const awb = String(order.tracking_id || '').trim();
  const fetchFn = deps.fetch || fetch;
  try {
    if (live.channel === 'xpressbees') {
      const { cancelCourierShipment } = require('./courier-shipment-cancel');
      const r = await cancelCourierShipment(order, deps);
      return { ok: ['cancelled', 'already_cancelled'].includes(r.action), message: r.message };
    }
    if (live.channel === 'nimbuspost') {
      const np = deps.nimbus || require('./nimbuspost-cancel');
      const r = await np.cancelNimbusShipment(awb);
      return { ok: !!r.ok, message: r.ok ? `NimbusPost cancelled ${awb}.` : `NimbusPost would not cancel ${awb}: ${r.error || 'no reason given'}` };
    }
    if (live.channel === 'ithink') return await cancelIthink(awb, fetchFn);
    if (live.channel === 'delhivery') return await cancelDelhivery(awb, fetchFn);
    if (live.channel === 'amazon') return { ok: false, message: `Amazon Shipping ${awb} cannot be cancelled from here — cancel it in the Amazon Shipping / iThink panel, then confirm.` };
    return { ok: false, message: `No courier answered for ${awb}, so it was not cancelled.` };
  } catch (e) {
    return { ok: false, message: `Cancelling ${awb} failed: ${e.message}` };
  }
}

module.exports = { checkPickups, cancelAtCourier, pickupState, channelsFor, amazonState, trackDelhivery, trackIthink, ITHINK_TRACK_URL };
