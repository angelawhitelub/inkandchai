/**
 * A counter that actually counts.
 *
 * Ink AI is public and spends money on every call, so it needs a ceiling. Two
 * earlier attempts did not hold:
 *
 *   - A counter in module scope. Every request gets a fresh isolate, so it
 *     reset constantly; a 14-request burst against the live endpoint sailed
 *     through all fourteen.
 *   - Cloudflare's Rate Limiting binding (unsafe.bindings, type "ratelimit").
 *     It binds, limit() returns cleanly, and it never refuses: 14 sequential
 *     calls against a 4-per-10-seconds limit were all allowed. The feature is
 *     in beta and evidently not enabled for this account, and a limiter that
 *     silently allows everything is worse than none, because it looks like one.
 *
 * A Durable Object is the boring answer that works everywhere: one instance per
 * key, single-threaded, so the count is exact. No storage — the window is
 * seconds long and an instance that gets evicted has, by definition, not been
 * used recently, so losing the count costs at most one extra window.
 */

export class RateLimiter {
  constructor() {
    /** @type {Map<string, { count: number, resetAt: number }>} */
    this.buckets = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const limit = Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 15);
    const windowMs = Math.max(1000, (parseInt(url.searchParams.get('window'), 10) || 60) * 1000);
    const key = url.searchParams.get('key') || 'default';

    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, b);
    }
    b.count += 1;

    // One instance is addressed per key, so this map holds one entry in normal
    // use. It can still grow if a caller ever passes varying keys to the same
    // instance; drop what has expired rather than letting that accumulate.
    if (this.buckets.size > 64) {
      for (const [k, v] of this.buckets) if (now >= v.resetAt) this.buckets.delete(k);
    }

    return new Response(JSON.stringify({
      allowed: b.count <= limit,
      count: b.count,
      limit,
      retry_after: Math.max(0, Math.ceil((b.resetAt - now) / 1000)),
    }), { headers: { 'Content-Type': 'application/json' } });
  }
}
