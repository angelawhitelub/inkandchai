'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./ad-spend');
const D = require('./daily-profit');

const NOW = Date.parse('2026-10-19T08:00:00Z');   // 13:30 IST, 19 Oct

test('IST days: 23:00 UTC is already the next day in India', () => {
  assert.equal(S.istDay('2026-10-18T19:00:00Z'), '2026-10-19');
  assert.equal(S.istDay('2026-10-18T18:00:00Z'), '2026-10-18');
  assert.equal(S.istDayStart('2026-10-19').toISOString(), '2026-10-18T18:30:00.000Z');
  assert.deepEqual(D.lastDays(3, new Date(NOW)), ['2026-10-19', '2026-10-18', '2026-10-17']);
});

test('spend rows are validated before they reach the table', () => {
  const ok = S.normalizeRows('google', '123-456-7890', [{ date: '20261019', cost: '1234.567', clicks: 10 }], new Date(NOW));
  assert.deepEqual(ok.rows[0].day, '2026-10-19');
  assert.equal(ok.rows[0].spend_inr, 1234.57);
  assert.equal(ok.rows[0].account, '123-456-7890');
  assert.match(S.normalizeRows('google', 'x', [{ date: '2026-10-19', cost: -5 }]).error, /Bad cost/);
  assert.match(S.normalizeRows('google', 'x', [{ date: 'yesterday', cost: 5 }]).error, /Bad date/);
  assert.match(S.normalizeRows('google', 'x', [{ date: '2027-01-01', cost: 5 }], new Date(NOW)).error, /Bad date/);
  assert.match(S.normalizeRows('tiktok', 'x', [{ date: '2026-10-19', cost: 5 }]).error, /platform/);
  assert.match(S.normalizeRows('google', '', [{ date: '2026-10-19', cost: 5 }]).error, /account/);
});

test('Meta insights: every page is read, and a non-INR account is refused', async () => {
  const pages = {
    first: { data: [{ date_start: '2026-10-18', spend: '500.10', clicks: '20', impressions: '900', account_currency: 'INR' }], paging: { next: 'https://graph.facebook.com/next' } },
    'https://graph.facebook.com/next': { data: [{ date_start: '2026-10-19', spend: '120', account_currency: 'INR' }] },
  };
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, auth: opts.headers.Authorization });
    const body = url.startsWith('https://graph.facebook.com/v21.0/act_42/insights') ? pages.first : pages[url];
    return { ok: true, json: async () => body };
  };
  const rows = await S.metaDailySpend({ token: 't0k', accountId: '42', since: '2026-10-18', until: '2026-10-19', fetchImpl });
  assert.deepEqual(rows.map(r => [r.date, r.cost]), [['2026-10-18', '500.10'], ['2026-10-19', '120']]);
  assert.equal(seen[0].auth, 'Bearer t0k');
  assert.match(seen[0].url, /time_increment=1/);

  const usd = async () => ({ ok: true, json: async () => ({ data: [{ date_start: '2026-10-19', spend: '5', account_currency: 'USD' }] }) });
  await assert.rejects(S.metaDailySpend({ token: 't', accountId: '1', since: 'a', until: 'b', fetchImpl: usd }), /USD/);
  const denied = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid OAuth access token', code: 190 } }) });
  await assert.rejects(S.metaDailySpend({ token: 't', accountId: '1', since: 'a', until: 'b', fetchImpl: denied }), /Invalid OAuth.*190/);
  assert.deepEqual(S.metaAccounts('act_111, 222'), ['111', '222']);
});

// ── the model ───────────────────────────────────────────────────────────────
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const cod = (over) => ({ status: 'cod_pending', amount_paise: 40000, cart_items: [{ title: 'Book', qty: 1, price: 400 }], ...over });
const prepaid = (over) => ({ status: 'paid', razorpay_payment_id: 'pay_1', amount_paise: 30000, cart_items: [{ title: 'Book', qty: 1, price: 300 }], ...over });

function history() {
  const out = [];
  // 100 matured COD: 60 delivered, 25 RTO, 15 cancelled.
  for (let i = 0; i < 60; i++) out.push(cod({ status: 'delivered', tracking_id: 'A', created_at: daysAgo(30) }));
  for (let i = 0; i < 25; i++) out.push(cod({ status: 'rto', tracking_id: 'A', created_at: daysAgo(30) }));
  for (let i = 0; i < 15; i++) out.push(cod({ status: 'cancelled', created_at: daysAgo(30) }));
  // 50 matured prepaid: 48 delivered, 2 RTO.
  for (let i = 0; i < 48; i++) out.push(prepaid({ status: 'delivered', tracking_id: 'A', created_at: daysAgo(30) }));
  for (let i = 0; i < 2; i++) out.push(prepaid({ status: 'rto', tracking_id: 'A', created_at: daysAgo(30) }));
  // Too young to count, and too old to count.
  out.push(cod({ status: 'rto', tracking_id: 'A', created_at: daysAgo(5) }));
  out.push(cod({ status: 'rto', tracking_id: 'A', created_at: daysAgo(200) }));
  return out;
}

