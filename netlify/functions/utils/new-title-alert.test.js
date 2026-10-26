const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const A = require('./new-title-alert');

// ── Matching ────────────────────────────────────────────────────────────────
const order = (...items) => ({ cart_items: items });
const book = { slug: 'a-court-of-splintered-harmony', title: 'A Court of Splintered Harmony', author: 'Sarah J. Maas', category: 'Fantasy', price: 499, mrp: 899 };

test('authorsOf splits co-authors and drops placeholders', () => {
  assert.deepStrictEqual(A.authorsOf('Sarah J. Maas & Someone Else'), ['sarah j maas', 'someone else']);
  assert.deepStrictEqual(A.authorsOf('Various Authors'), []);
  assert.deepStrictEqual(A.authorsOf(''), []);
});

test('shelfOf maps raw categories to a shelf, broad ones to nothing', () => {
  assert.strictEqual(A.shelfOf('Romance Fiction'), 'romance');
  assert.strictEqual(A.shelfOf('Hindi Literature'), 'Hindi books');
  assert.strictEqual(A.shelfOf('Fiction'), 'fiction');
  assert.strictEqual(A.shelfOf('Preloved Books'), '');
});

test('matches same-author buyers and skips anyone who already bought the book', () => {
  const customers = new Map([
    ['919000000001', { name: 'Riya Sharma', orders: [order({ title: 'A Court of Thorns and Roses', author: 'Sarah J Maas' })] }],
    ['919000000002', { name: 'Aman', orders: [order({ title: 'Atomic Habits', author: 'James Clear' })] }],
    ['919000000003', { name: 'Zoya', orders: [order({ title: 'Throne of Glass', author: 'Sarah J. Maas' }, { url: '/product/a-court-of-splintered-harmony/', title: 'x' })] }],
    ['919000000004', { name: '', orders: [order({ url: '/product/throne-of-glass-123/', title: 'Throne of Glass' })] }],
  ]);
  const metaOf = (item) => (/throne-of-glass-123/.test(item.url || '') ? { author: 'Sarah J. Maas' } : null);
  const { recipients, counts } = A.matchCustomers(customers, book, metaOf, { match: 'author' });
  assert.deepStrictEqual(recipients.map((r) => r.phone), ['919000000001', '919000000004']);
  assert.strictEqual(recipients[0].name, 'Riya');
  assert.strictEqual(recipients[1].name, 'there');
  assert.strictEqual(recipients[0].reason, 'Sarah J. Maas');
  assert.deepStrictEqual(counts, { customers: 4, matched: 2, already_bought: 1, by_author: 2, by_title: 0, by_category: 0 });
});

test('category matching is only used when asked for', () => {
  const customers = new Map([['919000000005', { name: 'Kabir', orders: [order({ title: 'Mistborn', author: 'Brandon Sanderson', category: 'Fantasy Fiction' })] }]]);
  assert.strictEqual(A.matchCustomers(customers, book, null, { match: 'author' }).recipients.length, 0);
  const { recipients } = A.matchCustomers(customers, book, null, { match: 'author_or_category' });
  assert.strictEqual(recipients[0].reason, 'fantasy');
});

test('templateParams: discount line, and a pre-order line when releasing later', () => {
  assert.deepStrictEqual(A.templateParams({ name: 'Riya', reason: 'Sarah J. Maas' }, book),
    ['Riya', 'Sarah J. Maas', 'A Court of Splintered Harmony', '₹499 (44% off MRP)']);
  const [, , , line] = A.templateParams({ name: 'R', reason: 'x' }, { ...book, release: '2026-11-05' });
  assert.match(line, /^pre-order now at ₹499 \(44% off MRP\) — releases 5 Nov$/);
});

test('bareTitle drops a trailing "by <same author>" only', () => {
  assert.strictEqual(A.bareTitle('A Court of Splintered Harmony by Sarah J. Maas', 'Sarah J. Maas'), 'A Court of Splintered Harmony');
  assert.strictEqual(A.bareTitle('Stand by Me by Someone', 'Sarah J. Maas'), 'Stand by Me by Someone');
  assert.strictEqual(A.bareTitle('Stand by Me', 'Sarah J. Maas'), 'Stand by Me');
});

