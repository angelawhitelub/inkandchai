/**
 * Scheduled jobs are HTTP routes too, and most of them do no auth: an anonymous
 * POST to /.netlify/functions/request-reviews-scheduled messaged customers, and
 * the same worked for refund retries, COD cancellation and WhatsApp broadcasts.
 * worker/scheduled-jobs.mjs refuses them unless the caller is the owner.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

process.env.ADMIN_SECRET = 'test-admin-secret-for-job-guard';
delete process.env.ADMIN_TOKEN_SECRET;

const root = path.join(__dirname, '..', '..', '..');
const auth = require('./admin-auth');
const load = () => import(path.join(root, 'worker', 'scheduled-jobs.mjs'));

// The real cron table, as the Worker sees it. routes.generated.js itself cannot
// be required here -- it pulls in every handler -- so read its schedules block.
function realSchedules() {
  const src = fs.readFileSync(path.join(root, 'worker', 'routes.generated.js'), 'utf8');
  const m = src.match(/const schedules = (\{[\s\S]*?\});/);
  assert.ok(m, 'schedules block not found in routes.generated.js');
  return JSON.parse(m[1]);
}

const req = (name, { method = 'POST', headers = {} } = {}) =>
  new Request(`https://inkandchai.in/.netlify/functions/${name}`, { method, headers });

test('every cron job refuses an anonymous request, whatever the method', async () => {
  const { ENABLED_JOBS, scheduledJobNames, refuseAnonymousJobRun } = await load();
  const schedules = realSchedules();
  const names = scheduledJobNames(schedules, ENABLED_JOBS);

  // The ones that prompted this, by name, so a refactor cannot drop them.
  for (const n of ['request-reviews-scheduled', 'whatsapp-broadcast-scheduled', 'whatsapp-broadcast-oneoff',
    'auto-cancel-stale-cod', 'phonepe-retry-refunds-scheduled', 'bot-order-followup-background',
    'nimbuspost-push-sweep-scheduled', 'auto-push-replacements-scheduled', 'daily-unshipped-report',
    'bestseller-agent-scheduled']) {
    assert.ok(names.has(n), `${n} is not guarded`);
  }
  for (const n of Object.keys(schedules)) assert.ok(names.has(n), `${n} is scheduled but not guarded`);

  for (const name of names) {
    // OPTIONS too: most of these ignore the method and would run on a preflight.
    for (const method of ['POST', 'GET', 'OPTIONS', 'PUT']) {
      const res = refuseAnonymousJobRun(name, req(name, { method }), names);
      assert.ok(res, `${method} ${name} was let through`);
      assert.strictEqual(res.status, 401, `${method} ${name}`);
      assert.strictEqual(res.headers.get('cache-control'), 'no-store');
    }
  }
});

test('a wrong key is refused', async () => {
  const { ENABLED_JOBS, scheduledJobNames, refuseAnonymousJobRun } = await load();
  const names = scheduledJobNames(realSchedules(), ENABLED_JOBS);
  const res = refuseAnonymousJobRun('request-reviews-scheduled',
    req('request-reviews-scheduled', { headers: { 'X-Admin-Key': 'nope' } }), names);
  assert.strictEqual(res.status, 401);
  const forged = refuseAnonymousJobRun('request-reviews-scheduled',
    req('request-reviews-scheduled', { headers: { 'X-Admin-Token': 'v1.e30.AAAA' } }), names);
  assert.strictEqual(forged.status, 401);
});

test('the owner can still run a job by hand', async () => {
  const { ENABLED_JOBS, scheduledJobNames, refuseAnonymousJobRun } = await load();
  const names = scheduledJobNames(realSchedules(), ENABLED_JOBS);
  const token = auth.signAdminToken({ sub: 'email:owner@example.com', role: 'owner' });
  const name = 'auto-cancel-stale-cod';

  assert.strictEqual(refuseAnonymousJobRun(name, req(name, { headers: { 'X-Admin-Key': process.env.ADMIN_SECRET } }), names), null);
  assert.strictEqual(refuseAnonymousJobRun(name, req(name, { headers: { 'X-Admin-Token': token } }), names), null);
  assert.strictEqual(refuseAnonymousJobRun(name, req(name, { headers: { Cookie: `${auth.ADMIN_COOKIE_NAME}=${token}` } }), names), null);
  // The admin panel's Bestsellers "Run now" button (adminFetch sends the token).
  assert.strictEqual(refuseAnonymousJobRun('bestseller-agent-scheduled',
    req('bestseller-agent-scheduled', { headers: { 'X-Admin-Token': token } }), names), null);
  // The oneoff campaign's read-only GET status check still works for the owner.
  assert.strictEqual(refuseAnonymousJobRun('whatsapp-broadcast-oneoff',
    req('whatsapp-broadcast-oneoff', { method: 'GET', headers: { 'X-Admin-Key': process.env.ADMIN_SECRET } }), names), null);
});

test('a support-staff session cannot start a job', async () => {
  const { ENABLED_JOBS, scheduledJobNames, refuseAnonymousJobRun } = await load();
  const names = scheduledJobNames(realSchedules(), ENABLED_JOBS);
  const staff = auth.signAdminToken({ sub: 'staff:1', role: 'support' });
  const res = refuseAnonymousJobRun('phonepe-retry-refunds-scheduled',
    req('phonepe-retry-refunds-scheduled', { headers: { 'X-Admin-Token': staff } }), names);
  assert.strictEqual(res.status, 403);
});

test('everything that is not a cron job is untouched', async () => {
  const { ENABLED_JOBS, scheduledJobNames, refuseAnonymousJobRun } = await load();
  const names = scheduledJobNames(realSchedules(), ENABLED_JOBS);
  // Public endpoints, webhooks, and the -background workers the schedulers
  // enqueue (those do their own requireAdmin).
  for (const n of ['catalog-search', 'cod-order', 'phonepe-webhook', 'nimbuspost-webhook', 'product-page',
    'nimbuspost-awb-sync-background', 'phonepe-retry-refunds-background', 'auto-mark-delivered', 'no-such-fn']) {
    assert.strictEqual(refuseAnonymousJobRun(n, req(n), names), null, n);
  }
});

test('a disabled job is still guarded', async () => {
  const { scheduledJobNames, refuseAnonymousJobRun } = await load();
  // Turning a job's cron off must not leave it open to the public.
  const names = scheduledJobNames({ 'some-job-scheduled': '0 * * * *' }, new Set());
  assert.strictEqual(refuseAnonymousJobRun('some-job-scheduled', req('some-job-scheduled'), names).status, 401);
});

test('fails closed when ADMIN_SECRET is unset', async () => {
  const { ENABLED_JOBS, scheduledJobNames, refuseAnonymousJobRun } = await load();
  const names = scheduledJobNames(realSchedules(), ENABLED_JOBS);
  const saved = process.env.ADMIN_SECRET;
  delete process.env.ADMIN_SECRET;
  try {
    const res = refuseAnonymousJobRun('request-reviews-scheduled',
      req('request-reviews-scheduled', { headers: { 'X-Admin-Key': '' } }), names);
    assert.strictEqual(res.status, 503);
  } finally {
    process.env.ADMIN_SECRET = saved;
  }
});

test('the Worker gates only the public entry point, not cron or self-calls', () => {
  const src = fs.readFileSync(path.join(root, 'worker', 'index.js'), 'utf8');

  const fetchStart = src.indexOf('async fetch(request, env, ctx)');
  const scheduledStart = src.indexOf('async scheduled(event, env, ctx)');
  assert.ok(fetchStart > 0 && scheduledStart > fetchStart);
  const publicFetch = src.slice(fetchStart, scheduledStart);
  const fnBranch = publicFetch.slice(publicFetch.indexOf('if (url.pathname.startsWith(FN_PREFIX))'));
  const guardAt = fnBranch.indexOf('refuseAnonymousJobRun(name, request, JOB_NAMES)');
  const runAt = fnBranch.indexOf('return runHandler(name, request, env, ctx)');
  assert.ok(guardAt > 0 && guardAt < runAt, 'the guard must run before the handler on /.netlify/functions/*');

  // A scheduler enqueues its -background sibling through the patched fetch,
  // in-process, with no browser headers. Gating there would break every job.
  const selfCall = src.slice(src.indexOf('globalThis.fetch = async function patchedFetch'), src.indexOf('async function runImageCdn'));
  assert.ok(selfCall.includes('runHandler('), 'self-call interception moved');
  assert.ok(!selfCall.includes('refuseAnonymousJobRun'), 'self-calls must not be gated');
  assert.ok(!src.slice(scheduledStart).includes('refuseAnonymousJobRun'), 'cron must not be gated');

  // And runHandler itself stays ungated for the same reason.
  const rh = src.slice(src.indexOf('async function runHandler('), src.indexOf('// ── Deleted product pages'));
  assert.ok(!rh.includes('refuseAnonymousJobRun'));
});
