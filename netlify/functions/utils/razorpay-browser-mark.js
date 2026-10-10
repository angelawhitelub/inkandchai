/**
 * "The customer's browser came back for this Razorpay payment."
 *
 * WHY
 * ---
 * razorpay-webhook and verify-payment race to save every Razorpay order. On
 * Cloudflare the webhook wins every time: Razorpay posts payment.captured the
 * moment the payment clears, while the browser is still closing the checkout
 * and verify-payment is still checking the amount and resolving the cart. From
 * 28 Sep to 10 Oct 2026 not one Razorpay order was saved by verify-payment, so
 * every one of them mailed the owner "⚡ Recovered Payment — the browser
 * callback did not fire" although the browser had come back fine.
 *
 * The webhook still saves the order at once (a captured payment must never
 * wait on a browser). Only the owner's "recovered" alert waits: verify-payment
 * marks the payment here, the webhook looks after a grace period, and only an
 * unmarked payment is a real recovery.
 *
 * KV ORDER_FALLBACK, one key per payment, an hour. Without KV (local runs)
 * nothing is marked and the webhook alerts as it always did.
 */
'use strict';

const bindings = require('../../../worker/shims/runtime-bindings');

const PREFIX = 'rzp-browser:';
const TTL_SECONDS = 3600;
// Cloudflare keeps waitUntil work alive for 30 s after the response.
const GRACE_MS = 20000;

const kvOf = (deps) => ('kv' in deps ? deps.kv : bindings.get('ORDER_FALLBACK'));

async function markBrowserReturned(paymentId, deps = {}) {
  const kv = kvOf(deps);
  if (!kv || !paymentId) return false;
  try {
    await kv.put(PREFIX + paymentId, new Date().toISOString(), { expirationTtl: TTL_SECONDS });
    return true;
  } catch (e) {
    console.warn('[razorpay-browser-mark] not marked:', e.message);
    return false;
  }
}

/** true / false, or null when KV cannot say (absent or failing). */
async function browserReturned(paymentId, deps = {}) {
  const kv = kvOf(deps);
  if (!kv || !paymentId) return null;
  try {
    return !!(await kv.get(PREFIX + paymentId));
  } catch (e) {
    console.warn('[razorpay-browser-mark] unreadable:', e.message);
    return null;
  }
}

/**
 * Wait out the grace period, then run `alert` unless the browser came back.
 * Resolves to 'browser' (skipped) or 'alerted'.
 */
async function alertUnlessBrowserReturned(paymentId, alert, deps = {}) {
  const graceMs = 'graceMs' in deps ? deps.graceMs : GRACE_MS;
  if (graceMs > 0) await new Promise((r) => setTimeout(r, graceMs));
  if (await browserReturned(paymentId, deps)) {
    console.log(`[razorpay-webhook] ${paymentId}: browser came back, no recovery alert`);
    return 'browser';
  }
  await alert();
  return 'alerted';
}

module.exports = { markBrowserReturned, browserReturned, alertUnlessBrowserReturned, GRACE_MS };
