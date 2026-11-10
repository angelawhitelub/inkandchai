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
        like: (c, v) => { const re = new RegExp('^' + String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$'); filters.push((r) => re.test(String(r[c]))); return q; },
        not: (c, op, v) => { const re = new RegExp('^' + String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$'); filters.push((r) => !re.test(String(r[c]))); return q; },
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

function loadHandler({ tables, sent, writes, sendOk = true, r2 = null, mails = [], mailOk = true, unsub = new Map(), unsubBroken = false }) {
  const stubs = {
    './utils/email': { sendEmail: async (m) => { mails.push(m); return mailOk ? { ok: true, provider: 'test' } : { ok: false, error: 'provider down' }; } },
    '@netlify/blobs': { getStore: () => ({
      list: async () => { if (unsubBroken) throw new Error('kv down'); return { blobs: [...unsub.keys()].map((key) => ({ key })) }; },
      setJSON: async (k, v) => { unsub.set(k, v); },
    }) },
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
      sendWhatsApp: async (m) => { sent.push(m); return sendOk ? { ok: true, data: { messages: [{ id: 'wamid.' + sent.length }] } } : { ok: false, error: 'template not approved' }; },
    },
    '../../data/ALL_BOOKS.json': [],
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return Object.prototype.hasOwnProperty.call(stubs, req) ? stubs[req] : orig.call(this, req, ...rest); };
  try {
    delete require.cache[require.resolve('../admin-new-title-alert')];
    delete require.cache[require.resolve('./email-unsub')];
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
  assert.strictEqual(writes[0].metadata.wamid, 'wamid.1');
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

test('the send stores Meta\'s message id; held-back customers are not retried for the book; report sums it', async () => {
  const tables = baseTables();
  tables.bot_messages = [];
  tables.whatsapp_campaign_deliveries = [
    { id: 5, campaign_key: 'new-title:a-court-of-splintered-harmony', customer_phone: '919000000002', status: 'failed', created_at: '2026-01-01T00:00:00Z', metadata: { wamid: 'w', meta_failed: true, failed_code: 131049 } },
  ];
  const sent = [], writes = [];
  const handler = loadHandler({ tables, sent, writes });
  // stub returns no message id; give it one
  const dry = await call(handler, { slug: 'a-court-of-splintered-harmony', dry_run: true });
  assert.strictEqual(dry.body.counts.already_sent_this_book, 1);
  const rep = await call(handler, { slug: 'a-court-of-splintered-harmony', report: true });
  assert.strictEqual(rep.body.report.failed_by_meta, 1);
  assert.deepStrictEqual(rep.body.report.failed_codes, { 131049: 1 });
});

// ── "Ordered these books" audience + email channel ─────────────────────────
process.env.EMAIL_UNSUB_SECRET = process.env.EMAIL_UNSUB_SECRET || 'test-secret';
const EU = require('./email-unsub');
const boughtTables = () => {
  const t = baseTables();
  t.custom_products.push({ slug: 'throne-of-glass', title: 'Throne of Glass', author: 'Sarah J. Maas', is_active: true });
  t.orders = [
    { customer_phone: '9000000001', customer_name: 'Riya', customer_email: 'Riya@Example.com', status: 'delivered', created_at: now, cart_items: [{ url: '/product/throne-of-glass/', title: 'Throne of Glass' }] },
    { customer_phone: '9000000002', customer_name: 'Aman', customer_email: 'aman@example.com', status: 'delivered', created_at: now, cart_items: [{ title: 'Throne of Glass' }] },
    { customer_phone: '9000000005', customer_name: 'Kabir', customer_email: 'kabir@example.com', status: 'delivered', created_at: now, cart_items: [{ title: 'Throne of Glass' }] },
    { customer_phone: '9000000006', customer_name: 'Neel', customer_email: 'neel@example.com', status: 'delivered', created_at: now, cart_items: [{ title: 'Throne of Glass' }, { url: '/product/a-court-of-splintered-harmony/', title: 'A Court of Splintered Harmony' }] },
    { customer_phone: '9000000007', customer_name: 'Ira', status: 'delivered', created_at: now, cart_items: [{ title: 'Crescent City', author: 'Sarah J. Maas' }] },
  ];
  return t;
};
const boughtBody = (extra) => ({ slug: 'a-court-of-splintered-harmony', match: 'bought', bought_slugs: 'https://inkandchai.in/product/throne-of-glass/', email: true, ...extra });

test('matchBuyersOf: only buyers of the picked book, minus anyone who has the new one', () => {
  const customers = new Map([
    ['91a', { name: 'Riya Sharma', email: 'r@x.in', orders: [order({ url: '/product/throne-of-glass/', title: 'Throne of Glass' })] }],
    ['91b', { name: 'Neel', orders: [order({ title: 'Throne of Glass by Sarah J. Maas' }, { title: 'A Court of Splintered Harmony' })] }],
    ['91c', { name: 'Ira', orders: [order({ title: 'Crescent City' })] }],
  ]);
  const { recipients, counts } = A.matchBuyersOf(customers, book, [{ slug: 'throne-of-glass', title: 'Throne of Glass', author: 'Sarah J. Maas' }]);
  assert.deepStrictEqual(recipients.map((r) => [r.phone, r.name, r.email, r.reason]), [['91a', 'Riya', 'r@x.in', 'Throne of Glass']]);
  assert.strictEqual(counts.already_bought, 1);
  assert.deepStrictEqual(counts.per_book, { 'throne-of-glass': 1 });
});

test('emailHtml: cover header, Exclusive, the book they ordered, price and unsubscribe; escapes names', () => {
  const html = A.emailHtml({ name: '<b>Riya</b>', reason: 'Throne of Glass' }, book, { coverUrl: 'https://c/x.jpg', productUrl: 'https://p/', unsubscribeUrl: 'https://u/' });
  for (const want of ['https://c/x.jpg', 'Exclusive', 'Throne of Glass', 'A Court of Splintered Harmony', '₹499', 'https://u/']) assert.ok(html.includes(want), want);
  assert.ok(!html.includes('<b>Riya</b>'));
});

test('bought audience: dry run counts both channels, email skips unsubscribed addresses and sends nothing', async () => {
  const sent = [], writes = [], mails = [];
  const unsub = new Map([[EU.hashEmail('kabir@example.com'), {}]]);
  const r = await call(loadHandler({ tables: boughtTables(), sent, writes, mails, unsub }), boughtBody({ dry_run: true }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.counts.matched, 3);          // Riya, Aman, Kabir
  assert.strictEqual(r.body.counts.already_bought, 1);   // Neel has it
  assert.strictEqual(r.body.counts.opted_out, 1);        // Aman said STOP
  assert.strictEqual(r.body.will_send, 2);
  assert.strictEqual(r.body.email.will_email, 1);        // Kabir unsubscribed, Aman opted out
  assert.strictEqual(r.body.email.counts.unsubscribed, 1);
  assert.match(r.body.email.subject, /^Exclusive: A Court of Splintered Harmony is now available$/);
  assert.match(r.body.email.preview_html, /Throne of Glass/);
  assert.deepStrictEqual([sent.length, mails.length, writes.length], [0, 0, 0]);
});

test('bought audience: send needs both confirmed counts, emails once with a working unsubscribe link', async () => {
  const tables = boughtTables();
  const sent = [], writes = [], mails = [];
  const handler = loadHandler({ tables, sent, writes, mails, unsub: new Map([[EU.hashEmail('kabir@example.com'), {}]]) });
  const wrong = await call(handler, boughtBody({ dry_run: false, expect: 2, expect_email: 3 }));
  assert.strictEqual(wrong.status, 409);
  assert.deepStrictEqual([sent.length, mails.length], [0, 0]);
  const ok = await call(handler, boughtBody({ dry_run: false, expect: 2, expect_email: 1 }));
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.deepStrictEqual([ok.body.sent, ok.body.emailed], [2, 1]);
  assert.strictEqual(mails[0].to, 'riya@example.com');
  const link = mails[0].html.match(/email-unsubscribe\?e=([^&"]+)&amp;t=([^"&]+)/);
  assert.ok(link, 'unsubscribe link');
  assert.ok(EU.verifyEmail(Buffer.from(link[1], 'base64url').toString(), link[2]));
  const emailRows = writes.filter((w) => w.campaign_key === 'new-title-email:a-court-of-splintered-harmony');
  assert.strictEqual(emailRows.length, 1);
  assert.ok(!JSON.stringify(emailRows).includes('riya@example.com'), 'no plain address in the ledger');
  // Next press: the ledger stops a second email and a second WhatsApp.
  tables.whatsapp_campaign_deliveries.push(...writes.map((w, i) => ({ id: 100 + i, created_at: '2026-01-01T00:00:00Z', ...w })));
  const again = await call(handler, boughtBody({ dry_run: true }));
  assert.strictEqual(again.body.email.counts.already_emailed_this_book, 1);
  assert.strictEqual(again.body.will_send, 0);
});

test('an email to another book does not hold back WhatsApp, and a WhatsApp does not hold back email', async () => {
  const tables = boughtTables();
  tables.whatsapp_campaign_deliveries.push(
    { id: 9, campaign_key: 'new-title-email:other', customer_phone: '919000000001', status: 'sent', created_at: now },
    { id: 10, campaign_key: 'weekly-y', customer_phone: '919000000005', status: 'sent', created_at: now });
  const r = await call(loadHandler({ tables, sent: [], writes: [], mails: [] }), boughtBody({ dry_run: true }));
  assert.strictEqual(r.body.counts.cooldown, 1);              // Kabir's WhatsApp broadcast
  assert.strictEqual(r.body.email.counts.cooldown, 1);        // Riya's other email
  assert.strictEqual(r.body.will_send, 1);                    // Riya still gets WhatsApp
  assert.strictEqual(r.body.email.will_email, 1);             // Kabir still gets email
});

test('email only: no WhatsApp sent; unreadable unsubscribe list blocks the email send', async () => {
  const sent = [], mails = [];
  const ok = await call(loadHandler({ tables: boughtTables(), sent, writes: [], mails }), boughtBody({ whatsapp: false, dry_run: false, expect_email: 2 }));
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.deepStrictEqual([sent.length, mails.length], [0, 2]);
  const broken = await call(loadHandler({ tables: boughtTables(), sent, writes: [], mails, unsubBroken: true }), boughtBody({ dry_run: true }));
  assert.match(broken.body.email.blocked_reason, /unreadable/);
  const r = await call(loadHandler({ tables: boughtTables(), sent, writes: [], mails, unsubBroken: true }), boughtBody({ dry_run: false, expect: 2, expect_email: 0 }));
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual([sent.length, mails.length], [0, 2]);
});

test('bought audience refuses unknown books and the book itself', async () => {
  const h = loadHandler({ tables: boughtTables(), sent: [], writes: [] });
  assert.strictEqual((await call(h, boughtBody({ bought_slugs: 'no-such-book', dry_run: true }))).status, 400);
  assert.strictEqual((await call(h, boughtBody({ bought_slugs: 'a-court-of-splintered-harmony', dry_run: true }))).status, 400);
});

test('test_email sends one email and writes no ledger row', async () => {
  const writes = [], mails = [];
  const r = await call(loadHandler({ tables: boughtTables(), sent: [], writes, mails }), boughtBody({ test_email: 'me@example.com' }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(mails.length, 1);
  assert.match(mails[0].html, /Since you ordered/);
  assert.strictEqual(writes.length, 0);
});

test('email-unsubscribe: GET only asks, POST records, a forged token does nothing', async () => {
  const unsub = new Map();
  const stubs = { '@netlify/blobs': { getStore: () => ({ setJSON: async (k, v) => { unsub.set(k, v); }, list: async () => ({ blobs: [] }) }) } };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return Object.prototype.hasOwnProperty.call(stubs, req) ? stubs[req] : orig.call(this, req, ...rest); };
  let h;
  try { delete require.cache[require.resolve('../email-unsubscribe')]; delete require.cache[require.resolve('./email-unsub')]; h = require('../email-unsubscribe').handler; } finally { Module._load = orig; }
  const url = new URL(EU.unsubscribeUrl('Riya@Example.com'));
  const q = Object.fromEntries(url.searchParams);
  const get = await h({ httpMethod: 'GET', queryStringParameters: q });
  assert.match(get.body, /<form method="post"/);
  assert.strictEqual(unsub.size, 0);
  const bad = await h({ httpMethod: 'POST', queryStringParameters: { ...q, t: 'x'.repeat(24) } });
  assert.match(bad.body, /not valid/);
  assert.strictEqual(unsub.size, 0);
  const post = await h({ httpMethod: 'POST', queryStringParameters: q });
  assert.match(post.body, /unsubscribed/);
  assert.ok(unsub.has(EU.hashEmail('riya@example.com')));
});

test('cover: the whole cover is fitted into a 1.91:1 banner for WhatsApp, the email keeps it upright', async () => {
  const tables = baseTables();
  tables.custom_products[0].image_url = 'https://inkandchai.in/images/acosh.webp';
  const banner = 'https://wsrv.nl/?url=' + encodeURIComponent('https://inkandchai.in/images/acosh.webp') + '&w=800&h=418&fit=contain&cbg=1a1613&output=jpg&q=80';
  images = { [banner]: JPEG };
  try {
    const sent = [], mails = [];
    const handler = loadHandler({ tables, sent, writes: [], mails });
    const dry = await call(handler, { slug: 'a-court-of-splintered-harmony', dry_run: true, email: true });
    assert.strictEqual(dry.body.cover.url, banner);
    assert.strictEqual(dry.body.cover.fallback, false);
    await call(handler, { slug: 'a-court-of-splintered-harmony', dry_run: false, expect: 1, expect_email: dry.body.email.will_email });
    assert.strictEqual(sent[0].headerImageUrl, banner);
    assert.match(dry.body.email.preview_html, /w=440&amp;output=jpg/);
  } finally { images = {}; }
});