test('JSON-text carts, author-in-title and series names all match', () => {
  const customers = new Map([
    ['1', { name: 'A', orders: [{ cart_items: JSON.stringify([{ title: '(5 books set) A Court of Thorns and Roses Paperback Box Set by Sarah J. Maas' }]) }] }],
    ['2', { name: 'B', orders: [{ cart_items: [{ title: 'A Court of Thorns and Roses 4 books boxset (Paperback)' }] }] }],
    ['3', { name: 'C', orders: [{ cart_items: '[{"title":"A Court of Splintered Harmony"}]' }] }],
    ['4', { name: 'D', orders: [{ cart_items: 'not json' }] }],
  ]);
  const b = { ...book, title: 'A Court of Splintered Harmony by Sarah J. Maas' };
  const without = A.matchCustomers(customers, b, null, { match: 'author' });
  assert.deepStrictEqual(without.recipients.map((r) => r.phone), ['1']);
  assert.strictEqual(without.counts.already_bought, 1);
  const withSeries = A.matchCustomers(customers, b, null, { match: 'author', keywords: 'Court of Thorns, ab' });
  assert.deepStrictEqual(withSeries.recipients.map((r) => [r.phone, r.via, r.reason]), [['1', 'title', 'Sarah J. Maas'], ['2', 'title', 'Sarah J. Maas']]);
  assert.strictEqual(withSeries.counts.by_title, 2);
});

test('romance and fantasy buyers count as fiction for a fiction title', () => {
  const customers = new Map([['1', { name: 'A', orders: [{ cart_items: [{ title: 'It Ends With Us' }] }] }]]);
  const metaOf = () => ({ category: 'All Romance Books' });
  const r = A.matchCustomers(customers, { ...book, author: 'Someone New', category: 'Fiction' }, metaOf, { match: 'author_or_category' });
  assert.deepStrictEqual(r.recipients.map((x) => [x.via, x.reason]), [['category', 'fiction']]);
  // …but a plain fiction buyer is not a romance reader.
  const r2 = A.matchCustomers(customers, { ...book, author: 'Someone New', category: 'Romance' }, () => ({ category: 'Fiction' }), { match: 'author_or_category' });
  assert.strictEqual(r2.recipients.length, 0);
});

