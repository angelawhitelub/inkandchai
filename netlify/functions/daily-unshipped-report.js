/**
 * Netlify Scheduled Function: daily-unshipped-report
 * Runs daily at 9 PM IST (15:30 UTC) — cron: "30 15 * * *"
 *
 * Fetches all unshipped orders (no tracking_id, not terminal/payment-pending),
 * builds a CSV, and emails it to the store owner.
 *
 * Excluded statuses (payment not yet confirmed — no need to act on these):
 *   pending, pending_phonepe, pending_partial_phonepe
 *
 * Excluded terminal statuses (already done):
 *   shipped, out_for_delivery, delivered, cancelled, refunded
 */

const { createClient } = require('@supabase/supabase-js');
const { sendEmail }    = require('./utils/email');

// Statuses we never want in the report
const EXCLUDE_STATUSES = [
  'shipped', 'out_for_delivery', 'delivered',
  'cancelled', 'refunded',
  'pending', 'pending_phonepe', 'pending_partial_phonepe',
];

// ── CSV helpers ───────────────────────────────────────────────────────────────

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('\n') || s.includes('"')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Wide format: ONE row per order.
// Product columns: Product(1), SKU(1), Qty(1), Product(2), SKU(2), Qty(2), …
// maxProducts determines how many Product/SKU/Qty column groups to emit.
function buildCsvHeader(maxProducts) {
  const base = [
    'Order ID', 'Date (IST)', 'Status', 'Payment Type',
    'Customer Name', 'Phone', 'Email', 'Address', 'Total (₹)',
  ];
  for (let i = 1; i <= maxProducts; i++) {
    base.push(`Product(${i})`, `SKU(${i})`, `Qty(${i})`);
  }
  base.push('Tracking ID');
  return base.map(csvEscape).join(',');
}

function orderToCsvRow(o, maxProducts) {
  const items     = Array.isArray(o.cart_items) ? o.cart_items : [];
  const totalRs   = ((o.amount_paise || 0) / 100).toFixed(2);

  const meta      = (items[0] || {}).__payment || (items[0] || {})._payment || {};
  const isPartial = meta.mode === 'partial_cod' || o.status === 'partial_cod_pending';
  const payType   = isPartial ? 'Partial COD (10% paid)'
                  : o.status === 'cod_pending' ? 'COD'
                  : 'Prepaid';

  const orderId = o.razorpay_order_id || o.id;
  const dateStr = o.created_at
    ? new Date(o.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    : '';

  const row = [
    orderId, dateStr, o.status, payType,
    o.customer_name || '', o.customer_phone || '', o.customer_email || '',
    o.customer_address || '', totalRs,
  ];

  // Fill product columns — one slot per maxProducts, pad with blanks
  for (let i = 0; i < maxProducts; i++) {
    const item = items[i];
    row.push(
      item ? (item.title || item.name || '—') : '',
      item ? (item.sku   || '')               : '',
      item ? (item.qty   || 1)                : '',
    );
  }

  row.push(o.tracking_id || '');
  return row.map(csvEscape).join(',');
}

// ── Email HTML wrapper ────────────────────────────────────────────────────────

function reportEmailHtml(count, dateStr, csvContent) {
  return `
  <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:640px;margin:0 auto;padding:32px;">
    <h1 style="color:#c9a84c;font-size:22px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
    <p style="color:#a09080;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-bottom:28px;">Daily Unshipped Orders Report</p>

    <h2 style="color:#f0e8d8;font-size:18px;font-weight:400;">📦 ${count} order${count !== 1 ? 's' : ''} awaiting shipment</h2>
    <p style="color:#a09080;font-size:13px;">Report generated: ${dateStr} IST</p>
    <p style="color:#a09080;font-size:13px;line-height:1.7;">
      This report includes all orders that have not yet been shipped (no tracking ID assigned),
      excluding payment-pending and already-completed orders.<br/>
      The CSV data is pasted below — copy it into a spreadsheet or open with Excel/Google Sheets.
    </p>

    <div style="margin:24px 0;padding:16px;background:#1c1916;border-left:3px solid #c9a84c;border-radius:2px;">
      <p style="color:#c9a84c;font-size:12px;letter-spacing:1px;text-transform:uppercase;margin:0 0 12px;">CSV DATA</p>
      <pre style="color:#f0e8d8;font-size:11px;white-space:pre-wrap;word-break:break-all;margin:0;line-height:1.6;overflow:auto;">${csvContent.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
    </div>

    <hr style="border:none;border-top:1px solid #2a2a2a;margin:28px 0;"/>
    <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai · inkandchai.in · Automated daily report</p>
  </div>`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async () => {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
    );

    // Fetch all non-terminal, non-payment-pending orders without a tracking_id.
    // Supabase doesn't support NOT IN directly via the JS client on nullable cols,
    // so we fetch broadly and filter client-side (volume is small).
    const { data: orders, error } = await supabase
      .from('orders')
      .select('*')
      .or('source.is.null,source.neq.paperbound')  // exclude paperbound store's orders (shared DB)
      .is('tracking_id', null)           // no tracking assigned yet
      .not('status', 'in', `(${EXCLUDE_STATUSES.map(s => `"${s}"`).join(',')})`)
      .order('created_at', { ascending: true })
      .limit(500);

    if (error) {
      console.error('Supabase fetch error:', error.message);
      return { statusCode: 500, body: error.message };
    }

    // Secondary client-side filter: also exclude any order where tracking_id is
    // an empty string rather than NULL (defensive), and double-check status.
    const unshipped = (orders || []).filter(o => {
      if (o.tracking_id && String(o.tracking_id).trim()) return false;   // has tracking
      const s = String(o.status || '').toLowerCase();
      return !EXCLUDE_STATUSES.includes(s);
    });

    const nowIST = new Date().toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    const reportTo = process.env.DAILY_REPORT_EMAIL || 'asfkhn234@gmail.com';
    const count    = unshipped.length;

    if (count === 0) {
      await sendEmail({
        to: reportTo,
        subject: `📦 Ink & Chai — No unshipped orders today (${nowIST})`,
        html: reportEmailHtml(0, nowIST, '(No pending orders — all clear! ✅)'),
      });
      console.log('Daily report sent: 0 unshipped orders');
      return { statusCode: 200, body: 'No unshipped orders — empty report sent.' };
    }

    // Wide format: find the max number of line items in any single order
    // so we know how many Product(N)/SKU(N)/Qty(N) columns to generate.
    const maxProducts = Math.max(1, ...unshipped.map(o =>
      Array.isArray(o.cart_items) ? o.cart_items.length : 1
    ));

    const csvLines = [
      buildCsvHeader(maxProducts),
      ...unshipped.map(o => orderToCsvRow(o, maxProducts)),
    ];
    const csvContent = csvLines.join('\n');

    await sendEmail({
      to: reportTo,
      subject: `📦 Ink & Chai — ${count} unshipped order${count !== 1 ? 's' : ''} · ${nowIST}`,
      html: reportEmailHtml(count, nowIST, csvContent),
    });

    console.log(`Daily unshipped report sent: ${count} orders → ${reportTo}`);
    return { statusCode: 200, body: `Report sent: ${count} orders` };

  } catch (err) {
    console.error('daily-unshipped-report error:', err);
    return { statusCode: 500, body: err.message };
  }
};
