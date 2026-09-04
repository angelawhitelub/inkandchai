/**
 * Cloudflare Worker entrypoint for inkandchai.in.
 *
 * Serves the generated static site from the ASSETS binding and runs all 149
 * Netlify function handlers unmodified behind an adapter that converts a
 * Workers Request into the Netlify (event, context) shape and the returned
 * { statusCode, headers, body } back into a Response.
 *
 * Handlers are required statically via worker/routes.generated.js because the
 * Workers bundler cannot resolve a dynamic require path.
 */
// The route table and shims are CommonJS (the handlers they wrap are too);
// esbuild handles the interop. This file must be ESM so wrangler treats the
// Worker as module format — Service Worker format has no Node builtins.
import routeTable from './routes.generated.js';
import * as blobsNs from './shims/netlify-blobs.js';

const { routes, schedules: declaredSchedules } = routeTable;

// The Workers Free plan allows 5 cron triggers per ACCOUNT, so jobs have to
// share expressions. phonepe-payment-sweep is declared */10 in netlify.toml;
// folding it onto the */5 trigger that replay-lost-orders already uses keeps us
// at 5 triggers and runs the sweep more often, not less.
const CRON_OVERRIDES = {
  'phonepe-payment-sweep-scheduled': '*/5 * * * *',
};
const schedules = { ...declaredSchedules, ...CRON_OVERRIDES };
const blobs = blobsNs.default || blobsNs;

const FN_PREFIX = '/.netlify/functions/';

// Netlify ran *-background handlers asynchronously and returned 202 straight
// away. Reproduce that with waitUntil so the caller is not held open for a job
// that can take minutes.
const isBackground = (name) => name.endsWith('-background');

function methodAllowsBody(method) {
  return method !== 'GET' && method !== 'HEAD';
}

async function toNetlifyEvent(request, name) {
  const url = new URL(request.url);

  const headers = {};
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;

  // Netlify collapses repeated params into queryStringParameters (last wins)
  // and exposes the full set via multiValueQueryStringParameters.
  const queryStringParameters = {};
  const multiValueQueryStringParameters = {};
  for (const [k, v] of url.searchParams) {
    queryStringParameters[k] = v;
    (multiValueQueryStringParameters[k] ||= []).push(v);
  }

  let body = null;
  let isBase64Encoded = false;
  if (methodAllowsBody(request.method)) {
    const buf = await request.arrayBuffer();
    if (buf.byteLength) {
      const bytes = new Uint8Array(buf);
      const type = (headers['content-type'] || '').toLowerCase();
      // Signature checks (PhonePe, Razorpay, Meta) hash the raw body, so text
      // payloads must survive byte-for-byte. Binary uploads go base64, matching
      // what Netlify did.
      const textual = /json|text|xml|x-www-form-urlencoded|javascript/.test(type);
      if (textual) {
        body = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      } else {
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        body = btoa(bin);
        isBase64Encoded = true;
      }
    }
  }

  return {
    rawUrl: request.url,
    rawQuery: url.search.replace(/^\?/, ''),
    path: url.pathname,
    httpMethod: request.method,
    headers,
    multiValueHeaders: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, [v]])),
    queryStringParameters,
    multiValueQueryStringParameters,
    body,
    isBase64Encoded,
    // Netlify exposes the caller IP here; several handlers rate-limit on it.
    clientContext: {},
    netlifyFunctionName: name,
  };
}

function toResponse(result) {
  if (!result || typeof result !== 'object') {
    return new Response('Handler returned no response', { status: 502 });
  }
  const status = result.statusCode || 200;
  const headers = new Headers();
  for (const [k, v] of Object.entries(result.headers || {})) {
    if (v !== undefined && v !== null) headers.set(k, String(v));
  }
  for (const [k, vals] of Object.entries(result.multiValueHeaders || {})) {
    for (const v of [].concat(vals)) headers.append(k, String(v));
  }

  let body = result.body ?? null;
  if (body !== null && result.isBase64Encoded) {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(bytes, { status, headers });
  }
  if (status === 204 || status === 304) body = null;
  return new Response(body, { status, headers });
}


// Re-issue a request with extra query parameters, so a handler that expects
// ?slug=/?page= still sees them when the value came from the path.
// Which scheduled handlers may actually run. A cron expression fans out to
// every handler registered against it, and several money-critical jobs share a
// trigger (auto-cancel-stale-cod and phonepe-reconcile-refunds-scheduled are
// both "15 * * * *"). Listing jobs explicitly means adding a trigger can never
// silently start a job nobody asked for. To enable a job: add its name here AND
// its cron to [triggers] in wrangler.toml.
const ENABLED_JOBS = new Set([
  // sync / reporting
  'nimbuspost-awb-sync-scheduled',
  'auto-recover-carts',
  'daily-unshipped-report',
  'deploy-drift-check',
  // money safety nets
  'phonepe-payment-sweep-scheduled',
  'replay-lost-orders',
  'auto-cancel-stale-cod',
]);

function noStore(response) {
  const r = new Response(response.body, response);
  r.headers.set('Cache-Control', 'no-store');
  r.headers.set('CDN-Cache-Control', 'no-store');
  return r;
}

function withQuery(request, params) {
  const url = new URL(request.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString(), request);
}


// --- self-call interception -------------------------------------------------
// Twelve handlers enqueue their long-running sibling by fetching the site's own
// URL (`${SITE_URL}/.netlify/functions/x-background`). On Netlify that request
// left the building and came back in. A Worker fetching its own hostname loops
// at the edge instead and times out -- the live symptom was
// "[awb-sync-scheduler] failed: worker enqueue returned 522".
//
// Dispatch those in-process instead. Nothing external serves /.netlify/
// functions/, so matching on the path alone is safe and covers every caller
// without touching the twelve handler files.
let currentEnv = null;
let currentCtx = null;

const upstreamFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async function patchedFetch(input, init) {
  let url;
  try {
    url = new URL(typeof input === 'string' ? input : input.url);
  } catch {
    return upstreamFetch(input, init);
  }

  if (!url.pathname.startsWith(FN_PREFIX) || !currentEnv) {
    return upstreamFetch(input, init);
  }

  const name = url.pathname.slice(FN_PREFIX.length).replace(/\/+$/, '').split('/')[0];
  if (!routes[name]) return upstreamFetch(input, init);

  console.log(`[self-call] ${name} dispatched in-process`);
  return runHandler(name, new Request(url.toString(), init || input), currentEnv, currentCtx);
};

async function runHandler(name, request, env, ctx) {
  const mod = routes[name];
  if (!mod || typeof mod.handler !== 'function') {
    return new Response(JSON.stringify({ error: 'not_found', function: name }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const event = await toNetlifyEvent(request, name);
  const context = {
    functionName: name,
    awsRequestId: crypto.randomUUID(),
    // Netlify's context.clientContext.ip was read by the rate limiter.
    clientContext: { ip: request.headers.get('cf-connecting-ip') || '' },
    waitUntil: (p) => ctx.waitUntil(p),
  };

  if (isBackground(name)) {
    ctx.waitUntil(Promise.resolve().then(() => mod.handler(event, context)).catch((err) => {
      console.error(`[bg:${name}]`, err && err.stack || err);
    }));
    return new Response(null, { status: 202 });
  }

  try {
    return toResponse(await mod.handler(event, context));
  } catch (err) {
    console.error(`[fn:${name}]`, err && err.stack || err);
    return new Response(JSON.stringify({ error: 'function_error', message: String(err && err.message || err) }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    currentEnv = env; currentCtx = ctx;
    // process.env is populated from bindings by the runtime under
    // nodejs_compat, so the 161 files reading it need no change. The KV
    // binding is not on process.env, so hand it to the blobs shim per request.
    blobs.bindEnv(env);

    const url = new URL(request.url);
    if (url.pathname.startsWith(FN_PREFIX)) {
      const name = url.pathname.slice(FN_PREFIX.length).replace(/\/+$/, '').split('/')[0];
      return runHandler(name, request, env, ctx);
    }

    // Routes netlify.toml served from a function via a 200 rewrite. Static
    // assets cannot express these, so they are handled here.
    if (url.pathname.startsWith('/spimg/')) {
      // img-proxy reads event.path and matches /spimg/(.+), so pass it through
      // unchanged. This is how every custom-product image is served.
      return runHandler('img-proxy', request, env, ctx);
    }
    if (url.pathname === '/custom-feed.xml') {
      return runHandler('custom-products-feed', request, env, ctx);
    }
    const bulk = url.pathname.match(/^\/custom-feed-bulk\/([^/]+)\/?$/);
    if (bulk) {
      return runHandler('custom-products-feed-bulk', withQuery(request, { page: bulk[1] }), env, ctx);
    }

    const assetResponse = await env.ASSETS.fetch(request);

    // Admin-created products have no generated page: the catalogue books are
    // static files, everything else is rendered by product-page. Try the static
    // asset first so the ~2,740 generated pages keep winning, and only fall
    // back for a slug that has no file.
    if (assetResponse.status === 404) {
      const product = url.pathname.match(/^\/product\/([^/]+)\/?$/);
      if (product) {
        const slug = decodeURIComponent(product[1]);
        const rendered = await runHandler('product-page', withQuery(request, { slug }), env, ctx);
        if (rendered.status !== 404) return rendered;
      }
      // A 404 must never be stored at the edge. Cloudflare caches them per
      // colo, so one transient miss during a deploy or an origin blip pins a
      // "Page not found" on a live product in one region while every other
      // region serves it fine -- exactly what happened during the Netlify
      // cutover. 200s keep caching normally.
      return noStore(assetResponse);
    }

    return assetResponse;
  },

  async scheduled(event, env, ctx) {
    currentEnv = env; currentCtx = ctx;
    blobs.bindEnv(env);

    const registered = Object.entries(schedules)
      .filter(([, cron]) => cron === event.cron)
      .map(([name]) => name);

    const due = registered.filter((name) => ENABLED_JOBS.has(name));
    for (const name of registered) {
      if (!ENABLED_JOBS.has(name)) console.log(`[cron] skipping disabled job ${name}`);
    }

    if (!due.length) {
      console.warn(`[cron] no handler registered for "${event.cron}"`);
      return;
    }

    for (const name of due) {
      const mod = routes[name];
      if (!mod || typeof mod.handler !== 'function') {
        console.error(`[cron] missing handler ${name}`);
        continue;
      }
      const syntheticEvent = {
        path: `${FN_PREFIX}${name}`,
        httpMethod: 'POST',
        headers: { 'x-cloudflare-cron': event.cron },
        queryStringParameters: {},
        body: null,
        isBase64Encoded: false,
        netlifyFunctionName: name,
      };
      ctx.waitUntil(
        Promise.resolve()
          .then(() => mod.handler(syntheticEvent, { functionName: name, clientContext: {} }))
          .then((r) => console.log(`[cron] ${name} -> ${(r && r.statusCode) || 'ok'}`))
          .catch((err) => console.error(`[cron] ${name} failed:`, err && err.stack || err))
      );
    }
  },
};
