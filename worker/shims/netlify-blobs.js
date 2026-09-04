/**
 * @netlify/blobs stand-in backed by Workers KV.
 *
 * Only the surface utils/order-fallback.js and utils/orders-backup.js actually
 * use is implemented: getStore(name) -> { get, set, delete, list }, plus a
 * no-op connectLambda (Netlify needed it to recover request context; Workers
 * does not).
 *
 * This is the lost-orders pen: when Supabase is unreachable at checkout the
 * order row is parked here and replayed later by replay-lost-orders. Losing a
 * write here means losing a paid order, so set() surfaces failures rather than
 * swallowing them.
 */
const BINDING = 'ORDER_FALLBACK';

let _env = null;
// The KV binding lives on the Worker's env, which the handlers never see.
// worker/index.js calls this once per request before dispatching.
function bindEnv(env) { _env = env; }

function kv() {
  const ns = _env && _env[BINDING];
  if (!ns) throw new Error(`[blobs] KV binding ${BINDING} is not configured`);
  return ns;
}

function connectLambda() { /* no-op on Workers */ }

function getStore(nameOrOpts) {
  const name = typeof nameOrOpts === 'string' ? nameOrOpts : (nameOrOpts && nameOrOpts.name) || 'default';
  const prefix = `${name}:`;

  return {
    async get(key, opts) {
      const type = opts && opts.type;
      const raw = await kv().get(prefix + key, 'text');
      if (raw === null || raw === undefined) return null;
      if (type === 'json') { try { return JSON.parse(raw); } catch { return null; } }
      return raw;
    },

    async set(key, value, _opts) {
      const body = typeof value === 'string' ? value : JSON.stringify(value);
      await kv().put(prefix + key, body);
    },

    async setJSON(key, value) {
      await kv().put(prefix + key, JSON.stringify(value));
    },

    async delete(key) {
      await kv().delete(prefix + key);
    },

    // Netlify returns { blobs: [{ key }] }. KV paginates at 1000 keys; the pen
    // is meant to stay near-empty, but page anyway so a backlog is not silently
    // truncated to the first page.
    async list() {
      const blobs = [];
      let cursor;
      do {
        const page = await kv().list({ prefix, cursor });
        for (const k of page.keys) blobs.push({ key: k.name.slice(prefix.length) });
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return { blobs };
    },
  };
}

module.exports = { getStore, connectLambda, bindEnv };
