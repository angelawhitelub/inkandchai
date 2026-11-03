'use strict';

/**
 * Delivery receipts for marketing sends that keep a ledger row
 * (whatsapp_campaign_deliveries, e.g. new-title alerts).
 *
 * Meta accepts a marketing template at send time and may still drop it later
 * -- most often 131049, its per-user marketing limit. That arrives only as a
 * webhook status, so the sender records the wamid in metadata.wamid and the
 * webhook (whatsapp-bot) writes the outcome back here:
 *   failed     → status 'failed', error, metadata.meta_failed / failed_code
 *   delivered  → metadata.delivered_at
 *   read       → metadata.read_at
 *
 * Lookups go by (customer_phone, metadata->>wamid) on the phone index, and
 * only for failures and for receipts Meta prices as marketing, so order and
 * support messages cost no extra query.
 */

const TABLE = 'whatsapp_campaign_deliveries';

function statusesOf(body) {
  const out = [];
  for (const entry of (body && body.entry) || []) {
    for (const change of (entry && entry.changes) || []) {
      for (const st of (change && change.value && change.value.statuses) || []) if (st && st.id) out.push(st);
    }
  }
  return out;
}

function worthLooking(st) {
  if (st.status === 'failed') return true;
  if (st.status !== 'delivered' && st.status !== 'read') return false;
  return /marketing/i.test(String((st.pricing && st.pricing.category) || (st.conversation && st.conversation.origin && st.conversation.origin.type) || ''));
}

/** What a receipt changes on a ledger row, or null when nothing. */
function patchFor(row, st) {
  const meta = { ...(row.metadata || {}) };
  const at = st.timestamp ? new Date(Number(st.timestamp) * 1000).toISOString() : new Date().toISOString();
  if (st.status === 'failed') {
    if (meta.meta_failed) return null;
    const err = (st.errors || [])[0] || {};
    meta.meta_failed = true;
    meta.failed_code = err.code != null ? Number(err.code) : null;
    meta.failed_at = at;
    const error = [err.code, err.title, err.error_data && err.error_data.details].filter(Boolean).join(' — ').slice(0, 1000) || 'failed after send';
    return { status: 'failed', error, metadata: meta, updated_at: new Date().toISOString() };
  }
  if (meta.meta_failed) return null;
  if (st.status === 'read') {
    if (meta.read_at) return null;
    meta.read_at = at;
    if (!meta.delivered_at) meta.delivered_at = at;
  } else {
    if (meta.delivered_at) return null;
    meta.delivered_at = at;
  }
  return { metadata: meta, updated_at: new Date().toISOString() };
}

async function recordCampaignReceipts(db, body) {
  let updated = 0;
  for (const st of statusesOf(body).filter(worthLooking)) {
    try {
      const { data, error } = await db.from(TABLE).select('id,status,metadata')
        .eq('customer_phone', String(st.recipient_id || '')).eq('metadata->>wamid', st.id).limit(1);
      if (error || !data || !data[0]) continue;
      const patch = patchFor(data[0], st);
      if (!patch) continue;
      const { error: upErr } = await db.from(TABLE).update(patch).eq('id', data[0].id);
      if (upErr) console.error('[campaign-receipts] update:', upErr.message);
      else updated++;
    } catch (e) {
      console.error('[campaign-receipts]', e.message);
    }
  }
  return updated;
}

/** Totals for one campaign's ledger rows. */
function summarize(rows) {
  const r = { attempted: 0, accepted: 0, delivered: 0, read: 0, failed_by_meta: 0, failed_at_send: 0, waiting: 0, failed_codes: {} };
  for (const row of rows || []) {
    const m = row.metadata || {};
    r.attempted++;
    if (m.wamid) r.accepted++;
    if (m.meta_failed) {
      r.failed_by_meta++;
      const code = m.failed_code == null ? 'other' : String(m.failed_code);
      r.failed_codes[code] = (r.failed_codes[code] || 0) + 1;
    } else if (row.status === 'failed') r.failed_at_send++;
    else if (m.read_at) { r.read++; r.delivered++; }
    else if (m.delivered_at) r.delivered++;
    else if (m.wamid) r.waiting++;
  }
  return r;
}

module.exports = { recordCampaignReceipts, patchFor, worthLooking, statusesOf, summarize, TABLE };
