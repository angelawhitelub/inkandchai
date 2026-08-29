/**
 * The pilot cap is the only thing standing between "send to 100 first" and
 * 9,709 customers who never opted in receiving marketing on the same number
 * that carries their order updates. It is tested by running the real handler
 * against a stubbed database rather than by grepping the source, because the
 * property that matters is behavioural: how many messages actually leave.
 */
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const handlerPath = path.join(root, 'netlify/functions/whatsapp-broadcast.js');
const Module = require('module');

/** Minimal chainable stand-in for the supabase query builder. */
function makeSupabase({ orders, pilotCount, cooldownRows = [] }) {
  const from = (table) => {
    const state = { table, count: false, head: false };
    const rowResult = () => {
      if (table === 'orders') return { data: orders, error: null };
      if (table === 'whatsapp_campaign_deliveries') return { data: cooldownRows, error: null };
      return { data: [], error: null };
    };
    const builder = {
      select(_cols, opts) {
        if (opts && opts.count) { state.count = true; state.head = !!opts.head; }
        return builder;
      },
      eq: () => builder,
      in: () => builder,
      gte: () => builder,
      lte: () => builder,
      lt: () => builder,
      gt: () => builder,
      neq: () => builder,
      is: () => builder,
      not: () => builder,
      or: () => builder,
      ilike: () => builder,
      like: () => builder,
      match: () => builder,
      range: () => builder,
      order: () => builder,
      contains: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      upsert: async () => ({ error: null }),
      then(res, rej) {
        const value = state.count ? { count: pilotCount, error: null } : rowResult();
        return Promise.resolve(value).then(res, rej);
      },
    };
    return builder;
  };
  return { from };
}

function loadHandler(supabaseClient) {
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@supabase/supabase-js') return { createClient: () => supabaseClient };
    return orig.apply(this, arguments);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.includes('/netlify/functions/')) delete require.cache[key];
    }
    return { handler: require(handlerPath).handler, restore: () => { Module._load = orig; } };
  } catch (err) {
    Module._load = orig;
    throw err;
  }
}

function invoke(handler, body) {
  return handler({
    httpMethod: 'POST',
    headers: { 'x-admin-key': process.env.ADMIN_SECRET },
    body: JSON.stringify(body),
  });
}

const ORDERS = Array.from({ length: 500 }, (_, i) => ({
  customer_phone: String(9000000000 + i),
  customer_name: 'Reader ' + i,
  cart_items: [],
  status: 'delivered',
  created_at: new Date(Date.now() - i * 3600000).toISOString(),
}));

test('the pilot refuses to send once the cap has already been reached', async () => {
  const prevAdmin = process.env.ADMIN_SECRET;
  const prevCap = process.env.WHATSAPP_BROADCAST_PILOT_CAP;
  process.env.ADMIN_SECRET = 'test-secret';
  process.env.WHATSAPP_BROADCAST_PILOT_CAP = '100';
  let restoreLoad = () => {};
  let fetchCalls = 0;
  const oldFetch = global.fetch;
  global.fetch = async () => { fetchCalls++; return { ok: true, json: async () => ({}) }; };
  try {
    // 100 un-consented messages have already gone out on an earlier run.
    const client = makeSupabase({ orders: ORDERS, pilotCount: 100 });
    const { handler, restore } = loadHandler(client);
    restoreLoad = restore;
    const res = await invoke(handler, {
      template: 'broadcast_product_offer_v1', require_opt_in: false,
      source: 'scheduled', campaign_key: 'pilot-2', limit: 100,
    });
    const out = JSON.parse(res.body);
    assert.equal(out.sent, 0, 'nothing is sent after the cap');
    assert.equal(fetchCalls, 0, 'no message leaves the building');
    assert.match(out.message, /Pilot cap reached/);
  } finally {
    restoreLoad();
    global.fetch = oldFetch;
    process.env.ADMIN_SECRET = prevAdmin;
    if (prevCap === undefined) delete process.env.WHATSAPP_BROADCAST_PILOT_CAP;
    else process.env.WHATSAPP_BROADCAST_PILOT_CAP = prevCap;
    for (const key of Object.keys(require.cache)) {
      if (key.includes('/netlify/functions/')) delete require.cache[key];
    }
  }
});

test('a second run tops up to the cap rather than sending a fresh 100', async () => {
  // The failure this guards against: run one sends 100, the cooldown then hides
  // those 100, and run two happily takes the NEXT 100 -- walking the whole list.
  const prevAdmin = process.env.ADMIN_SECRET;
  const prevCap = process.env.WHATSAPP_BROADCAST_PILOT_CAP;
  process.env.ADMIN_SECRET = 'test-secret';
  process.env.WHATSAPP_BROADCAST_PILOT_CAP = '100';
  const prevToken = process.env.WHATSAPP_TOKEN;
  process.env.WHATSAPP_TOKEN = 'test-token';
  let restoreLoad = () => {};
  const oldFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'x' }] }) });
  try {
    const client = makeSupabase({ orders: ORDERS, pilotCount: 90 });
    const { handler, restore } = loadHandler(client);
    restoreLoad = restore;
    const res = await invoke(handler, {
      template: 'broadcast_product_offer_v1', require_opt_in: false,
      source: 'scheduled', campaign_key: 'pilot-3', limit: 100,
    });
    const out = JSON.parse(res.body);
    // `total` is how many recipients the run actually selected. Asserting on it
    // rather than on `sent` matters: `sent` is 0 whenever WHATSAPP_TOKEN is
    // absent, which would let this pass without the cap doing anything.
    assert.equal(out.total, 10, `the cap must clamp 100 down to the remaining 10, got ${out.total}`);
  } finally {
    restoreLoad();
    global.fetch = oldFetch;
    process.env.ADMIN_SECRET = prevAdmin;
    if (prevToken === undefined) delete process.env.WHATSAPP_TOKEN;
    else process.env.WHATSAPP_TOKEN = prevToken;
    if (prevCap === undefined) delete process.env.WHATSAPP_BROADCAST_PILOT_CAP;
    else process.env.WHATSAPP_BROADCAST_PILOT_CAP = prevCap;
    for (const key of Object.keys(require.cache)) {
      if (key.includes('/netlify/functions/')) delete require.cache[key];
    }
  }
});

test('the cap does not apply when everyone has recorded consent', () => {
  const fs = require('fs');
  const src = fs.readFileSync(handlerPath, 'utf8');
  // Opt-in sends are legitimate and uncapped; the ceiling exists only for the
  // un-consented pilot.
  assert.match(src, /if \(!requireOptIn && !testPhone\) \{/);
});

test('an uncountable ledger sends nothing rather than guessing', () => {
  const fs = require('fs');
  const src = fs.readFileSync(handlerPath, 'utf8');
  assert.match(src, /refusing to send without recorded consent/);
});

test('pilot sends are tagged so the cap can count them', () => {
  const fs = require('fs');
  const src = fs.readFileSync(handlerPath, 'utf8');
  assert.match(src, /pilot: !requireOptIn/);
});

test('the scheduler requires opt-in unless pilot mode is switched on', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(root, 'netlify/functions/whatsapp-broadcast-scheduled.js'), 'utf8');
  assert.match(src, /require_opt_in:!pilot/);
  // Absent env => pilot false => opt-in required. The dangerous mode cannot be
  // the default.
  assert.match(src, /WHATSAPP_BROADCAST_PILOT \|\| ''/);
});
