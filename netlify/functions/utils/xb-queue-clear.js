'use strict';

/**
 * Owner's ask (12 Nov 2026): "instead of manually clearing cancelled, can't the
 * system auto cancel it on the XB panel once the order is cancelled".
 *
 * The XpressBees channel importer pulls every order from our feed into the
 * panel's Pending list and never drops one, so a cancelled order kept a live
 * Ship button there until someone pressed "Clear Shipped from XpressBees
 * Pending" or the 09:00 cleanup ran.
 *
 * clearXbQueueRows() runs the same guarded endpoint (xpressbees-order-cancel)
 * for named orders right after an admin cancel, reading only the newest panel
 * pages. Only an unbooked 'new' row with no waybill is ever cancelled; a
 * booked XpressBees shipment is stopped by the courier cancel instead, never
 * here. Every other cancel path (customer, bot, auto-cancel) is picked up by
 * the 15-minute sweep (xpressbees-queue-sweep-scheduled).
 *
 * It reports and never throws: the order is already cancelled by the time
 * this runs. XPRESSBEES_QUEUE_CLEANUP=off turns it off with the jobs.
 */

const INSTANT_PAGES = 3;   // 600 newest rows: a day or two of orders

function cleanupOn() {
  const v = String(process.env.XPRESSBEES_QUEUE_CLEANUP ?? 'on').trim().toLowerCase();
  return !['off', 'false', '0', 'no'].includes(v);
}

async function defaultCancel(body) {
  const res = await require('../xpressbees-order-cancel').handler({
    httpMethod: 'POST',
    path: '/.netlify/functions/xpressbees-order-cancel',
    headers: { 'content-type': 'application/json', 'x-admin-key': process.env.ADMIN_SECRET || '' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = JSON.parse(res.body || '{}'); } catch { /* reported below */ }
  return { statusCode: res.statusCode, data };
}

/**
 * @param {string[]} orderNumbers our order numbers (razorpay_order_id), already cancelled here
 * @returns {{ action: 'cleared'|'none'|'failed'|'off', cleared: string[], failed: string[], message: string }}
 */
async function clearXbQueueRows(orderNumbers, deps = {}) {
  const ids = [...new Set((orderNumbers || []).map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))];
  if (!ids.length) return { action: 'none', cleared: [], failed: [], message: '' };
  if (!cleanupOn()) return { action: 'off', cleared: [], failed: [], message: 'XpressBees panel cleanup is switched off.' };
  const cancel = deps.cancel || defaultCancel;
  try {
    const r = await cancel({
      dry_run: false, any_courier: true, closed_here: true, strict: false,
      order_ids: ids, max_pages: deps.maxPages || INSTANT_PAGES, limit: 50,
    });
    if (r.statusCode !== 200) {
      const msg = String((r.data && r.data.error) || `HTTP ${r.statusCode}`).slice(0, 200);
      return { action: 'failed', cleared: [], failed: ids, message: `XpressBees Pending row not cleared (${msg}); the 15-minute sweep will retry.` };
    }
    const results = Array.isArray(r.data.results) ? r.data.results : [];
    const cleared = results.filter((x) => x.ok).flatMap((x) => x.orders || []);
    const failed = results.filter((x) => !x.ok).flatMap((x) => x.orders || x.ids || []);
    if (failed.length) {
      return { action: 'failed', cleared, failed, message: `XpressBees Pending row not cleared for ${failed.join(', ')}; the 15-minute sweep will retry.` };
    }
    if (cleared.length) {
      return { action: 'cleared', cleared, failed, message: `Removed from XpressBees Pending: ${cleared.join(', ')}.` };
    }
    return { action: 'none', cleared, failed, message: '' };
  } catch (e) {
    console.warn('[xb-queue-clear]', e.message);
    return { action: 'failed', cleared: [], failed: ids, message: `XpressBees Pending row not cleared (${String(e.message).slice(0, 160)}); the 15-minute sweep will retry.` };
  }
}

module.exports = { clearXbQueueRows, INSTANT_PAGES };
