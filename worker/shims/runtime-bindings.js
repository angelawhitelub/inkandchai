/**
 * Worker bindings that are objects, not strings.
 *
 * Under nodejs_compat the runtime copies text bindings onto process.env, which
 * is why 161 handlers written for Netlify read them unchanged. Object bindings
 * -- KV namespaces, rate limiters, Durable Objects -- are not copied, and a
 * handler never sees `env`. worker/shims/netlify-blobs.js solves that for the
 * one KV namespace by having worker/index.js hand it the env per request; this
 * is the same trick, generalised, for anything else a handler needs.
 *
 * get() returns undefined rather than throwing when a binding is absent, so a
 * handler can degrade instead of 500ing -- a local `node --test` run has no
 * Worker env at all.
 */

let _env = null;

/** Called once per request (and per cron) by worker/index.js. */
function bindEnv(env) { _env = env; }

function get(name) { return _env ? _env[name] : undefined; }

module.exports = { bindEnv, get };