// ── Handler against a fake database (no network, WhatsApp stubbed) ──────────
function fakeDb(tables, writes) {
  return {
    from(table) {
      const filters = [];
      let range = null;
      const q = {
        select: () => q, order: () => q, limit: () => q, ilike: (c, v) => { filters.push((r) => String(r[c]).toLowerCase() === String(v).toLowerCase()); return q; },
        eq: (c, v) => { filters.push((r) => r[c] === v); return q; },
        in: (c, vs) => { filters.push((r) => vs.includes(r[c])); return q; },
        gte: (c, v) => { filters.push((r) => String(r[c]) >= v); return q; },
        or: () => q,
        range: (a, b) => { range = [a, b]; return q; },
        upsert: (rows) => { writes.push(...rows); return Promise.resolve({ error: null }); },
        then(res, rej) {
          const t = tables[table];
          if (t instanceof Error) return Promise.resolve({ data: null, error: { message: t.message } }).then(res, rej);
          let rows = (t || []).filter((r) => filters.every((f) => f(r)));
          if (range) rows = rows.slice(range[0], range[1] + 1);
          return Promise.resolve({ data: rows, error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
}

function loadHandler({ tables, sent, writes, sendOk = true, r2 = null }) {
  const stubs = {
    './utils/r2-put': {
      r2Configured: () => !!r2,
      r2Config: () => ({ publicBase: 'https://r2.example' }),
      r2PutObject: async (cfg, o) => { r2.push(o); return 'https://r2.example/' + o.key; },
    },
    '@supabase/supabase-js': { createClient: () => fakeDb(tables, writes) },
    './utils/admin-auth': { requireAdmin: () => null },
    './utils/pricing': {
      makeSlug: (t, id) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + id,
      resolveCartPrices: async (cart) => ({ cart: cart.map((c) => ({ ...c, title: 'A Court of Splintered Harmony', price: 499 })) }),
    },
    './utils/catalog-content': { catalogueBook: () => null },
    './utils/release-date': { releasesFor: async () => ({}) },
    './utils/whatsapp': {
      normalizePhone: (p) => { const d = String(p || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? '91' + d : null; },
      sendWhatsApp: async (m) => { sent.push(m); return sendOk ? { ok: true } : { ok: false, error: 'template not approved' }; },
    },
    '../../data/ALL_BOOKS.json': [],
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return Object.prototype.hasOwnProperty.call(stubs, req) ? stubs[req] : orig.call(this, req, ...rest); };
  try {
    delete require.cache[require.resolve('../admin-new-title-alert')];
    return require('../admin-new-title-alert').handler;
  } finally { Module._load = orig; }
}

const now = new Date().toISOString();
const baseTables = () => ({
  custom_products: [{ slug: 'a-court-of-splintered-harmony', title: 'A Court of Splintered Harmony', author: 'Sarah J. Maas', category: 'Fantasy', original_price_inr: 899, is_active: true }],
  orders: [
    { customer_phone: '9000000001', customer_name: 'Riya', status: 'delivered', created_at: now, cart_items: [{ title: 'Throne of Glass', author: 'Sarah J. Maas' }] },
    { customer_phone: '9000000002', customer_name: 'Aman', status: 'delivered', created_at: now, cart_items: [{ title: 'Kingdom of Ash', author: 'Sarah J. Maas' }] },
    { customer_phone: '9000000003', customer_name: 'Zoya', status: 'paid', created_at: now, cart_items: [{ title: 'Crescent City', author: 'Sarah J. Maas' }] },
    { customer_phone: '9000000004', customer_name: 'Neel', status: 'delivered', created_at: now, cart_items: [{ title: 'Atomic Habits', author: 'James Clear' }] },
  ],
  bot_messages: [{ customer_phone: '919000000002', message: 'STOP', role: 'user', created_at: now }],
  whatsapp_marketing_subscribers: [],
  whatsapp_campaign_deliveries: [{ id: 1, campaign_key: 'weekly-x', customer_phone: '919000000003', status: 'sent', created_at: now }],
});
// Covers: only these URLs answer with real image bytes.
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46], WEBP = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0];
let images = {};
const fetched = [];
global.fetch = async (url) => {
  fetched.push(url);
  const bytes = images[url];
  if (!bytes) return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
  return { ok: true, status: 200, headers: new Map([['content-length', '1000']]), arrayBuffer: async () => new Uint8Array(bytes).buffer };
};
const call = (handler, body) => handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) }).then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }));

test('dry run reports the audience and sends nothing', async () => {
  const sent = [], writes = [];
  const handler = loadHandler({ tables: baseTables(), sent, writes });
  const r = await call(handler, { slug: 'a-court-of-splintered-harmony', dry_run: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.counts.matched, 3);
  assert.strictEqual(r.body.counts.opted_out, 1);   // said STOP
  assert.strictEqual(r.body.counts.cooldown, 1);    // had the weekly broadcast
  assert.strictEqual(r.body.will_send, 1);
  assert.deepStrictEqual(r.body.preview_params, ['Riya', 'Sarah J. Maas', 'A Court of Splintered Harmony', '₹499 (44% off MRP)']);
  assert.ok(!/9000000001/.test(JSON.stringify(r.body.sample)), 'phones are masked');
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(writes.length, 0);
});

test('send needs the confirmed count, then logs every delivery', async () => {
  const sent = [], writes = [];
  const handler = loadHandler({ tables: baseTables(), sent, writes });
  const wrong = await call(handler, { slug: 'a-court-of-splintered-harmony', dry_run: false, expect: 5 });
  assert.strictEqual(wrong.status, 409);
  assert.strictEqual(sent.length, 0);
  const ok = await call(handler, { slug: 'a-court-of-splintered-harmony', dry_run: false, expect: 1 });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.sent, 1);
  assert.strictEqual(sent[0].to, '919000000001');
  assert.strictEqual(sent[0].urlButtonParam, 'a-court-of-splintered-harmony');
  assert.strictEqual(sent[0].marketing, true);
  assert.strictEqual(writes[0].campaign_key, 'new-title:a-court-of-splintered-harmony');
  assert.strictEqual(writes[0].status, 'sent');
  assert.notStrictEqual(writes[0].metadata.pilot, true, 'must not eat the broadcast pilot cap');
});

