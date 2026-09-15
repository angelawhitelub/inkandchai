/**
 * A monthly ceiling on what Ink AI can spend at OpenAI.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE RATE LIMITER
 * ------------------------------------------------
 * RateLimiter caps one IP at 15 messages a minute. That stops one person with a
 * loop. It does nothing about a hundred IPs, a scraper farm, or simply a good
 * month -- the endpoint is public, unauthenticated, and bills a real card on
 * every call. Those are different failure modes and they need different
 * ceilings: one bounds a burst, this one bounds the invoice.
 *
 * WHY A DURABLE OBJECT, AND WHY THIS ONE USES STORAGE
 * ---------------------------------------------------
 * Same reasoning as RateLimiter -- module scope resets every isolate, and the
 * account's rate-limiting binding does not refuse -- with one difference that
 * matters. RateLimiter deliberately keeps its counter in memory because its
 * window is seconds long, so an evicted instance has by definition not been
 * used recently. A month is not seconds. An eviction halfway through September
 * would silently reset the total and hand back the whole budget, which is the
 * one thing this class exists to prevent. So the total goes to storage.
 *
 * The in-memory copy stays the source of truth once loaded, and storage is
 * written through. That makes the read-modify-write synchronous and removes any
 * chance of two concurrent requests both reading the same stale total.
 *
 * WHAT "OVER BUDGET" MEANS
 * -----------------------
 * The check happens before a call, against spend already recorded. The reply
 * that tips the total over the line is therefore allowed to finish -- you
 * cannot know a call's cost until it returns. The overshoot is one reply, a
 * fraction of a cent. Refusing mid-stream to save that would mean charging for
 * tokens and then throwing the answer away.
 */

const MONTH_RE = /^\d{4}-\d{2}$/;
const PREFIX = 'spend:';

export class SpendGuard {
  constructor(state) {
    this.state = state;
    this.month = null;
    this.micros = 0;
  }

  /** Load a month's running total, once per instance per month. */
  async load(month) {
    if (this.month === month) return;
    const stored = await this.state.storage.get(PREFIX + month);
    this.month = month;
    this.micros = Number(stored) || 0;
    // A month we have rolled past can never be read again. Dropping it here
    // costs one list() a month and keeps storage from growing forever.
    const keys = await this.state.storage.list({ prefix: PREFIX });
    const stale = [...keys.keys()].filter((k) => k < PREFIX + month);
    if (stale.length) await this.state.storage.delete(stale);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const month = url.searchParams.get('month');
    if (!MONTH_RE.test(month || '')) {
      return new Response(JSON.stringify({ error: 'bad month' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    const budget = Math.max(0, parseInt(url.searchParams.get('budget_micros'), 10) || 0);
    const add = Math.max(0, parseInt(url.searchParams.get('micros'), 10) || 0);

    await this.load(month);

    if (add) {
      this.micros += add;
      await this.state.storage.put(PREFIX + month, this.micros);
    }

    return new Response(JSON.stringify({
      month,
      spent_micros: this.micros,
      budget_micros: budget,
      // budget 0 means "not configured" and must not lock the bot out.
      over: budget > 0 && this.micros >= budget,
    }), { headers: { 'Content-Type': 'application/json' } });
  }
}
