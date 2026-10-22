'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Capture the filters get-orders builds, through a stubbed Supabase client.
const calls = [];
const file = require.resolve('@supabase/supabase-js');
require.cache[file] = {
  id: file, filename: file, loaded: true,
  exports: {
    createClient: () => ({
      from: () => {
        const q = {
          select: () => q,
          or: (f) => { calls.push(['or', f]); return q; },
          in: () => q, eq: () => q,
          order: () => q,
          range: () => q,
          then: (ok, bad) => Promise.resolve({ data: [], error: null, count: 0 }).then(ok, bad),
        };
        return q;
      },
    }),
  },
};
process.env.SUPABASE_URL = 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = 'test';
process.env.ADMIN_SECRET = 'test-secret';
const { handler } = require('../get-orders');

const get = (qs) => handler({ httpMethod: 'GET', headers: { 'x-admin-key': 'test-secret' }, queryStringParameters: qs });

test('changed_since asks for orders any courier update touched, still without paperbound', async () => {
  calls.length = 0;
  const r = await get({ page: '1', limit: '500', changed_since: '2026-10-08T14:00:00Z' });
  assert.equal(r.statusCode, 200);
  assert.equal(calls.length, 1, 'one combined filter, not two separate or= params');
  const f = calls[0][1];
  for (const col of ['last_courier_status_at', 'last_nimbuspost_event_at', 'delivered_at', 'shipment_moved_at']) {
    assert.ok(f.includes(`${col}.gte.2026-10-08T14:00:00.000Z`), col);
  }
  assert.match(f, /^and\(source\.is\.null,or\(.+\)\),and\(source\.neq\.paperbound,or\(.+\)\)$/);
});

test('without changed_since the query is unchanged; a bad date is refused', async () => {
  calls.length = 0;
  await get({ page: '1', limit: '500' });
  assert.deepEqual(calls, [['or', 'source.is.null,source.neq.paperbound']]);
  const bad = await get({ changed_since: 'yesterday-ish' });
  assert.equal(bad.statusCode, 400);
});