test('already alerted for this book → not again', async () => {
  const tables = baseTables();
  tables.whatsapp_campaign_deliveries.push({ id: 2, campaign_key: 'new-title:a-court-of-splintered-harmony', customer_phone: '919000000001', status: 'sent', created_at: '2026-01-01T00:00:00Z' });
  const sent = [], writes = [];
  const r = await call(loadHandler({ tables, sent, writes }), { slug: 'a-court-of-splintered-harmony', dry_run: true });
  assert.strictEqual(r.body.counts.already_sent_this_book, 1);
  assert.strictEqual(r.body.will_send, 0);
});

test('an unreadable opt-out list or ledger blocks the send', async () => {
  for (const broken of ['bot_messages', 'whatsapp_campaign_deliveries']) {
    const tables = baseTables();
    tables[broken] = new Error('relation does not exist');
    const sent = [], writes = [];
    const handler = loadHandler({ tables, sent, writes });
    const dry = await call(handler, { slug: 'a-court-of-splintered-harmony', dry_run: true });
    assert.ok(dry.body.blocked_reason, broken);
    const r = await call(handler, { slug: 'a-court-of-splintered-harmony', dry_run: false, expect: dry.body.will_send });
    assert.strictEqual(r.status, 409, broken);
    assert.strictEqual(sent.length, 0, broken);
  }
});

test('a first batch that all fails stops the send', async () => {
  const tables = baseTables();
  tables.whatsapp_campaign_deliveries = [];
  tables.bot_messages = [];
  const sent = [], writes = [];
  const r = await call(loadHandler({ tables, sent, writes, sendOk: false }), { slug: 'a-court-of-splintered-harmony', dry_run: false, expect: 3 });
  assert.strictEqual(r.status, 502);
  assert.strictEqual(r.body.sent, 0);
  assert.ok(writes.every((w) => w.status === 'failed'));
});

test('test_phone sends one message and writes no ledger row', async () => {
  const sent = [], writes = [];
  const r = await call(loadHandler({ tables: baseTables(), sent, writes }), { slug: 'a-court-of-splintered-harmony', test_phone: '98765 43210' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].to, '919876543210');
  assert.strictEqual(writes.length, 0);
});

test('cover: the book\'s own JPEG is the image header', async () => {
  const tables = baseTables();
  tables.custom_products[0].image_url = 'https://cdn.example.com/cover.jpg';
  images = { 'https://cdn.example.com/cover.jpg': JPEG };
  const sent = [], writes = [];
  const handler = loadHandler({ tables, sent, writes });
  const dry = await call(handler, { slug: 'a-court-of-splintered-harmony', dry_run: true });
  assert.deepStrictEqual(dry.body.cover, { url: 'https://cdn.example.com/cover.jpg', fallback: false });
  await call(handler, { slug: 'a-court-of-splintered-harmony', dry_run: false, expect: 1 });
  assert.strictEqual(sent[0].headerImageUrl, 'https://cdn.example.com/cover.jpg');
});

test('cover: a webp catalogue cover uses its JPEG copy in /images/wa/', async () => {
  const tables = baseTables();
  tables.custom_products[0].image_url = '/images/some-book.webp';
  images = { 'https://inkandchai.in/images/some-book.webp': WEBP, 'https://inkandchai.in/images/wa/some-book.jpg': JPEG };
  const r = await call(loadHandler({ tables, sent: [], writes: [] }), { slug: 'a-court-of-splintered-harmony', dry_run: true });
  assert.strictEqual(r.body.cover.url, 'https://inkandchai.in/images/wa/some-book.jpg');
});

