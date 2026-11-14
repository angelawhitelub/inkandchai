/**
 * What a customer types as their order ID, read forgivingly (owner, 14 Nov 2026:
 * "customers usually keep getting difficulty").
 *
 * Order ids stay as they are -- IC-20261109-AB3CD -- because couriers, Razorpay,
 * Google Ads and the panels all key on them. The last five characters are the
 * customer's SHORT ORDER CODE: "AB3CD" with the phone or email from the order
 * is enough everywhere a customer types an order id (Track, Support, Link
 * order, Write a review). Also read:
 *   ic-20261109-ab3cd · IC20261109AB3CD · 20261109-AB3CD · 20261109AB3CD
 *   #AB3CD · "IC- 20261109 - AB3CD"
 * The date alone ("20261109", what many customers type) is not an order id;
 * it gets DATE_HINT instead of a bare "not found".
 *
 * A short code only ever resolves to an order the given email/phone owns, so
 * an order id alone still never confirms that an order exists.
 */

const DATE_HINT = 'That looks like the order date. Your order ID has 5 more letters/numbers after the date '
  + '(IC-20261109-AB3CD) — you can type just those 5, e.g. AB3CD. They are in your order confirmation email, '
  + 'SMS or WhatsApp.';

/** @returns {{kind:'empty'}|{kind:'exact',id:string}|{kind:'datecode',date:string,code:string}|{kind:'code',code:string}|{kind:'date',date:string}} */
function parseOrderRef(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, '').replace(/^#+/, '').slice(0, 64);
  if (!s) return { kind: 'empty' };
  // Razorpay ids are case-sensitive (order_SsW3Rzrk7HkHdT): keep them exactly.
  if (/^(order|pay)_/i.test(s)) return { kind: 'exact', id: s };
  const u = s.toUpperCase().replace(/[‐-―_./]/g, '-').replace(/-+/g, '-');
  let m = u.match(/^(?:IC-?)?(\d{8})-?([A-Z0-9]{5})$/);
  if (m) return { kind: 'datecode', date: m[1], code: m[2] };
  if (/^\d{8}$/.test(u)) return { kind: 'date', date: u };
  m = u.match(/^(?:IC-?)?([A-Z0-9]{5})$/);
  if (m) return { kind: 'code', code: m[1] };
  return { kind: 'exact', id: u.startsWith('IC-') || u.startsWith('PB-') ? u : s };
}

/** The 5-character code of a full order id, '' when it has none. */
function shortCode(orderId) {
  const m = String(orderId || '').toUpperCase().match(/\d{8}-([A-Z0-9]{5})(?:-[A-Z]\d{1,2})?$/);
  return m ? m[1] : '';
}

/**
 * Find the order a customer means.
 * @param db       supabase client
 * @param raw      what they typed
 * @param owns     (order) => boolean, the caller's email/phone check
 * @returns {Promise<{order?:object, owned?:boolean, hint?:string, error?:object}>}
 *   exact ids: { order, owned } like before (the caller words a mismatch);
 *   codes:     { order, owned:true } only for an order the contact owns, else {};
 *   the date alone: { hint: DATE_HINT }.
 */
async function findOrderByRef(db, raw, owns, { select = '*' } = {}) {
  const ref = parseOrderRef(raw);
  if (ref.kind === 'empty') return {};
  if (ref.kind === 'date') return { hint: DATE_HINT };

  if (ref.kind === 'exact') {
    let r = await db.from('orders').select(select).eq('razorpay_order_id', ref.id).limit(1).maybeSingle();
    if (r.error) return { error: r.error };
    if (!r.data) {
      r = await db.from('orders').select(select).ilike('razorpay_order_id', ref.id).limit(1).maybeSingle();
      if (r.error) return { error: r.error };
    }
    return r.data ? { order: r.data, owned: !!owns(r.data) } : {};
  }

  // datecode: any prefix (IC-, IC-W-, IC-R-, IC-CW-…) with this date and code.
  // code: any date. "_" is ilike's one-character wildcard, so the 8 underscores
  // are the date and a split child (…-S2) never matches.
  const pattern = ref.kind === 'datecode' ? `%${ref.date}-${ref.code}` : `%-________-${ref.code}`;
  const r = await db.from('orders').select(select).ilike('razorpay_order_id', pattern)
    .order('created_at', { ascending: false }).limit(20);
  if (r.error) return { error: r.error };
  const mine = (r.data || []).filter((o) => owns(o));
  return mine.length ? { order: mine[0], owned: true } : {};
}

/** One line for customer emails, under the Order ID; '' for ids without a code. */
function shortCodeHtml(orderId) {
  const c = shortCode(orderId);
  return c
    ? `<p style="margin:4px 0 0;color:#a09080;font-size:12px;">Short code: <strong style="color:#f0e8d8;letter-spacing:.08em;">${c}</strong> — this and your phone number are all you need to track the order.</p>`
    : '';
}

module.exports = { parseOrderRef, findOrderByRef, shortCode, shortCodeHtml, DATE_HINT };