test('outcome averages come from finished orders 20-80 days old, per payment kind', () => {
  const a = D.outcomeAverages(history(), NOW);
  assert.equal(a.cod.sample, 100);
  assert.equal(a.cod.p_delivered, 0.6);
  assert.equal(a.cod.p_rto, 0.25);
  assert.equal(a.cod.p_cancelled, 0.15);
  assert.equal(Math.round(a.cod.p_delivered_if_shipped * 1000) / 1000, 0.706);
  assert.equal(a.prepaid.p_delivered, 0.96);
  assert.equal(D.payKind(prepaid({ status: 'delivered' })), 'prepaid');
  assert.equal(D.payKind(cod({ status: 'delivered', shipment_payment_type: 'cod' })), 'cod');
  assert.equal(D.payKind({ razorpay_order_id: 'IC-R-20261019-AAAAA', status: 'replacement_pending' }), 'replacement');
});

test('a thin sample falls back to the all-orders rates', () => {
  const few = history().filter(o => !o.razorpay_payment_id).concat([prepaid({ status: 'delivered', tracking_id: 'A', created_at: daysAgo(30) })]);
  const a = D.outcomeAverages(few, NOW);
  assert.equal(a.prepaid.fallback, true);
  assert.equal(a.prepaid.p_delivered, a.all.p_delivered);
});

test('today: real ad spend, unshipped orders at their expected value', () => {
  const avgs = D.outcomeAverages(history(), NOW);
  const today = [cod({ created_at: daysAgo(0.1) }), prepaid({ created_at: daysAgo(0.1) })];
  const spend = { byDay: { '2026-10-19': { google: 300, meta: 200, total: 500 } } };
  const [row] = D.dailyProfit({ orders: today, days: ['2026-10-19'], spend, avgs, platforms: ['google', 'meta'], rateOverrides: { shippingPerOrder: 62, bookCost: 80 } });
  assert.equal(row.orders, 2);
  assert.equal(row.cod, 1); assert.equal(row.prepaid, 1);
  assert.equal(row.order_value, 700);
  // COD 400 × 0.60 + prepaid 300 × 0.96
  assert.equal(row.revenue, 528);
  // COD 62 × (0.60 + 2×0.25) + prepaid 62 × (0.96 + 2×0.04)
  assert.equal(row.shipping, Math.round((62 * 1.1 + 62 * 1.04) * 100) / 100);
  assert.equal(row.cogs, Math.round((80 * 0.6 + 80 * 0.96) * 100) / 100);
  assert.equal(row.ads, 500); assert.equal(row.ads_google, 300); assert.equal(row.ads_meta, 200);
  assert.equal(row.ads_source, 'actual');
  assert.equal(row.ads_per_order, 250);
  assert.equal(row.net, Math.round((528 - 500 - row.shipping - row.cogs) * 100) / 100);
});

test('a day with no spend data uses the average, and finished orders use what happened', () => {
  const avgs = D.outcomeAverages(history(), NOW);
  const orders = [
    cod({ status: 'delivered', tracking_id: 'A', created_at: daysAgo(3) }),
    cod({ status: 'cancelled', created_at: daysAgo(3) }),
  ];
  const day = S.istDay(daysAgo(3));
  const [row] = D.dailyProfit({ orders, days: [day], spend: { byDay: {} }, avgs, platforms: ['google'], rateOverrides: { adCostPerOrder: 92, shippingPerOrder: 62, bookCost: 80 } });
  assert.equal(row.ads_source, 'average');
  assert.equal(row.ads, 184);
  assert.equal(row.revenue, 400);
  assert.equal(row.order_value, 400);      // the cancelled one is not "ordered value"
  assert.equal(row.shipping, 62);          // cancelled ships nothing
  assert.equal(row.cogs, 80);
  assert.equal(row.settled, 2);
});

test('a replacement earns nothing but still costs the parcel and the book', () => {
  const avgs = D.outcomeAverages(history(), NOW);
  const e = D.expectedOrder({ razorpay_order_id: 'IC-R-20261019-AAAAA', status: 'replacement_pending', amount_paise: 0, cart_items: [{ qty: 2, price: 300 }] }, avgs, { shippingPerOrder: 62, bookCost: 80 });
  assert.equal(e.revenue, 0);
  assert.equal(e.shipping, 62);
  assert.equal(e.cogs, 160);
});