test('cover: a webp or missing cover falls back to the shop card', async () => {
  const tables = baseTables();
  tables.custom_products[0].image_url = 'https://cdn.shopify.com/gone.webp';
  images = { 'https://cdn.shopify.com/gone.webp': WEBP };
  const r = await call(loadHandler({ tables, sent: [], writes: [] }), { slug: 'a-court-of-splintered-harmony', dry_run: true });
  assert.deepStrictEqual(r.body.cover, { url: 'https://inkandchai.in/images/og-default.jpg', fallback: true, convert_from: null });
});

test('WHATSAPP_NEW_TITLE_IMAGE=off sends no image header', async () => {
  process.env.WHATSAPP_NEW_TITLE_IMAGE = 'off';
  try {
    const sent = [];
    fetched.length = 0;
    await call(loadHandler({ tables: baseTables(), sent, writes: [] }), { slug: 'a-court-of-splintered-harmony', test_phone: '9876543210' });
    assert.strictEqual(sent[0].headerImageUrl, null);
    assert.strictEqual(fetched.length, 0);
  } finally { delete process.env.WHATSAPP_NEW_TITLE_IMAGE; }
});

test('a webp cover on our site is offered for conversion, and the JPEG copy is used once saved', async () => {
  const tables = baseTables();
  tables.custom_products[0].image_url = '/spimg/product-images/custom/court.webp';
  images = { 'https://inkandchai.in/spimg/product-images/custom/court.webp': WEBP };
  const r2 = [];
  const handler = loadHandler({ tables, sent: [], writes: [], r2 });
  const dry = await call(handler, { slug: 'a-court-of-splintered-harmony', dry_run: true });
  assert.strictEqual(dry.body.cover.fallback, true);
  assert.strictEqual(dry.body.cover.convert_from, 'https://inkandchai.in/spimg/product-images/custom/court.webp');

  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000)]).toString('base64');
  const saved = await call(handler, { slug: 'a-court-of-splintered-harmony', cover_jpeg: 'data:image/jpeg;base64,' + jpeg });
  assert.strictEqual(saved.status, 200);
  assert.match(r2[0].key, /^covers\/wa\/a-court-of-splintered-harmony-[0-9a-f]{10}\.jpg$/);
  assert.strictEqual(r2[0].contentType, 'image/jpeg');

  images[saved.body.url] = JPEG;
  const again = await call(handler, { slug: 'a-court-of-splintered-harmony', dry_run: true });
  assert.deepStrictEqual(again.body.cover, { url: saved.body.url, fallback: false });
});

test('cover_jpeg that is not a JPEG is refused', async () => {
  const tables = baseTables();
  tables.custom_products[0].image_url = '/spimg/x.webp';
  const r2 = [];
  const r = await call(loadHandler({ tables, sent: [], writes: [], r2 }), { slug: 'a-court-of-splintered-harmony', cover_jpeg: Buffer.alloc(3000).toString('base64') });
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r2.length, 0);
});

test('a Supabase storage cover is read through /spimg/, and a test waits for its JPEG copy', async () => {
  process.env.SUPABASE_URL = 'https://abc.supabase.co';
  try {
    const tables = baseTables();
    tables.custom_products[0].image_url = 'https://abc.supabase.co/storage/v1/object/public/product-images/custom/court.webp';
    images = {};
    const sent = [];
    const handler = loadHandler({ tables, sent, writes: [], r2: [] });
    const dry = await call(handler, { slug: 'a-court-of-splintered-harmony', dry_run: true });
    assert.strictEqual(dry.body.cover.convert_from, 'https://inkandchai.in/spimg/product-images/custom/court.webp');
    const test1 = await call(handler, { slug: 'a-court-of-splintered-harmony', test_phone: '9876543210' });
    assert.strictEqual(test1.status, 409);
    assert.strictEqual(test1.body.need_cover, true);
    assert.strictEqual(sent.length, 0, 'nothing sent with the shop card');
    const test2 = await call(handler, { slug: 'a-court-of-splintered-harmony', test_phone: '9876543210', allow_fallback: true });
    assert.strictEqual(test2.status, 200);
    assert.strictEqual(sent.length, 1);
  } finally { delete process.env.SUPABASE_URL; }
});
