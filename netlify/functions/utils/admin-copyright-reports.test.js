const test = require('node:test');
const assert = require('node:assert/strict');
const { handle } = require('../admin-copyright-reports');

const REPORT = {
  ref: 'CR-20261110-ABCDE', created_at: '2026-11-10T12:00:00Z', status: 'new', product_slug: 'some-book',
  image_keys: ['copyright/CR-20261110-ABCDE/1.jpg'], image_count: 1,
};

// Minimal chainable fake of the Supabase client for the calls this endpoint makes.
function fakeDb({ rows = [REPORT], deleted = [], error = null, updated = [] } = {}) {
  return {
    from(table) {
      const st = { table, filters: {}, patch: null };
      const q = {
        select: () => q, order: () => q, in: () => q,
        limit: () => (table === 'copyright_reports' && st.countOnly ? Promise.resolve({ data: rows, error: null }) : q),
        eq: (k, v) => { st.filters[k] = v; return q; },
        update: (p) => { st.patch = p; return q; },
        maybeSingle: async () => {
          if (error) return { data: null, error };
          const r = rows.find((x) => x.ref === st.filters.ref);
          if (r && st.patch) { Object.assign(r, st.patch); updated.push({ ...st.patch }); }
          return { data: r || null, error: null };
        },
        then: (res, rej) => Promise.resolve(table === 'deleted_products'
          ? { data: deleted.map((slug) => ({ slug })), error: null }
          : error ? { data: null, error } : { data: rows.filter((r) => !st.filters.status || r.status === st.filters.status), error: null }).then(res, rej),
      };
      return q;
    },
  };
}
const call = (event, deps) => handle({ headers: {}, ...event }, deps).then((r) => ({ status: r.statusCode, body: JSON.parse(r.body || '{}') }));

test('list: reports with counts and whether the page is already down', async () => {
  const r = await call({ httpMethod: 'GET', queryStringParameters: { status: 'new' } }, { db: fakeDb({ deleted: ['some-book'] }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.reports.length, 1);
  assert.equal(r.body.reports[0].page_deleted, true);
  assert.equal(r.body.counts.new, 1);
});

test('list: a missing table says so instead of erroring', async () => {
  const r = await call({ httpMethod: 'GET', queryStringParameters: {} }, { db: fakeDb({ error: { code: '42P01', message: 'relation "copyright_reports" does not exist' } }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.table_missing, true);
});

test('update: status and notes; unknown status and bad refs refused', async () => {
  const updated = [];
  const db = fakeDb({ rows: [{ ...REPORT }], updated });
  const ok = await call({ httpMethod: 'POST', body: JSON.stringify({ ref: REPORT.ref, status: 'removed', owner_notes: 'Took it down' }) }, { db });
  assert.equal(ok.status, 200);
  assert.deepEqual(updated[0], { status: 'removed', owner_notes: 'Took it down' });
  assert.equal((await call({ httpMethod: 'POST', body: JSON.stringify({ ref: REPORT.ref, status: 'deleted' }) }, { db })).status, 400);
  assert.equal((await call({ httpMethod: 'POST', body: JSON.stringify({ ref: 'x', status: 'new' }) }, { db })).status, 400);
});

test('image: only keys stored on the report, read from private storage', async () => {
  const asked = [];
  const getImage = async (key) => { asked.push(key); return { ok: true, status: 200, body: new Uint8Array([0xff, 0xd8, 0xff]).buffer, contentType: 'image/jpeg' }; };
  const r = await call({ httpMethod: 'GET', queryStringParameters: { ref: REPORT.ref, image: '1' } }, { db: fakeDb(), getImage });
  assert.equal(r.status, 200);
  assert.equal(r.body.type, 'image/jpeg');
  assert.equal(r.body.data, Buffer.from([0xff, 0xd8, 0xff]).toString('base64'));
  assert.deepEqual(asked, ['copyright/CR-20261110-ABCDE/1.jpg']);
  const none = await call({ httpMethod: 'GET', queryStringParameters: { ref: REPORT.ref, image: '2' } }, { db: fakeDb(), getImage });
  assert.equal(none.status, 404);
});

test('without auth the real handler refuses', async () => {
  const { handler } = require('../admin-copyright-reports');
  const r = await handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
  assert.ok([401, 503].includes(r.statusCode));
});
