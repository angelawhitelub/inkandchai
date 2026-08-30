const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGstSalesReport, periodBounds, orderTotalPaise, customerState } = require('./gst-sales-report');

const base = {
  id: '1', razorpay_order_id: 'IC-20260801-A', created_at: '2026-08-01T06:00:00.000Z',
  status: 'delivered', amount_paise: 24900,
  customer_address: '12 Road, Mumbai, Maharashtra, 400001',
  cart_items: [{ title: 'Book A', qty: 1, price: 249 }],
};

test('uses full order value for partial-COD instead of the deposit', () => {
  const order = { amount_paise: 3000, cart_items: [{ title: 'A', qty: 1, price: 299, _payment: { full_total: 339 } }] };
  assert.equal(orderTotalPaise(order), 33900);
  const report = buildGstSalesReport({ month: '2026-08', orders: [{ ...base, ...order }] });
  assert.equal(report.gstr1Table12[0].quantity, 1, 'first product line must survive attached checkout metadata');
  assert.equal(report.gstr1Table12[0].totalValue, 339, 'HSN value must include allocated shipping/handling consideration');
});

test('identifies Delhi PIN as intra-state even without a state segment', () => {
  assert.equal(customerState({ customer_address: '2379, Kucha Mir Hashim, 110006' }), 'Delhi');
});

test('calculates GSTR-1 table 8, HSN table 12 and 3B nil-rated values', () => {
  const report = buildGstSalesReport({ month: '2026-08', supplierState: 'Delhi', orders: [
    base,
    { ...base, id: '2', razorpay_order_id: 'IC-20260802-B', amount_paise: 39900, customer_address: 'Delhi, Delhi, 110002', cart_items: [{ title: 'Book B', qty: 2, price: 199.5 }] },
  ] });
  assert.equal(report.summary.grossSales, 648);
  assert.equal(report.summary.interStateNet, 249);
  assert.equal(report.summary.intraStateNet, 399);
  assert.equal(report.gstr1Table8.find(r => r.cell === '8C').nilRated, 249);
  assert.equal(report.gstr1Table8.find(r => r.cell === '8D').nilRated, 399);
  assert.equal(report.gstr1Table12[0].quantity, 3);
  assert.equal(report.gstr3b[0].taxableValue, 648);
});

test('deducts completed partial refunds but not pending refunds', () => {
  const partial = { ...base, status: 'partially_refunded', refund_updated_at: '2026-08-15T06:00:00Z', refund_items: [{ title: 'Book A', qty: 1, price: 49 }] };
  const pending = { ...base, id: '3', razorpay_order_id: 'IC-20260803-C', status: 'refund_pending', refund_updated_at: '2026-08-15T06:00:00Z' };
  const report = buildGstSalesReport({ month: '2026-08', orders: [partial, pending] });
  assert.equal(report.summary.grossSales, 498);
  assert.equal(report.summary.completedRefunds, 49);
  assert.equal(report.summary.netNilRatedSales, 449);
  assert.ok(report.exceptions.some(e => e.type === 'Refund not completed'));
});

test('does not invent credit-note serial numbers', () => {
  const refunded = { ...base, status: 'refunded', refund_updated_at: '2026-08-10T06:00:00Z' };
  const report = buildGstSalesReport({ month: '2026-08', orders: [refunded] });
  const notes = report.gstr1Table13.find(r => r.document === 'Credit notes');
  assert.equal(notes.totalIssued, 1);
  assert.equal(notes.serialFrom, '');
  assert.match(notes.filingStatus, /formal credit-note/i);
});

test('keeps outward invoice serial range in chronological order', () => {
  const report = buildGstSalesReport({ month: '2026-08', orders: [
    { ...base, id: '1', razorpay_order_id: 'IC-FIRST', created_at: '2026-08-01T06:00:00Z' },
    { ...base, id: '2', razorpay_order_id: 'IC-LAST', created_at: '2026-08-20T06:00:00Z' },
  ] });
  const invoices = report.gstr1Table13[0];
  assert.equal(invoices.serialFrom, 'IC-FIRST');
  assert.equal(invoices.serialTo, 'IC-LAST');
});

test('supports an inclusive report range of up to three months', () => {
  const report = buildGstSalesReport({ fromMonth: '2026-06', toMonth: '2026-08', orders: [
    { ...base, id: 'june', created_at: '2026-06-01T06:00:00Z' },
    { ...base, id: 'august', created_at: '2026-08-31T18:00:00Z' },
    { ...base, id: 'september', created_at: '2026-09-01T06:00:00Z' },
  ] });
  assert.equal(report.meta.monthCount, 3);
  assert.equal(report.meta.periodLabel, '2026-06 to 2026-08');
  assert.equal(report.summary.invoicesIssued, 2);
});

test('rejects reversed and longer-than-three-month GST ranges', () => {
  assert.throws(() => periodBounds('2026-08', '2026-07'), /earlier/);
  assert.throws(() => periodBounds('2026-05', '2026-08'), /cannot exceed 3/);
});
