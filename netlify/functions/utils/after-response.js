/**
 * Run work that must outlive the response.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every panel push in this codebase was written as a floating promise:
 *
 *     pushOrderToNimbusPost({...}).catch(e => console.error(...));
 *     return { statusCode: 200, ... };
 *
 * On Netlify's Lambda that usually finished, because the container stayed warm
 * after the response. On Cloudflare Workers it does not: once the handler's
 * Response is returned, anything not registered with ctx.waitUntil() is
 * eligible to be cancelled mid-flight. The push then never happens, nothing
 * records that it did not happen, and the order sits in the admin looking
 * ordinary until someone spots it and pushes it by hand.
 *
 * That is not theoretical -- it is how IC-20260905-Q3Y6Q, IC-20260906-AZ0FM
 * and IC-CW-20260906-KZ667 came to sit unpushed for 31-53 hours while every
 * other order that day pushed in under a second.
 *
 * worker/index.js already puts ctx.waitUntil on the context argument. Handlers
 * simply were not taking it. This wraps that up so a call site cannot forget:
 * pass the context through and the runtime is told to wait.
 *
 * Deliberately never rejects. Every caller treats the push as non-fatal, and a
 * rejected promise handed to waitUntil would surface as a request error on an
 * order that was otherwise accepted successfully.
 */

'use strict';

/**
 * @param {object|undefined} context  the handler's second argument
 * @param {Promise} promise           work to finish after the response is sent
 * @param {string} label              prefix for the failure log line
 * @returns {Promise} the same work, already guarded against rejection
 */
function afterResponse(context, promise, label = 'after-response') {
  const guarded = Promise.resolve(promise).catch((e) => {
    console.error(`[${label}] failed (non-fatal):`, e && e.message || e);
  });
  // No waitUntil (local dev, tests, a direct call) just means we are back to
  // the old floating behaviour rather than crashing.
  if (context && typeof context.waitUntil === 'function') {
    try { context.waitUntil(guarded); } catch { /* runtime declined; keep going */ }
  }
  return guarded;
}

module.exports = { afterResponse };
