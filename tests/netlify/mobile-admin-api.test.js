// The two server changes the mobile admin (public/admin/m/) relies on:
// get-orders ?q= search, and update-product-override's partial save.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const { searchFilter } = require('../../netlify/functions/get-orders.js');

test('order search: ids, emails and phones become ilike terms', () => {
  assert.equal(searchFilter(''), null);
  assert.equal(searchFilter('a'), null);
  const id = searchFilter('IC-20261030-4FEME');
  assert.match(id, /razorpay_order_id\.ilike\.\*IC-20261030-4FEME\*/);
  assert.doesNotMatch(id, /customer_phone/);   // an order id is not a phone number
  assert.match(searchFilter('asha.k@gmail.com'), /customer_email\.ilike\.\*asha\.k@gmail\.com\*/);
  assert.match(searchFilter('+91 98765 43210'), /customer_phone\.ilike\.\*9876543210\*/);
});

test('order search: PostgREST syntax in the box cannot add a filter', () => {
  const f = searchFilter('x),or(status.eq.paid');
  assert.doesNotMatch(f, /[()]/);
  assert.equal(f.split(',').length, 5);
});

function overrideFixture({ row = null, settings = null, custom = null, book = null } = {}) {
  const writes = [];
  const rows = { product_overrides: row, product_settings: settings, custom_products: custom };
  const table = (name) => {
    let lastUpsert = null;
    const api = {
      select: () => api, ilike: () => api, eq: () => api,
      upsert: (v) => { lastUpsert = v; writes.push([name, 'upsert', v]); return api; },
      delete: () => { writes.push([name, 'delete']); return api; },
      maybeSingle: async () => ({ data: rows[name], error: null }),
      single: async () => ({ data: lastUpsert, error: null }),
      then: (ok, bad) => Promise.resolve({ error: null }).then(ok, bad),
    };
    return api;
  };
  const req = (id) => {
    if (id === '@supabase/supabase-js') return { createClient: () => ({ from: table }) };
    if (id === './utils/admin-auth') return { requireAdmin: () => null };
    if (id === './utils/product-settings') return require('../../netlify/functions/utils/product-settings');
    if (id === './utils/purge-cache') return { purgeCacheTags: async () => ({ purged: true }) };
    if (id === './utils/catalog-content') return { catalogueBook: () => book };
    throw Error(id);
  };
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../../netlify/functions/update-product-override.js'), 'utf8'),
    { module, exports: module.exports, require: req, process: { env: { SUPABASE_URL: 'x', SUPABASE_SERVICE_KEY: 'y' } }, Buffer, console },
  );
  const save = (body) => module.exports.handler({ httpMethod: 'POST', body: JSON.stringify(body) });
  return { save, writes, upserted: (t) => writes.filter((w) => w[0] === t && w[1] === 'upsert').map((w) => w[2]) };
}

test('partial save changes only the sent field and keeps the stored row', async () => {
  const f = overrideFixture({
    row: { slug: 'verity', title: 'Verity', author: 'Colleen Hoover', category: 'Romance', price_inr: '250.00', original_price_inr: '499.00',
      scarcity: true, stock_qty: null, is_active: true, image_url: 'https://cdn.example/verity.webp', publisher_sourced: true },
    settings: { price_inr: '279.00', original_price_inr: '499.00', handling_days: 3 },
  });
  const r = await f.save({ slug: 'verity', partial: true, stock_qty: 5 });
  assert.equal(r.statusCode, 200);
  const [o] = f.upserted('product_overrides');
  assert.equal(o.title, 'Verity');
  assert.equal(o.author, 'Colleen Hoover');
  assert.equal(o.image_url, 'https://cdn.example/verity.webp');
  assert.equal(o.scarcity, true);
  assert.equal(o.stock_qty, 5);
  assert.equal(o.price_inr, '279.00');          // product_settings is the live price
  assert.ok(!('publisher_sourced' in o));       // omitted = left alone by the handler
  const [s] = f.upserted('product_settings');
  assert.equal(s.handling_days, 3);
  assert.equal(s.price_inr, '279.00');
});

test('partial save with no override row starts from the listing, never a blank title', async () => {
  const f = overrideFixture({ book: { title: 'Atomic Habits', author: 'James Clear', category: 'Self-Help' } });
  const r = await f.save({ slug: 'atomic-habits', partial: true, price_inr: '199' });
  assert.equal(r.statusCode, 200);
  const [o] = f.upserted('product_overrides');
  assert.equal(o.title, 'Atomic Habits');
  assert.equal(o.price_inr, '199.00');
  assert.equal(o.stock_qty, null);
  assert.equal(o.scarcity, false);
  assert.equal(o.is_active, true);
});

test('partial save for an unknown slug writes nothing', async () => {
  const f = overrideFixture();
  const r = await f.save({ slug: 'no-such-book', partial: true, stock_qty: 1 });
  assert.equal(r.statusCode, 500);
  assert.match(JSON.parse(r.body).error, /No product/);
  assert.equal(f.writes.length, 0);
});
