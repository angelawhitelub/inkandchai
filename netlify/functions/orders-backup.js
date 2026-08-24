/**
 * Netlify Function: orders-backup
 * GET  ?format=json|csv&limit=…   — read the order mirror
 * POST { dry_run?: true }         — run the recovery sweep by hand
 * Admin only (X-Admin-Key / X-Admin-Token).
 *
 * The sweep also runs on a schedule inside replay-lost-orders. It lives here
 * as well because Netlify refuses direct HTTP invocation of a scheduled
 * function — it answers 403 before the handler is ever reached — so a
 * scheduled function cannot also be the manual trigger.
 *
 * The mirror is a copy of every order, written to Netlify Blobs at checkout,
 * in a service with no dependency on Supabase. It exists so that a repeat of
 * 24 Aug — the project unreachable for eight hours, twelve paid orders with no
 * row anywhere — is recoverable from our own systems instead of from the
 * payment gateway's dashboards and a customer complaint.
 *
 * This endpoint is the human view of it: check that the backup is really being
 * written, and pull a CSV of everything if the database is unavailable.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { MIRROR_STORE_NAME, replayLostOrders, reconcileMirror, countLostOrders } = require('./utils/order-fallback');
const { reconcileFromNeon, isEnabled: neonEnabled } = require('./utils/neon-mirror');
const { getStore, connectLambda } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
};

const json = (statusCode, obj) => ({
  statusCode, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj),
});

const csvCell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;

function itemsSummary(items) {
  if (!Array.isArray(items) || !items.length) return '';
  return items.map(i => `${i.qty || 1}× ${i.title || i.slug || '?'}`).join(' | ');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  const _adminBlock = requireAdmin(event, { ...CORS, 'Content-Type': 'application/json' });
  if (_adminBlock) return _adminBlock;

  // ── POST: run the recovery sweep now ───────────────────────────────────
  if (event.httpMethod === 'POST') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch {}
    const dryRun = !!body.dry_run;

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return json(500, { error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY are required.' });
    }
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const pending = await countLostOrders(event);
    const replayed = dryRun ? null : await replayLostOrders(event, supabase, { limit: 100 });
    const mirror = await reconcileMirror(event, supabase, { dryRun });
    const neon = await reconcileFromNeon(supabase, { dryRun });

    return json(200, {
      success: true, dry_run: dryRun,
      pending_in_pen: pending, replayed, mirror,
      neon, neon_enabled: neonEnabled(),
    });
  }

  const qs = event.queryStringParameters || {};
  const format = String(qs.format || 'json').toLowerCase();
  const limit = Math.min(Math.max(Number(qs.limit) || 1000, 1), 5000);

  let store;
  try {
    connectLambda(event);
    store = getStore({ name: MIRROR_STORE_NAME });
  } catch (err) {
    return json(500, { error: `blob store unavailable: ${err.message}` });
  }

  let listing;
  try { listing = await store.list(); }
  catch (err) { return json(500, { error: `list failed: ${err.message}` }); }

  const entries = [];
  for (const b of (listing?.blobs || []).slice(0, limit)) {
    const entry = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (!entry) continue;
    entries.push(entry);
  }
  entries.sort((a, b) => String(b.mirrored_at || '').localeCompare(String(a.mirrored_at || '')));

  if (format === 'csv') {
    const head = ['Order ID', 'Mirrored At', 'Source', 'Status', 'Amount', 'Customer', 'Phone', 'Email', 'Address', 'Items', 'Deleted At'];
    const lines = [head.map(csvCell).join(',')];
    for (const e of entries) {
      const r = e.row || {};
      lines.push([
        r.razorpay_order_id, e.mirrored_at, e.source, r.status,
        r.amount_paise == null ? '' : (r.amount_paise / 100).toFixed(2),
        r.customer_name, r.customer_phone, r.customer_email, r.customer_address,
        itemsSummary(r.cart_items), e.deleted_at || '',
      ].map(csvCell).join(','));
    }
    return {
      statusCode: 200,
      headers: {
        ...CORS,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="orders-backup-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
      body: lines.join('\n') + '\n',
    };
  }

  return json(200, {
    success: true,
    store: MIRROR_STORE_NAME,
    total: entries.length,
    live: entries.filter(e => !e.deleted_at).length,
    tombstoned: entries.filter(e => e.deleted_at).length,
    newest: entries[0]?.mirrored_at || null,
    orders: entries.map(e => ({
      order_id: e.row?.razorpay_order_id,
      mirrored_at: e.mirrored_at,
      source: e.source,
      status: e.row?.status,
      amount_paise: e.row?.amount_paise,
      customer_name: e.row?.customer_name,
      customer_phone: e.row?.customer_phone,
      customer_email: e.row?.customer_email,
      has_address: !!e.row?.customer_address,
      items: Array.isArray(e.row?.cart_items) ? e.row.cart_items.length : 0,
      deleted_at: e.deleted_at || null,
    })),
  });
};
