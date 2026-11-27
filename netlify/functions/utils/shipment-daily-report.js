/**
 * Daily shipment report (owner, 27 Nov 2026): what moved in the last 24 hours
 * -- booked, picked up, delivered, cancelled, back to us -- plus where every
 * open parcel stands right now. Built by shipment-daily-report-scheduled.js
 * and emailed to the owner with a CSV of the day's orders.
 *
 * Read-only. The "moved" times come from the stamps the courier syncs already
 * write: awb_assigned_at, shipment_moved_at (first pickup/in-transit scan),
 * delivered_at, cancelled_at, rto_back_at. The snapshot reads
 * last_courier_status, the courier's own wording as last checked.
 */

const PAGE = 1000;
const OPEN_DAYS = 90;

/** Short courier name for grouping: "Delhivery Surface DT_Stressed" → "Delhivery". */
function courierGroup(name) {
  const n = String(name || '').toLowerCase();
  if (!n.trim()) return 'Not booked';
  if (n.includes('xpress')) return 'XpressBees';
  if (n.includes('delhivery')) return 'Delhivery';
  if (n.includes('dtdc')) return 'DTDC';
  if (n.includes('ekart')) return 'Ekart';
  if (n.includes('bluedart') || n.includes('blue dart')) return 'Blue Dart';
  if (n.includes('amazon')) return 'Amazon';
  if (n.includes('shadowfax')) return 'Shadowfax';
  if (n.includes('india post') || n.includes('speed post')) return 'India Post';
  return String(name).trim();
}

/** Where an open parcel stands, from the courier's last answer. */
function stage(lastStatus, orderStatus) {
  const s = String(lastStatus || '').toLowerCase().trim();
  const st = String(orderStatus || '').toLowerCase();
  if (/^lookup failed|^$/.test(s)) {
    if (st === 'out_for_delivery') return 'Out for delivery';
    return 'Not checked';
  }
  if (/\brto\b|return to origin|returned to/.test(s)) return 'Returning to us (RTO)';
  if (/lost|damage/.test(s)) return 'Lost / damaged';
  if (/out for delivery|\bofd\b/.test(s)) return 'Out for delivery';
  if (/exception|\bndr\b|undeliver|delivery failed|attempt/.test(s)) return 'Delivery problem';
  if (/not picked|pending pickup|pickup pending|pickup scheduled|manifest|booked|awb assigned|ready to ship/.test(s)) return 'Waiting for pickup';
  if (/cancel/.test(s)) return 'Cancelled at courier';
  if (/deliver/.test(s)) return 'Delivered';
  if (/transit|picked|\brad\b|reached|dispatch|shipped|arrived|hub/.test(s)) return 'In transit';
  return 'Other';
}

const STAGE_ORDER = ['Waiting for pickup', 'In transit', 'Out for delivery', 'Delivery problem', 'Returning to us (RTO)', 'Lost / damaged', 'Cancelled at courier', 'Delivered', 'Other', 'Not checked'];

const EVENTS = [
  { key: 'booked', label: 'Booked with a courier', col: 'awb_assigned_at' },
  { key: 'picked', label: 'Picked up', col: 'shipment_moved_at' },
  { key: 'delivered', label: 'Delivered', col: 'delivered_at' },
  { key: 'cancelled', label: 'Cancelled', col: 'cancelled_at' },
  { key: 'rto_back', label: 'Came back to us (RTO)', col: 'rto_back_at' },
];

const COLS = 'id,razorpay_order_id,status,courier_name,tracking_id,courier_cancelled_awb,customer_name,cart_items,last_courier_status,awb_assigned_at,shipment_moved_at,delivered_at,cancelled_at,rto_back_at,created_at';

async function pageAll(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
  }
}

/** Every order with any of the five stamps inside [since, until). */
async function loadEvents(db, { since, until }) {
  const s = since.toISOString(), u = until.toISOString();
  const byId = new Map();
  for (const e of EVENTS) {
    const rows = await pageAll(() => db.from('orders').select(COLS).gte(e.col, s).lt(e.col, u).order('id'));
    for (const r of rows) byId.set(r.id, r);
  }
  return [...byId.values()];
}

/** Every booked parcel not yet finished, placed in the last OPEN_DAYS days. */
async function loadOpen(db, { until }) {
  const from = new Date(until.getTime() - OPEN_DAYS * 864e5).toISOString();
  return pageAll(() => db.from('orders')
    .select('id,status,courier_name,last_courier_status')
    .not('tracking_id', 'is', null).neq('tracking_id', '')
    .is('delivered_at', null).is('cancelled_at', null).is('rto_back_at', null)
    .not('status', 'in', '(delivered,cancelled,refunded,rto,lost,pending,pending_phonepe,pending_partial_phonepe)')
    .gte('created_at', from)
    .order('id'));
}

const inWindow = (v, since, until) => {
  if (!v) return false;
  const t = Date.parse(v);
  return t >= since.getTime() && t < until.getTime();
};

