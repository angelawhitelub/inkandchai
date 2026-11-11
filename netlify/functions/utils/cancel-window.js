'use strict';

/**
 * Owner's switch (12 Nov 2026): "allow cancellations for unshipped orders
 * until they are shipped". While it is ON, a paid order (prepaid, or partial
 * COD's advance) with no AWB yet can be cancelled by the customer for a full
 * refund, from My Orders or the WhatsApp bot, without waiting for the 7-day
 * not-picked-up rule. OFF ("cancellation window closed") puts the usual rules
 * back: 30 minutes for prepaid and partial COD, then 7 days unpicked.
 * COD is not affected: it can already be cancelled until pickup.
 *
 * It rides on the unpicked cancel (utils/unpicked-cancel quoteUnpickedCancel
 * with { untilShipped: true }), so it gets the same claim, courier stop,
 * update-order-status cancel and refund guards.
 *
 * Stored as one small blob (KV `catalog:cancel-until-shipped`); default OFF,
 * and a failed read counts as OFF.
 */
let blobs = null;
try { blobs = require('@netlify/blobs'); } catch { blobs = null; }
const getStore = (name) => {
  if (!blobs || typeof blobs.getStore !== 'function') throw new Error('Blob store is not available');
  return blobs.getStore(name);
};

const STORE = 'catalog';
const KEY = 'cancel-until-shipped';
const TTL_MS = 30000;

let cache = null;
let at = 0;

async function readState() {
  const doc = await getStore(STORE).get(KEY, { type: 'json' });
  return { on: !!(doc && doc.on === true), updated_at: (doc && doc.updated_at) || null, by: (doc && doc.by) || null };
}

/** Is the window open? Cached 30 s per isolate; any failure = closed. */
async function untilShippedOpen() {
  if (cache && Date.now() - at < TTL_MS) return cache.on;
  try { cache = await readState(); } catch (e) {
    console.warn('[cancel-window] read failed, treating as closed:', e.message);
    cache = { on: false, updated_at: null, by: null };
  }
  at = Date.now();
  return cache.on;
}

async function setUntilShipped(on, { by = null } = {}) {
  const doc = { on: on === true, updated_at: new Date().toISOString(), by: by ? String(by).slice(0, 80) : null };
  await getStore(STORE).setJSON(KEY, doc);
  cache = doc;
  at = Date.now();
  return doc;
}

function _reset() { cache = null; at = 0; }

module.exports = { untilShippedOpen, readState, setUntilShipped, KEY, _reset };
