'use strict';

/**
 * "Push anyway" for the handling-time hold (owner, 12 Nov 2026). An order whose
 * book has extra handling days stays out of every courier path until its
 * handover date (utils/preorder-hold holdFromHandling). When the owner has the
 * stock ready sooner, they release named orders here and every courier path
 * (XpressBees API and feed, NimbusPost, Delhivery, Ekart, DTDC, iThink) treats
 * them as free from the next run.
 *
 * Only the HANDLING hold is lifted. A pre-order still waits for its publish
 * date; the 30-minute window, a customer's cancel request and the booking
 * guard all still apply.
 *
 * One small blob (KV `catalog:handling-released`): { orders: { "IC-...": { at, by } } }.
 * No SQL. Entries older than 60 days are dropped on the next write. Read fresh
 * on every check (one KV read per run), so a release takes effect at once.
 */
let blobs = null;
try { blobs = require('@netlify/blobs'); } catch { blobs = null; }
const getStore = (name) => {
  if (!blobs || typeof blobs.getStore !== 'function') throw new Error('Blob store is not available');
  return blobs.getStore(name);
};

const STORE = 'catalog';
const KEY = 'handling-released';
const KEEP_MS = 60 * 86400000;
const MAX_ORDERS = 5000;

const norm = (id) => String(id || '').trim().toUpperCase();

async function readDoc() {
  const doc = await getStore(STORE).get(KEY, { type: 'json' });
  return doc && doc.orders && typeof doc.orders === 'object' ? doc.orders : {};
}

/** Set of released order numbers. A failed read is an empty set (orders stay held). */
async function releasedOrders() {
  try { return new Set(Object.keys(await readDoc()).map(norm)); }
  catch (e) { console.warn('[handling-release] read failed, nothing released:', e.message); return new Set(); }
}

/** Releases (on) or re-holds (off) these orders. Returns { released, count }. */
async function setReleased(orderIds, on, { by = null } = {}) {
  const ids = [...new Set((orderIds || []).map(norm).filter(Boolean))];
  if (!ids.length) throw new Error('No order numbers given');
  if (ids.length > 1000) throw new Error('At most 1000 orders at a time');
  const orders = await readDoc();
  const now = Date.now();
  for (const [k, v] of Object.entries(orders)) {
    if (!v || !Number.isFinite(Date.parse(v.at)) || now - Date.parse(v.at) > KEEP_MS) delete orders[k];
  }
  for (const id of ids) {
    if (on) orders[id] = { at: new Date(now).toISOString(), by: by ? String(by).slice(0, 80) : null };
    else delete orders[id];
  }
  if (Object.keys(orders).length > MAX_ORDERS) throw new Error(`At most ${MAX_ORDERS} released orders can be kept`);
  await getStore(STORE).setJSON(KEY, { orders, updated_at: new Date(now).toISOString() });
  return { released: ids, on: !!on, count: Object.keys(orders).length };
}

module.exports = { releasedOrders, setReleased, KEY, norm };
