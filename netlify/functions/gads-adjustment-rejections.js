/**
 * The suppression list behind the Google Ads adjustment feed.
 *
 * WHY
 * ---
 * google-ads-adjustments.js rebuilds its upload file from scratch on every
 * fetch: every loss-status order in a rolling 54-day window, every day. Google
 * pulls that URL rather than us pushing to it, so nothing in that path can ever
 * learn an outcome, and a retraction whose conversion never fired is therefore
 * re-sent every day for 54 days and rejected every time.
 *
 * On 15 Sept 2026 that was 1,294 of 2,895 rows. The noise is not harmful on its
 * own -- a rejected row is a no-op and the matching rows still apply -- but it
 * buries any real failure under a permanent error count, which is the whole
 * value of the upload diagnostics.
 *
 * The only feedback channel Google offers is the results export you can
 * download from the Uploads screen. This endpoint takes that file and keeps a
 * list of the order ids it says cannot be matched, which the feed then skips.
 *
 * WHY THIS CANNOT LOSE A RETRACTION
 * ---------------------------------
 * A row Google CAN match never appears as a rejection, so it can never enter
 * the list. Beyond that:
 *
 *   - Only TERMINAL_REJECTION ("this conversion does not exist") is recorded.
 *     Measured across the 14 and 15 Sept 2026 uploads, of 1,270 rows rejected
 *     on the 14th, zero succeeded on the 15th -- the 15 that left the error
 *     list had simply aged out of the window. The failure is terminal.
 *   - Suppression needs MIN_REJECTIONS separate uploads, so one bad day cannot
 *     write anything off.
 *   - A full "Download all" export also carries the accepted rows, and those
 *     are DELETED from the list. So if Google ever matches an id we had written
 *     off, the next export un-suppresses it automatically.
 *
 * TABLE
 * -----
 *   create table if not exists gads_adjustment_rejections (
 *     order_id      text primary key,
 *     reason        text,
 *     rejections    integer not null default 1,
 *     first_seen_at timestamptz not null default now(),
 *     last_seen_at  timestamptz not null default now()
 *   );
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { parseAdjustmentResults, TERMINAL_REJECTION } = require('./utils/google-ads-adjustments');

const TABLE = 'gads_adjustment_rejections';
const CHUNK = 500;

/** Two separate uploads before an id is written off. See the header. */
const MIN_REJECTIONS = 2;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body, null, 2),
});

const chunks = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/**
 * Every suppressed order id. Paginated: `.select()` silently caps at 1000 and
 * this list is expected to run into the thousands.
 */
async function loadSuppressed(supabase, minRejections = MIN_REJECTIONS) {
  const ids = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('order_id')
      .gte('rejections', minRejections)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const row of data) ids.add(row.order_id);
    if (data.length < 1000) return ids;
  }
}

async function ingest(supabase, csvText) {
  const { rejected, accepted } = parseAdjustmentResults(csvText);

  // Only the reason proven not to recur. An unrecognised message is counted for
  // visibility but never suppressed -- see TERMINAL_REJECTION.
  const terminal = rejected.filter(r => TERMINAL_REJECTION.test(r.reason));
  const otherReasons = {};
  for (const r of rejected) {
    if (!TERMINAL_REJECTION.test(r.reason)) {
      otherReasons[r.reason] = (otherReasons[r.reason] || 0) + 1;
    }
  }

  // An id can only be in one half of a single export, but a malformed file
  // could list both; the accepted half wins, because a match is proof.
  const acceptedSet = new Set(accepted);
  const toUpsert = terminal.filter(r => !acceptedSet.has(r.orderId));

  const existing = new Map();
  for (const batch of chunks(toUpsert.map(r => r.orderId), CHUNK)) {
    const { data, error } = await supabase
      .from(TABLE).select('order_id, rejections, first_seen_at').in('order_id', batch);
    if (error) throw new Error(error.message);
    for (const row of data) existing.set(row.order_id, row);
  }

  const now = new Date().toISOString();
  const rows = toUpsert.map(r => {
    const prev = existing.get(r.orderId);
    return {
      order_id: r.orderId,
      reason: r.reason,
      // One export is one observation, however many times it is uploaded.
      rejections: prev ? prev.rejections + 1 : 1,
      first_seen_at: prev ? prev.first_seen_at : now,
      last_seen_at: now,
    };
  });

  let written = 0;
  for (const batch of chunks(rows, CHUNK)) {
    const { error } = await supabase.from(TABLE).upsert(batch, { onConflict: 'order_id' });
    if (error) throw new Error(error.message);
    written += batch.length;
  }

  // Accepted rows come off the list. This is what makes the list self-healing.
  let cleared = 0;
  for (const batch of chunks(accepted, CHUNK)) {
    const { data, error } = await supabase
      .from(TABLE).delete().in('order_id', batch).select('order_id');
    if (error) throw new Error(error.message);
    cleared += (data || []).length;
  }

  const nowSuppressed = rows.filter(r => r.rejections >= MIN_REJECTIONS).length;
  return {
    parsed: { accepted: accepted.length, rejected: rejected.length },
    terminal: terminal.length,
    recorded: written,
    now_suppressed: nowSuppressed,
    still_below_threshold: written - nowSuppressed,
    un_suppressed: cleared,
    min_rejections_to_suppress: MIN_REJECTIONS,
    other_reasons: otherReasons,
  };
}

exports.handler = async (event) => {
  const block = requireAdmin(event);
  if (block) return block;

  let supabase;
  try {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  } catch (e) {
    return json(500, { error: e.message });
  }

  try {
    if (event.httpMethod === 'GET') {
      const suppressed = await loadSuppressed(supabase);
      const { count } = await supabase
        .from(TABLE).select('order_id', { count: 'exact', head: true });
      return json(200, {
        total_recorded: count ?? null,
        suppressed: suppressed.size,
        min_rejections_to_suppress: MIN_REJECTIONS,
      });
    }

    if (event.httpMethod === 'POST') {
      // Accept the CSV as a raw body or wrapped in JSON, so this works from the
      // admin panel and from a plain curl of the downloaded file alike.
      let csvText = event.body || '';
      if (event.isBase64Encoded) csvText = Buffer.from(csvText, 'base64').toString('utf8');
      const trimmed = csvText.trimStart();
      if (trimmed.startsWith('{')) {
        try { csvText = String(JSON.parse(trimmed).csv || ''); } catch { /* raw CSV */ }
      }
      if (!csvText.trim()) return json(400, { error: 'No CSV in the request body.' });

      const summary = await ingest(supabase, csvText);
      if (!summary.parsed.accepted && !summary.parsed.rejected) {
        return json(400, {
          error: 'No adjustment rows found. Upload the file from Google Ads → '
               + 'Uploads → Download all (or Download Errors).',
        });
      }
      return json(200, summary);
    }

    return json(405, { error: 'Method Not Allowed' });
  } catch (error) {
    console.error('[gads-adjustment-rejections]', error.message);
    return json(500, { error: error.message });
  }
};

module.exports.ingest = ingest;          // exported for the end-to-end test
module.exports.loadSuppressed = loadSuppressed;
module.exports.MIN_REJECTIONS = MIN_REJECTIONS;
module.exports.TABLE = TABLE;
