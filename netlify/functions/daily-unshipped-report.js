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
  'refund_pending', 'refund_failed',   // refund owed (order cancelled/returned) — not a book to ship
  'rto', 'undelivered', 'lost',        // post-shipment terminal states — not to (re)ship
  'pending', 'pending_phonepe', 'pending_partial_phonepe',
  'cod_awaiting_confirmation',   // high-value COD not yet confirmed by customer — not shippable yet
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

// Crossword-migrated genuine-tag orders (IC-CW-… / IC-R-CW-…). Same test the
// admin's Crossword filter uses. These ship on a separate sourcing workflow, so
// they also get their own CSV alongside the main report.
function isCrosswordOrder(o) {
  return /^IC-(?:R-)?CW-/i.test(String(o.razorpay_order_id || ''));
}

// One readable cell: "Atomic Habits ×1; Deep Work ×2".
function itemsSummary(items) {
  return items
    .map(i => `${i.title || i.name || 'Book'} ×${Math.max(1, Number(i.qty || i.quantity || 1))}`)
    .join('; ');
}

// ONE row per order. Product names + quantities live in a single "Items" cell so
// the file stays readable in Excel/Sheets regardless of how many books an order has.
const CSV_HEADER = [
  'Order ID', 'Date (IST)', 'Status', 'Payment Type',
  'Customer Name', 'Phone', 'Email', 'Address', 'Total (₹)',
  'Items (name × qty)', 'Total Qty', 'Tracking ID',
].map(csvEscape).join(',');

function orderToCsvRow(o) {
  const items     = Array.isArray(o.cart_items) ? o.cart_items : [];
  const totalRs   = ((o.amount_paise || 0) / 100).toFixed(2);
  const totalQty  = items.reduce((s, i) => s + Math.max(1, Number(i.qty || i.quantity || 1)), 0);

  const meta      = (items[0] || {}).__payment || (items[0] || {})._payment || {};
  const isPartial = meta.mode === 'partial_cod' || o.status === 'partial_cod_pending';
  const payType   = isPartial ? 'Partial COD (10% paid)'
                  : o.status === 'cod_pending' ? 'COD'
                  : 'Prepaid';

  const orderId = o.razorpay_order_id || o.id;
  const dateStr = o.created_at
    ? new Date(o.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    : '';

  return [
    orderId, dateStr, o.status, payType,
    o.customer_name || '', o.customer_phone || '', o.customer_email || '',
    o.customer_address || '', totalRs,
    itemsSummary(items), totalQty || items.length || '',
    o.tracking_id || '',
  ].map(csvEscape).join(',');
}

function buildCsv(orders) {
  return [CSV_HEADER, ...orders.map(orderToCsvRow)].join('\n');
}

// ── Email HTML wrapper ────────────────────────────────────────────────────────

function reportEmailHtml(count, cwCount, dateStr) {
  const fileRow = (label, name) =>
    `<tr><td style="padding:6px 14px 6px 0;color:#c9a84c;">📎 ${label}</td><td style="color:#f0e8d8;font-family:monospace;font-size:12px;">${name}</td></tr>`;
  return `
  <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:640px;margin:0 auto;padding:32px;">
    <h1 style="color:#c9a84c;font-size:22px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
    <p style="color:#a09080;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-bottom:28px;">Daily Unshipped Orders Report</p>

    <h2 style="color:#f0e8d8;font-size:18px;font-weight:400;">📦 ${count} order${count !== 1 ? 's' : ''} awaiting shipment</h2>
    <p style="color:#a09080;font-size:13px;">Report generated: ${dateStr} IST</p>
    <p style="color:#a09080;font-size:13px;line-height:1.7;">
      All orders not yet shipped (no tracking ID), excluding payment-pending and completed orders.
      Open the attached CSV in Excel or Google Sheets — each order's books and quantities are in the
      <strong style="color:#f0e8d8;">Items (name × qty)</strong> column.
      ${cwCount ? `<br/><br/>${cwCount} of these ${cwCount !== 1 ? 'are' : 'is a'} <strong style="color:#c9a84c;">Crossword (CW)</strong> order${cwCount !== 1 ? 's' : ''} — attached separately as well.` : ''}
    </p>

    <div style="margin:24px 0;padding:16px;background:#1c1916;border-left:3px solid #c9a84c;border-radius:2px;">
      <p style="color:#c9a84c;font-size:12px;letter-spacing:1px;text-transform:uppercase;margin:0 0 12px;">Attached files</p>
      <table style="border-collapse:collapse;font-size:13px;">
        ${fileRow('All unshipped', `unshipped-orders-${dateStr.slice(0,11).trim().replace(/\s+/g,'-')}.csv`)}
        ${cwCount ? fileRow('Crossword only', `crossword-orders.csv`) : ''}
      </table>
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
    const dateSlug = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD

    if (count === 0) {
      await sendEmail({
        to: reportTo,
        subject: `📦 Ink & Chai — No unshipped orders today (${nowIST})`,
        html: reportEmailHtml(0, 0, nowIST),
      });
      console.log('Daily report sent: 0 unshipped orders');
      return { statusCode: 200, body: 'No unshipped orders — empty report sent.' };
    }

    // Crossword (CW) orders ship on a separate sourcing workflow, so they get
    // their own CSV alongside the main report. They REMAIN in the main file too,
    // so the main report is still the complete picture.
    const crossword = unshipped.filter(isCrosswordOrder);

    const attachments = [
      { filename: `unshipped-orders-${dateSlug}.csv`, content: buildCsv(unshipped), contentType: 'text/csv' },
    ];
    if (crossword.length) {
      attachments.push({
        filename: `crossword-orders-${dateSlug}.csv`,
        content: buildCsv(crossword),
        contentType: 'text/csv',
      });
    }

    await sendEmail({
      to: reportTo,
      subject: `📦 Ink & Chai — ${count} unshipped order${count !== 1 ? 's' : ''}${crossword.length ? ` (${crossword.length} CW)` : ''} · ${nowIST}`,
      html: reportEmailHtml(count, crossword.length, nowIST),
      attachments,
    });

    console.log(`Daily unshipped report sent: ${count} orders (${crossword.length} CW) → ${reportTo}`);
    return { statusCode: 200, body: `Report sent: ${count} orders, ${crossword.length} crossword` };

  } catch (err) {
    console.error('daily-unshipped-report error:', err);
    return { statusCode: 500, body: err.message };
  }
};