function itemsText(cart) {
  const items = Array.isArray(cart) ? cart : [];
  return items.map((i) => `${Math.max(1, Number(i.qty || i.quantity || 1))}x ${i.title || i.name || 'Book'}`).join('; ');
}
const units = (cart) => (Array.isArray(cart) ? cart : []).reduce((n, i) => n + Math.max(1, Number(i.qty || i.quantity || 1)), 0);

/** Pure: counts and rows from the loaded orders. */
function summarise({ events, open, since, until }) {
  const counts = {};
  const rows = [];
  for (const e of EVENTS) counts[e.key] = { total: 0, books: 0, byCourier: {} };
  counts.cancelled.afterBooking = 0;
  for (const o of events) {
    for (const e of EVENTS) {
      if (!inWindow(o[e.col], since, until)) continue;
      const c = counts[e.key];
      const courier = courierGroup(o.courier_name);
      c.total += 1;
      c.books += units(o.cart_items);
      c.byCourier[courier] = (c.byCourier[courier] || 0) + 1;
      if (e.key === 'cancelled' && (o.tracking_id || o.courier_cancelled_awb)) counts.cancelled.afterBooking += 1;
      rows.push({
        event: e.label, at: o[e.col], order: o.razorpay_order_id || o.id, courier: courier === 'Not booked' ? '' : courier,
        awb: o.tracking_id || o.courier_cancelled_awb || '', customer: o.customer_name || '', items: itemsText(o.cart_items),
        courier_status: o.last_courier_status || '',
      });
    }
  }
  const order = Object.fromEntries(EVENTS.map((e, i) => [e.label, i]));
  rows.sort((a, b) => order[a.event] - order[b.event] || String(a.at).localeCompare(String(b.at)));

  const snapshot = {};
  for (const o of open) {
    const st = stage(o.last_courier_status, o.status);
    if (st === 'Delivered' || st === 'Cancelled at courier') continue; // stamps not caught up yet; not "open"
    const s = (snapshot[st] = snapshot[st] || { total: 0, byCourier: {} });
    const courier = courierGroup(o.courier_name);
    s.total += 1;
    s.byCourier[courier] = (s.byCourier[courier] || 0) + 1;
  }
  return { counts, rows, snapshot };
}

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const istTime = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const split = (by) => Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${esc(k)} ${n}`).join(' · ');

function emailHtml({ counts, snapshot, since, until }) {
  const td = 'padding:6px 10px;border-bottom:1px solid #eee;vertical-align:top;';
  const evRows = EVENTS.map((e) => {
    const c = counts[e.key];
    const extra = e.key === 'cancelled' && c.total ? `<br><span style="color:#666;font-size:12px;">${c.afterBooking} after a courier was booked, ${c.total - c.afterBooking} before</span>` : '';
    return `<tr><td style="${td}">${e.label}</td><td style="${td}text-align:right;font-weight:700;font-size:16px;">${c.total}</td>
      <td style="${td}color:#555;font-size:12px;">${c.total ? `${c.books} books<br>${split(c.byCourier)}` : ''}${extra}</td></tr>`;
  }).join('');
  const stages = STAGE_ORDER.filter((s) => snapshot[s]);
  const snapRows = stages.map((s) => `<tr><td style="${td}">${s}</td><td style="${td}text-align:right;font-weight:700;">${snapshot[s].total}</td>
    <td style="${td}color:#555;font-size:12px;">${split(snapshot[s].byCourier)}</td></tr>`).join('');
  const openTotal = stages.reduce((n, s) => n + snapshot[s].total, 0);
  return `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#222;max-width:620px;">
    <h2 style="margin:0 0 4px;font-size:18px;">Shipments: the last 24 hours</h2>
    <p style="color:#666;margin:0 0 14px;font-size:12px;">${istTime(since)} → ${istTime(until)} IST</p>
    <table style="border-collapse:collapse;width:100%;">${evRows}</table>
    <h3 style="margin:22px 0 4px;font-size:15px;">Where open parcels are now (${openTotal})</h3>
    <p style="color:#666;margin:0 0 8px;font-size:12px;">Booked, not delivered, cancelled or returned; placed in the last ${OPEN_DAYS} days. From the courier's last answer.</p>
    <table style="border-collapse:collapse;width:100%;">${snapRows}</table>
    <p style="margin:18px 0 0;font-size:12px;color:#666;">Every order behind these numbers is in the attached CSV. Waiting parcels: <a href="https://inkandchai.in/admin/#notpicked">Admin → Not Picked Up</a>.</p>
  </div>`;
}

const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function csv(rows) {
  const head = ['Event', 'Time (IST)', 'Order', 'Courier', 'AWB', 'Customer', 'Books', 'Courier says'];
  return '﻿' + [head, ...rows.map((r) => [r.event, istTime(r.at), r.order, r.courier, r.awb, r.customer, r.items, r.courier_status])]
    .map((r) => r.map(csvCell).join(',')).join('\r\n');
}

function subject({ counts, until }) {
  const day = new Date(until).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
  return `🚚 ${day}: ${counts.picked.total} picked up · ${counts.delivered.total} delivered · ${counts.cancelled.total} cancelled · ${counts.booked.total} booked`;
}

module.exports = { courierGroup, stage, summarise, emailHtml, csv, subject, loadEvents, loadOpen, EVENTS, STAGE_ORDER };
