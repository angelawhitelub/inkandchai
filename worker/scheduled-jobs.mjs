/**
 * Which scheduled jobs run, and who else may start one.
 *
 * Every handler is also an HTTP route (/.netlify/functions/<name>), and that
 * includes the cron jobs. Most of them do no auth of their own -- they were
 * written for Netlify's scheduler, which never came in over HTTP -- and several
 * hold ADMIN_SECRET and use it to enqueue their background worker. So a bare
 * `curl -X POST https://inkandchai.in/.netlify/functions/request-reviews-scheduled`
 * messaged customers, and the same one-liner started refund retries, COD
 * cancellations and WhatsApp broadcasts on demand.
 *
 * The cron path never reaches this check: scheduled() in worker/index.js calls
 * the handler directly. Nor do the in-process self-calls (a scheduler fetching
 * its own -background sibling), which go straight to runHandler. Only a request
 * that arrived from outside the Worker is gated.
 *
 * Kept apart from worker/index.js so it can be tested under plain Node.
 */
import adminAuth from '../netlify/functions/utils/admin-auth.js';

const { requireAdmin } = adminAuth;

// Which scheduled handlers may actually run. A cron expression fans out to
// every handler registered against it, and several money-critical jobs share a
// trigger (auto-cancel-stale-cod and phonepe-reconcile-refunds-scheduled are
// both "15 * * * *"). Listing jobs explicitly means adding a trigger can never
// silently start a job nobody asked for. To enable a job: add its name here AND
// its cron to [triggers] in wrangler.toml.
export const ENABLED_JOBS = new Set([
  // sync / reporting
  'nimbuspost-awb-sync-scheduled',
  'xpressbees-status-sync-scheduled',
  'xpressbees-queue-cleanup-scheduled',
  'support-ticket-sla-scheduled',
  'auto-recover-carts',
  'daily-unshipped-report',
  'not-picked-up-report-scheduled',
  'return-tracking-scheduled',
  'xpressbees-labels-send-scheduled',
  'nimbuspost-labels-send-scheduled',
  'stock-delay-notify-scheduled',
  'deploy-drift-check',
  // money safety nets
  'phonepe-payment-sweep-scheduled',
  'replay-lost-orders',
  'auto-cancel-stale-cod',
  'phonepe-reconcile-scheduled',
  'phonepe-retry-refunds-scheduled',
  'phonepe-reconcile-refunds-scheduled',
  'rto-auto-refund-scheduled',
  'auto-push-replacements-scheduled',
  'nimbuspost-push-sweep-scheduled',
  // customer messaging
  'request-reviews-scheduled',
  'bot-order-followup-background',
  'whatsapp-broadcast-scheduled',
  'whatsapp-broadcast-oneoff',
  // catalogue
  'bestseller-agent-scheduled',
  // auto-mark-delivered is deliberately absent: delivered now comes from the
  // NimbusPost webhook. Run it by hand if orders stick in out_for_delivery.
]);

/**
 * Every name that is a cron job, whether or not it is enabled. A disabled job
 * is still a job: turning its cron off must not leave it open to the public.
 */
export function scheduledJobNames(schedules, enabled = ENABLED_JOBS) {
  return new Set([...Object.keys(schedules || {}), ...enabled]);
}

/**
 * null when the request may proceed, otherwise the 401/403/503 to send back.
 *
 * Owner access only, by the same rules as every admin endpoint: a signed owner
 * session (X-Admin-Token or the admin cookie) or the legacy X-Admin-Key. A
 * support-staff token is refused, since no job is in the staff permission list.
 * Every method is gated, OPTIONS included -- request-reviews-scheduled and most
 * of the others ignore the method and would run on a preflight.
 */
export function refuseAnonymousJobRun(name, request, jobNames) {
  if (!jobNames.has(name)) return null;

  const headers = {};
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;
  // endpointName() in admin-auth reads the function name off the path.
  const event = { path: new URL(request.url).pathname, headers };

  const block = requireAdmin(event, { 'Cache-Control': 'no-store' });
  if (!block) return null;

  console.warn(`[job-guard] refused ${request.method} ${name} (${block.statusCode})`);
  return new Response(block.body, { status: block.statusCode, headers: block.headers });
}
