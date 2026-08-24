/**
 * Neon Postgres standby for the orders table.
 *
 * The Netlify Blobs mirror (utils/order-fallback.js) already makes an order
 * survive Supabase being unreachable. This adds the thing a blob store cannot
 * do: SQL. When the primary is down you can still answer "what did we sell
 * today", "whose parcel is unshipped", "how much money came in" — from a
 * database, with a query, instead of by reading JSON blobs one at a time.
 *
 * Schema: sql/neon_orders_mirror.sql (run once in the Neon SQL editor).
 *
 * Everything here is best-effort and never throws into a checkout. If
 * NEON_DATABASE_URL is unset the whole module is a no-op, so the site behaves
 * exactly as it did before the standby existed — which is also what makes it
 * safe to deploy before the Neon project is created.
 */

let _neon = null;
let _warned = false;

function client() {
  const url = process.env.NEON_DATABASE_URL || process.env.NEON_POSTGRES_URL;
  if (!url) {
    if (!_warned) {
      console.log('[neon-mirror] NEON_DATABASE_URL not set — standby disabled');
      _warned = true;
    }
    return null;
  }
  if (_neon) return _neon;
  try {
    const { neon } = require('@neondatabase/serverless');
    _neon = neon(url);          // HTTP driver: one round trip, no pool to leak
    return _neon;
  } catch (err) {
    console.error('[neon-mirror] driver unavailable:', err.message);
    return null;
  }
}

const isEnabled = () => !!(process.env.NEON_DATABASE_URL || process.env.NEON_POSTGRES_URL);

/**
 * Write (or refresh) the standby copy of an order.
 * ON CONFLICT DO UPDATE so a retry of the same order updates rather than
 * failing, and so a later status change is reflected — but a tombstoned row is
 * left alone, or an admin deletion would undo itself on the next write.
 */
async function neonMirrorOrder(row, meta = {}) {
  const sql = client();
  if (!sql || !row?.razorpay_order_id) return { mirrored: false };
  try {
    await sql`
      INSERT INTO orders_mirror (
        razorpay_order_id, razorpay_payment_id, amount_paise, status,
        customer_name, customer_email, customer_phone, customer_address,
        cart_items, user_id, order_created_at, source
      ) VALUES (
        ${row.razorpay_order_id}, ${row.razorpay_payment_id ?? null},
        ${row.amount_paise ?? null}, ${row.status ?? null},
        ${row.customer_name ?? null}, ${row.customer_email ?? null},
        ${row.customer_phone ?? null}, ${row.customer_address ?? null},
        ${JSON.stringify(row.cart_items ?? [])}, ${row.user_id ?? null},
        ${row.created_at ?? null}, ${meta.source ?? 'unknown'}
      )
      ON CONFLICT (razorpay_order_id) DO UPDATE SET
        razorpay_payment_id = EXCLUDED.razorpay_payment_id,
        amount_paise        = EXCLUDED.amount_paise,
        status              = EXCLUDED.status,
        customer_name       = EXCLUDED.customer_name,
        customer_email      = EXCLUDED.customer_email,
        customer_phone      = EXCLUDED.customer_phone,
        customer_address    = EXCLUDED.customer_address,
        cart_items          = EXCLUDED.cart_items,
        updated_at          = now()
      WHERE orders_mirror.deleted_at IS NULL
    `;
    return { mirrored: true };
  } catch (err) {
    console.error(`[neon-mirror] write failed for ${row.razorpay_order_id}: ${err.message}`);
    return { mirrored: false, reason: err.message };
  }
}

async function neonTombstoneOrder(orderId, reason = '') {
  const sql = client();
  if (!sql || !orderId) return { tombstoned: false };
  try {
    await sql`
      UPDATE orders_mirror
         SET deleted_at = now(), deleted_reason = ${String(reason).slice(0, 200)}
       WHERE razorpay_order_id = ${orderId}
    `;
    return { tombstoned: true };
  } catch (err) {
    console.error(`[neon-mirror] tombstone failed for ${orderId}: ${err.message}`);
    return { tombstoned: false, reason: err.message };
  }
}

/** Recent, non-deleted standby rows — the candidates for a reconcile. */
async function neonRecentOrders({ days = 14, limit = 500 } = {}) {
  const sql = client();
  if (!sql) return null;
  try {
    return await sql`
      SELECT razorpay_order_id, razorpay_payment_id, amount_paise, status,
             customer_name, customer_email, customer_phone, customer_address,
             cart_items, user_id, order_created_at
        FROM orders_mirror
       WHERE deleted_at IS NULL
         AND mirrored_at > now() - make_interval(days => ${days})
       ORDER BY mirrored_at DESC
       LIMIT ${limit}
    `;
  } catch (err) {
    console.error('[neon-mirror] read failed:', err.message);
    return null;
  }
}

/** Shape a standby row back into something the orders table will accept. */
function toOrderRow(r) {
  const row = {
    razorpay_order_id:   r.razorpay_order_id,
    razorpay_payment_id: r.razorpay_payment_id,
    amount_paise:        r.amount_paise === null ? null : Number(r.amount_paise),
    status:              r.status,
    customer_name:       r.customer_name,
    customer_email:      r.customer_email,
    customer_phone:      r.customer_phone,
    customer_address:    r.customer_address,
    cart_items:          r.cart_items ?? [],
    user_id:             r.user_id,
  };
  if (r.order_created_at) row.created_at = new Date(r.order_created_at).toISOString();
  return row;
}

/**
 * Put back any order the standby has and the primary does not. Runs after the
 * blob reconcile, so in practice it only finds things the blob store missed —
 * but it is the copy that survives if Netlify Blobs is the service having the
 * bad day, and the two are checked independently on purpose.
 */
async function reconcileFromNeon(supabase, { days = 14, limit = 500, dryRun = false } = {}) {
  const out = { enabled: isEnabled(), checked: 0, present: 0, restored: 0, failed: 0, missing: [], errors: [] };
  if (!out.enabled || !supabase) return out;

  const rows = await neonRecentOrders({ days, limit });
  if (!rows) { out.errors.push('standby unreadable'); return out; }

  for (const r of rows) {
    const orderId = r.razorpay_order_id;
    if (!orderId) continue;
    out.checked++;

    const { data: existing, error } = await supabase
      .from('orders').select('id').eq('razorpay_order_id', orderId).maybeSingle();
    if (error) { out.failed++; out.errors.push(`${orderId}: lookup ${error.message}`); continue; }
    if (existing) { out.present++; continue; }

    out.missing.push(orderId);
    if (dryRun) continue;

    const { error: insErr } = await supabase.from('orders').insert(toOrderRow(r));
    if (insErr && insErr.code !== '23505') {
      out.failed++;
      out.errors.push(`${orderId}: insert ${insErr.message}`);
      continue;
    }
    out.restored++;
    console.error(`[neon-mirror] RESTORED ${orderId} from the Neon standby`);
  }
  return out;
}

module.exports = {
  isEnabled, neonMirrorOrder, neonTombstoneOrder, neonRecentOrders,
  reconcileFromNeon, toOrderRow,
};
