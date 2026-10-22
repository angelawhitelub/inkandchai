const { createHmac } = require('crypto');
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Pending online payments are not purchases. Partial COD is included only after
// its deposit is verified (verify-payment writes partial_cod_pending).
const STATUSES = ['paid', 'confirmed', 'cod_pending', 'partial_cod_pending', 'partial_cod', 'shipped', 'out_for_delivery', 'delivered'];
function slugOf(item) {
  const slug = String(item?.slug || '').toLowerCase() ||
    (String(item?.url || item?.id || '').match(/\/product\/([a-z0-9-]+)(?:[/?#]|$)/i)?.[1] || '').toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,199}$/.test(slug) ? slug : '';
}
function eligible(order, now) {
  const time = Date.parse(order.created_at);
  return Boolean(order.id) && STATUSES.includes(order.status) && Number(order.amount_paise) > 0 &&
    !/paperbound|replacement/i.test(order.source || '') && !/^IC-R-/i.test(order.id) &&
    Number.isFinite(time) && time <= now && now - time <= MAX_AGE_MS &&
    Array.isArray(order.cart_items) && !order.cart_items.some(i => i?._replacement);
}
function firstName(name) {
  const words = String(name || '').trim().split(/\s+/);
  if (/^(mr|mrs|ms|dr)\.?$/i.test(words[0])) words.shift();
  const first = words[0] || '';
  return /^[\p{L}\p{M}][\p{L}\p{M}'’-]{0,29}$/u.test(first) ? first : 'A reader';
}
function safeImage(value) {
  const s = String(value || '');
  return /^https:\/\//i.test(s) || /^\/(?!\/)/.test(s) ? s : '';
}
function project(orders, products, gone, now, secret) {
  if (!secret) return [];
  const seen = new Set();
  return orders.filter(o => eligible(o, now)).sort((a,b) => Date.parse(b.created_at)-Date.parse(a.created_at)).flatMap(order => {
    if (seen.has(order.id)) return [];
    seen.add(order.id);
    // One exact product per purchase. Never substitute another edition or book.
    for (const item of order.cart_items) {
      const slug = slugOf(item), product = products.get(slug);
      if (!product || gone.has(slug) || !product.title || !safeImage(product.img)) continue;
      return [{
        event_id: createHmac('sha256', secret).update(`recent-purchase:${order.id}`).digest('hex').slice(0,24),
        first_name: firstName(order.customer_name),
        ordered_at: new Date(order.created_at).toISOString(),
        title: String(product.title).slice(0,200), img: safeImage(product.img), url: `/product/${slug}/`,
      }];
    }
    return [];
  }).slice(0,20);
}
module.exports = { MAX_AGE_MS, STATUSES, slugOf, eligible, firstName, safeImage, project };
