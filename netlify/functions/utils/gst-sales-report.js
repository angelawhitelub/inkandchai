'use strict';

const NEVER_INVOICED = new Set([
  'pending', 'online_pending', 'pending_phonepe', 'pending_partial_phonepe',
  'payment_failed', 'failed', 'cod_awaiting_confirmation',
]);
const FULL_REFUND_STATUSES = new Set(['refunded']);
const PROVISIONAL_REFUND_STATUSES = new Set(['refund_pending', 'refund_failed']);
const CANCELLED_STATUSES = new Set(['cancelled']);
const RTO_STATUSES = new Set(['rto', 'lost']);

const normalize = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const inPeriod = (value, start, end) => {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) && ms >= start.getTime() && ms < end.getTime();
};
const itemsOf = order => Array.isArray(order?.cart_items) ? order.cart_items : [];
const itemQty = item => Math.max(1, Number(item?.qty) || 1);
const itemPaise = item => Math.max(0, Math.round((Number(item?.price) || 0) * itemQty(item) * 100));

function orderTotalPaise(order) {
  const meta = itemsOf(order)[0]?._payment || {};
  const full = Number(meta.full_total);
  if (Number.isFinite(full) && full > 0) return Math.round(full * 100);
  const stored = Number(order?.amount_paise);
  if (Number.isFinite(stored) && stored > 0) return Math.round(stored);
  return itemsOf(order).reduce((sum, item) => sum + itemPaise(item), 0);
}

function refundItemsPaise(order) {
  const refundItems = Array.isArray(order?.refund_items) ? order.refund_items : [];
  return refundItems.reduce((sum, item) => sum + itemPaise(item), 0);
}

function displayId(order) {
  return String(order?.razorpay_order_id || order?.id || '').trim();
}

function buyerGstin(order) {
  const direct = order?.customer_gstin || order?.buyer_gstin || order?.gstin || '';
  const match = String(direct || order?.customer_address || '').toUpperCase()
    .match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/);
  return match ? match[0] : '';
}

function customerState(order) {
  const direct = order?.customer_state || order?.shipping_state || order?.billing_state || '';
  if (String(direct).trim()) return String(direct).trim();
  const address = String(order?.customer_address || '');
  const pin = address.match(/\b([1-9]\d{5})\b/)?.[1] || '';
  // Delhi PINs are 110xxx. This gives a reliable intra-state answer even for
  // old free-text addresses whose city/state segments were omitted.
  if (/^110\d{3}$/.test(pin)) return 'Delhi';
  const withoutPin = address.replace(/\b[1-9]\d{5}\b/g, '');
  const parts = withoutPin.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 1];
  return /\b(delhi|new delhi|nct of delhi)\b/i.test(address) ? 'Delhi' : '';
}

function placeOfSupply(order, supplierState) {
  const state = customerState(order);
  if (!state) return { state: '', bucket: 'unknown' };
  return { state, bucket: normalize(state) === normalize(supplierState) ? 'intra' : 'inter' };
}

function hsnOf(item) {
  return String(item?.hsn || item?.hsn_code || item?.hsnCode || '4901').replace(/\D/g, '') || '4901';
}

function parseMonth(value, field = 'month') {
  const month = String(value || '');
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`${field} must be YYYY-MM`);
  const [year, mon] = month.split('-').map(Number);
  if (mon < 1 || mon > 12) throw new Error(`${field} must be YYYY-MM`);
  return { month, year, mon, index: (year * 12) + mon - 1 };
}

function periodBounds(fromMonth, toMonth = fromMonth) {
  const from = parseMonth(fromMonth, 'from_month');
  const to = parseMonth(toMonth, 'to_month');
  if (to.index < from.index) throw new Error('to_month cannot be earlier than from_month');
  const monthCount = to.index - from.index + 1;
  if (monthCount > 3) throw new Error('GST report range cannot exceed 3 calendar months');
  const start = new Date(`${from.month}-01T00:00:00+05:30`);
  const nextYear = to.mon === 12 ? to.year + 1 : to.year;
  const nextMon = to.mon === 12 ? 1 : to.mon + 1;
  const end = new Date(`${nextYear}-${String(nextMon).padStart(2, '0')}-01T00:00:00+05:30`);
  return { start, end, fromMonth: from.month, toMonth: to.month, monthCount };
}

