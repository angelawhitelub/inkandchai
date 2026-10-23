/**
 * The XpressBees "Book on XpressBees (API)" run, held on the server.
 *
 * The admin button used to drive the run from the browser, 10 orders a call:
 * minimise or close the tab and the run stopped part-way. Now the tab only
 * starts a job and watches it. This object keeps the job (one at a time, so two
 * tabs cannot book the same orders twice) and works through it in chunks, each
 * chunk its own alarm so every chunk gets fresh time and subrequest limits.
 * The work itself is xpressbees-ship's processOrders; a finished booking run
 * emails the owner the full result (jobFinished).
 *
 * Storage: 'job' is the job without its results; 'r:<n>' holds chunk n's
 * results, so no single value grows with the size of the run.
 */
import routeTable from './routes.generated.js';
import * as blobsNs from './shims/netlify-blobs.js';
import * as bindingsNs from './shims/runtime-bindings.js';

const blobs = blobsNs.default || blobsNs;
const bindings = bindingsNs.default || bindingsNs;

// Per alarm. Quotes are cheap (a saved check costs one KV read); a booking is
// ~8 subrequests (quote, book, order update, notification claim, WhatsApp,
// email), well inside the 1,000 a run may make.
const CHUNK = { preview: 30, book: 12 };
// A chunk that dies part-way is retried by the alarm. Past this many attempts
// the job stops and says so instead of looping.
const MAX_ATTEMPTS = 4;

export class XbBookingJob {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(request) {
    const { action, job } = await request.json().catch(() => ({}));
    return this.ctx.blockConcurrencyWhile(async () => {
      const cur = await this.ctx.storage.get('job');
      if (action === 'status') return Response.json({ job: cur ? await this.withResults(cur) : null });
      if (action === 'dismiss') {
        if (cur && cur.state === 'running') return Response.json({ error: 'A run is still going; it cannot be cleared.' }, { status: 409 });
        await this.ctx.storage.deleteAll();
        return Response.json({ job: null });
      }
      if (action === 'start') {
        if (cur && cur.state === 'running') {
          return Response.json({ error: `An XpressBees ${cur.mode === 'book' ? 'booking' : 'price check'} is already running (${cur.cursor} of ${cur.order_ids.length}).`, job: await this.withResults(cur) }, { status: 409 });
        }
        await this.ctx.storage.deleteAll();
        const next = {
          id: crypto.randomUUID(), mode: job.mode, order_ids: job.order_ids, held: job.held || [],
          courier_id: job.courier_id || '', service: job.service || '',
          state: 'running', cursor: 0, chunks: 0, attempts: 0,
          started_at: Date.now(), updated_at: Date.now(),
        };
        await this.ctx.storage.put('job', next);
        await this.ctx.storage.setAlarm(Date.now());
        return Response.json({ job: await this.withResults(next) });
      }
      return Response.json({ error: 'unknown action' }, { status: 400 });
    });
  }

  async withResults(job) {
    const out = { ...job, booked: [], failed: [], skipped: [...(job.held || [])] };
    const parts = await this.ctx.storage.list({ prefix: 'r:' });
    for (const [, r] of [...parts.entries()].sort((a, b) => Number(a[0].slice(2)) - Number(b[0].slice(2)))) {
      out.booked.push(...(r.booked || []));
      out.failed.push(...(r.failed || []));
      out.skipped.push(...(r.skipped || []));
    }
    out.not_attempted = job.state === 'running' ? [] : job.order_ids.slice(job.cursor);
    return out;
  }

  async alarm() {
    const job = await this.ctx.storage.get('job');
    if (!job || job.state !== 'running') return;
    blobs.bindEnv(this.env);
    bindings.bindEnv(this.env);
    const mod = routeTable.routes['xpressbees-ship'];

    const ids = job.order_ids.slice(job.cursor, job.cursor + (CHUNK[job.mode] || 12));
    if (!ids.length) return this.finish(job, '');

    let result;
    try {
      // Counted before the work, so a chunk that kills the isolate still counts.
      await this.ctx.storage.put('job', { ...job, attempts: job.attempts + 1, updated_at: Date.now() });
      result = await mod.processOrders(ids, { dry_run: job.mode !== 'book', courier_id: job.courier_id || undefined });
    } catch (err) {
      const attempts = job.attempts + 1;
      console.error('[xb-booking-job] chunk failed:', err && err.stack || err);
      if (attempts >= MAX_ATTEMPTS) return this.finish({ ...job, attempts }, 'error', String(err && err.message || err));
      await this.ctx.storage.put('job', { ...job, attempts, last_error: String(err && err.message || err), updated_at: Date.now() });
      await this.ctx.storage.setAlarm(Date.now() + 5000 * attempts);
      return;
    }

    await this.ctx.storage.put(`r:${job.chunks}`, result);
    const next = { ...job, cursor: job.cursor + ids.length, chunks: job.chunks + 1, attempts: 0, last_error: '', updated_at: Date.now() };
    const stop = job.mode === 'book'
      ? ((result.failed || []).some(f => f.kind === 'wallet') ? 'wallet' : (result.failed || []).some(f => f.kind === 'auth') ? 'auth' : '')
      : ((result.failed || []).some(f => f.kind === 'auth') ? 'auth' : '');
    if (stop || next.cursor >= next.order_ids.length) return this.finish(next, stop);
    await this.ctx.storage.put('job', next);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async finish(job, stopReason, error = '') {
    const done = { ...job, state: 'done', stop_reason: stopReason || '', error, finished_at: Date.now(), updated_at: Date.now() };
    await this.ctx.storage.put('job', done);
    try {
      const mod = routeTable.routes['xpressbees-ship'];
      const mail = await mod.jobFinished(await this.withResults(done));
      await this.ctx.storage.put('job', { ...done, email: mail });
    } catch (err) {
      console.error('[xb-booking-job] finish email:', err && err.message || err);
    }
  }
}
