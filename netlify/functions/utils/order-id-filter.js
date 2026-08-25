'use strict';

// Look an order up by either its display id (IC-20260812-5OZV8) or its uuid
// primary key.
//
// `orders.id` is a uuid column, so a filter like `id.eq.IC-20260812-5OZV8`
// does not simply miss — Postgres rejects the WHOLE query with
//   invalid input syntax for type uuid: "IC-20260812-5OZV8"
// which, in an `.or()`, takes the razorpay_order_id half down with it. Only
// include the `id` clause when the value really is a uuid.
//
// The value is also sanitized to [A-Za-z0-9-] before it reaches the filter
// string: a comma or a dot would otherwise be read as PostgREST filter syntax.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitizeOrderId(raw) {
  return String(raw == null ? '' : raw).trim().replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
}

// Returns a PostgREST `.or()` filter string, or '' when there is nothing usable.
function orderIdFilter(raw) {
  const id = sanitizeOrderId(raw);
  if (!id) return '';
  return UUID_RE.test(id)
    ? `razorpay_order_id.eq.${id},id.eq.${id}`
    : `razorpay_order_id.eq.${id}`;
}

module.exports = { sanitizeOrderId, orderIdFilter, UUID_RE };