function buildGstSalesReport({ month, fromMonth = month, toMonth = fromMonth, orders = [], returns = [], supplierState = 'Delhi', supplierStateCode = '07' }) {
  const { start, end, monthCount } = periodBounds(fromMonth, toMonth);
  const byOrderId = new Map(orders.map(order => [String(order.id), order]));
  const exceptions = [];
  const reconciliation = [];
  const values = { gross: 0, cancelled: 0, rto: 0, refunds: 0, net: 0, intra: 0, inter: 0, unknown: 0 };
  const table8 = {
    inter_registered: 0, intra_registered: 0,
    inter_unregistered: 0, intra_unregistered: 0,
  };
  const hsn = new Map();
  const invoiceOrders = [];
  const refundEvents = new Map();

  function addHsn(order, sign, scale = 1) {
    const registered = !!buyerGstin(order);
    const productItems = itemsOf(order).filter(item => item && String(item.title || item.name || '').trim());
    const rawItemsPaise = productItems.reduce((sum, item) => sum + itemPaise(item), 0);
    // Shipping/handling and order-level discounts form part of the order
    // consideration. Allocate them proportionately so Table 12 reconciles to
    // Tables 8 and 3B instead of reporting only the sticker prices.
    const allocationFactor = rawItemsPaise > 0 ? orderTotalPaise(order) / rawItemsPaise : 1;
    for (const item of productItems) {
      // Checkout metadata (_payment, _coupon, etc.) is attached to the first
      // real product line in historic orders, so it must not make that book
      // disappear from Table 12.
      if (!item || !String(item.title || item.name || '').trim()) continue;
      const code = hsnOf(item);
      const key = `${registered ? 'B2B' : 'B2C'}:${code}`;
      const row = hsn.get(key) || {
        section: registered ? 'B2B' : 'B2C', hsn: code,
        description: code === '4901' ? 'Printed books, brochures, leaflets and similar printed matter' : 'Book / printed matter',
        uqc: 'NOS', quantity: 0, totalValuePaise: 0, taxableValuePaise: 0,
        rate: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0,
      };
      row.quantity += sign * itemQty(item) * scale;
      row.totalValuePaise += sign * itemPaise(item) * allocationFactor * scale;
      row.taxableValuePaise += sign * itemPaise(item) * allocationFactor * scale;
      hsn.set(key, row);
      const title = String(item.title || item.name || 'Book');
      if (code === '4901' && /\b(colou?r(?:ing)?|activity book|picture book)\b/i.test(title)) {
        exceptions.push({ orderId: displayId(order), type: 'HSN review', detail: `${title}: verify whether HSN 4903 applies instead of the default 4901.` });
      }
    }
  }

  function addNet(order, paise, sign, reason) {
    if (!paise) return;
    const pos = placeOfSupply(order, supplierState);
    const registered = !!buyerGstin(order);
    const signed = sign * paise;
    values[pos.bucket] += signed;
    if (pos.bucket === 'unknown') {
      exceptions.push({ orderId: displayId(order), type: 'Missing place of supply', detail: 'Customer state could not be parsed. This value is excluded from the intra/inter filing cells.' });
      return;
    }
    table8[`${pos.bucket}_${registered ? 'registered' : 'unregistered'}`] += signed;
    if (reason) reconciliation.push({ orderId: displayId(order), event: reason, state: pos.state, registered, amountPaise: signed });
  }

  for (const order of orders) {
    const status = String(order.status || '').toLowerCase();
    const saleInPeriod = inPeriod(order.created_at, start, end);
    const total = orderTotalPaise(order);

    if (saleInPeriod && !NEVER_INVOICED.has(status)) {
      invoiceOrders.push(order);
      values.gross += total;
      addNet(order, total, 1, 'Gross outward supply');
      addHsn(order, 1);

      if (CANCELLED_STATUSES.has(status)) {
        values.cancelled += total;
        addNet(order, total, -1, 'Cancelled order');
        addHsn(order, -1);
      } else if (RTO_STATUSES.has(status)) {
        values.rto += total;
        addNet(order, total, -1, `Order ${status.toUpperCase()}`);
        addHsn(order, -1);
      }
    }

    const refundDate = order.refund_updated_at || (saleInPeriod ? order.created_at : null);
    if (FULL_REFUND_STATUSES.has(status) && inPeriod(refundDate, start, end)) {
      refundEvents.set(String(order.id), { order, amountPaise: total, full: true, source: 'Gateway refund' });
    } else if (status === 'partially_refunded' && inPeriod(refundDate, start, end)) {
      const amount = refundItemsPaise(order);
      if (amount > 0) refundEvents.set(String(order.id), { order, amountPaise: amount, full: false, source: 'Partial gateway refund' });
      else exceptions.push({ orderId: displayId(order), type: 'Unknown partial refund amount', detail: 'refund_items has no usable prices; enter this adjustment manually after checking the gateway.' });
    } else if (PROVISIONAL_REFUND_STATUSES.has(status) && inPeriod(refundDate, start, end)) {
      exceptions.push({ orderId: displayId(order), type: 'Refund not completed', detail: `Status is ${status}; no GST sales reduction has been applied.` });
    }
  }

  for (const ret of returns) {
    if (!inPeriod(ret.refunded_at, start, end)) continue;
    const order = byOrderId.get(String(ret.order_id));
    if (!order) {
      exceptions.push({ orderId: ret.order_display_id || ret.order_id, type: 'Return order missing', detail: 'Completed return was found but its original order was unavailable.' });
      continue;
    }
    const amount = Math.max(0, Number(ret.refund_amount_paise) || 0);
    const existing = refundEvents.get(String(order.id));
    if (!existing || amount > existing.amountPaise) {
      refundEvents.set(String(order.id), { order, amountPaise: amount, full: amount >= orderTotalPaise(order), source: 'Completed return refund' });
    }
  }

  for (const event of refundEvents.values()) {
    const amount = Math.min(event.amountPaise, orderTotalPaise(event.order));
    values.refunds += amount;
    addNet(event.order, amount, -1, event.source);
    if (event.full) addHsn(event.order, -1);
    else {
      const orderTotal = orderTotalPaise(event.order);
      addHsn(event.order, -1, orderTotal > 0 ? amount / orderTotal : 0);
    }
  }

  values.net = values.gross - values.cancelled - values.rto - values.refunds;

  const ids = invoiceOrders.map(displayId).filter(Boolean);
  const cancelledDocs = invoiceOrders.filter(o => CANCELLED_STATUSES.has(String(o.status || '').toLowerCase())).length;
  const creditNoteCount = refundEvents.size;
  if (creditNoteCount) {
    exceptions.push({ orderId: '', type: 'Credit-note documents required', detail: `${creditNoteCount} refund adjustment(s) exist, but the website does not store formal credit-note serial numbers. Issue/verify them before completing Table 13.` });
  }

  const rupees = paise => Number((paise / 100).toFixed(2));
  const table8Rows = [
    ['8A', 'Inter-State supplies to registered persons', table8.inter_registered],
    ['8B', 'Intra-State supplies to registered persons', table8.intra_registered],
    ['8C', 'Inter-State supplies to unregistered persons', table8.inter_unregistered],
    ['8D', 'Intra-State supplies to unregistered persons', table8.intra_unregistered],
  ].map(([cell, description, paise]) => ({ cell, description, nilRated: rupees(paise), exempted: 0, nonGst: 0 }));

  return {
    meta: {
      month: fromMonth === toMonth ? fromMonth : `${fromMonth} to ${toMonth}`,
      fromMonth, toMonth, monthCount,
      periodLabel: fromMonth === toMonth ? fromMonth : `${fromMonth} to ${toMonth}`,
      periodStart: start.toISOString(), periodEndExclusive: end.toISOString(),
      supplierState, supplierStateCode, generatedAt: new Date().toISOString(),
      basis: 'Order/invoice date for outward supplies; completed refund date for reductions; amounts include checkout shipping/handling consideration.',
    },
    summary: {
      grossSales: rupees(values.gross), cancelledOrders: rupees(values.cancelled),
      rtoLost: rupees(values.rto), completedRefunds: rupees(values.refunds),
      netNilRatedSales: rupees(values.net), intraStateNet: rupees(values.intra),
      interStateNet: rupees(values.inter), unclassifiedStateNet: rupees(values.unknown),
      invoicesIssued: invoiceOrders.length, potentialCreditNotes: creditNoteCount,
    },
    gstr1Table8: table8Rows,
    gstr1Table12: [...hsn.values()].map(row => ({
      section: row.section, hsn: row.hsn, description: row.description, uqc: row.uqc,
      quantity: Number(row.quantity.toFixed(2)), totalValue: rupees(row.totalValuePaise),
      taxableValue: rupees(row.taxableValuePaise), rate: row.rate,
      igst: 0, cgst: 0, sgst: 0, cess: 0,
    })),
    gstr1Table13: [
      { document: 'Invoices for outward supply', serialFrom: ids[0] || '', serialTo: ids[ids.length - 1] || '', totalIssued: invoiceOrders.length, cancelled: cancelledDocs, netIssued: invoiceOrders.length - cancelledDocs, filingStatus: 'Calculated' },
      { document: 'Credit notes', serialFrom: '', serialTo: '', totalIssued: creditNoteCount, cancelled: 0, netIssued: creditNoteCount, filingStatus: creditNoteCount ? 'Enter formal credit-note serial range after verification' : 'No refund adjustments found' },
    ],
    gstr3b: [
      { cell: '3.1(c)', description: 'Other outward supplies (Nil rated, exempted)', taxableValue: rupees(values.net), integratedTax: 0, centralTax: 0, stateTax: 0, cess: 0 },
    ],
    reconciliation: reconciliation.map(row => ({ ...row, amount: rupees(row.amountPaise) })),
    exceptions,
  };
}

module.exports = {
  buildGstSalesReport, periodBounds, orderTotalPaise, customerState, buyerGstin,
};
