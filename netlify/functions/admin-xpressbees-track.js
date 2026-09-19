/**
 * Netlify Function: admin-xpressbees-track
 * POST /.netlify/functions/admin-xpressbees-track   { "awbs": ["1434...", ...] }
 *
 * Read-only. Returns where each AWB actually is right now.
 *
 * WHY THIS EXISTS
 * ---------------
 * 66 shipments were booked COD that should not have been -- 54 already paid
 * in full, 12 free replacements. What to do about each one depends entirely
 * on how far it has travelled: a shipment still awaiting pickup can be
 * cancelled and rebooked, one in transit can only be corrected by XpressBees
 * support before it goes out for delivery, and one already out for delivery
 * needs the CUSTOMER warned today, because the money is about to be asked for
 * at their door.
 *
 * A panel CSV export answers this too, but it is a snapshot: the export used
 * to triage these was two days old, and by the time anyone read it the
 * shipments had moved. This reads live, so the triage cannot be stale.
 *
 * Nothing here books, cancels or modifies anything.
 */

const { requireAdmin } = require('./utils/admin-auth');
const xb = require('./utils/xpressbees');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body, null, 2) });

const MAX_AWBS = 200;

/**
 * Collapse XpressBees's scan vocabulary into the only distinction that
 * matters here: can this still be stopped, and has the customer been asked
 * for money yet?
 */
function urgency(status) {
  const s = String(status || '').toLowerCase();
  if (/deliver(ed)?$/.test(s) || s === 'delivered') return 'delivered';
  if (/out for delivery|ofd/.test(s))               return 'out_for_delivery';
  if (/rto|return/.test(s))                         return 'returning';
  if (/cancel/.test(s))                             return 'cancelled';
  if (/transit|in-transit|bagged|received|reached|dispatch|pickup done|picked/.test(s)) return 'in_transit';
  if (/pending pickup|booked|manifest|awaiting/.test(s)) return 'stoppable';
  return 'unknown';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS);
  if (block) return block;
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const awbs = (Array.isArray(body.awbs) ? body.awbs : [])
    .map((a) => String(a || '').trim()).filter(Boolean);
  if (!awbs.length) return json(400, { error: 'Pass { awbs: [...] }' });
  if (awbs.length > MAX_AWBS) return json(400, { error: `At most ${MAX_AWBS} AWBs per call` });

  const results = [];
  // Serially, not Promise.all: one shared bearer token, and a burst of 66
  // parallel calls is how you get rate-limited into a half-answered triage.
  for (const awb of awbs) {
    try {
      const d = await xb.track(awb);
      const history = Array.isArray(d?.history) ? d.history : [];
      const last = history.length ? history[history.length - 1] : null;
      const status = d?.status || last?.status_code || last?.message || '';
      results.push({
        awb,
        status,
        urgency: urgency(status || last?.message),
        last_event: last ? String(last.message || last.status_code || '').slice(0, 120) : null,
        last_location: last ? String(last.location || '').slice(0, 60) : null,
        last_at: last ? (last.event_time || last.status_time || null) : null,
      });
    } catch (e) {
      results.push({ awb, error: String(e.message || e).slice(0, 200) });
    }
  }

  const buckets = {};
  for (const r of results) {
    const k = r.error ? 'lookup_failed' : r.urgency;
    buckets[k] = (buckets[k] || 0) + 1;
  }
  return json(200, { checked: results.length, buckets, results });
};
