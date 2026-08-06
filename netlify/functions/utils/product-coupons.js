function normalizeCouponCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);
}

function itemSlug(item) {
  if (item && item.slug) return String(item.slug).trim();
  const raw = String(item?.url || item?.id || '');
  const match = raw.match(/\/product\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]).trim() : raw.replace(/^\/+|\/+$/g, '');
}

function eligibleSubtotal(cart, productSlugs) {
  const allowed = new Set((productSlugs || []).map(String));
  return (Array.isArray(cart) ? cart : []).reduce((sum, item) => {
    if (!allowed.has(itemSlug(item))) return sum;
    return sum + (Number(item.price) || 0) * Math.max(1, Number(item.qty) || 1);
  }, 0);
}

function discountForProductCoupon(rule, cart, now = new Date()) {
  if (!rule || rule.is_active === false) return { code: '', discount: 0, reason: 'not_found' };
  const code = normalizeCouponCode(rule.code);
  const current = now instanceof Date ? now : new Date(now);
  if (rule.starts_at && current < new Date(rule.starts_at)) return { code: '', discount: 0, reason: 'not_started' };
  if (rule.expires_at && current > new Date(rule.expires_at)) return { code: '', discount: 0, reason: 'expired' };
  const eligible = eligibleSubtotal(cart, rule.product_slugs);
  const minimum = Math.max(0, Number(rule.min_subtotal_inr) || 0);
  if (eligible <= 0) return { code: '', discount: 0, reason: 'product_not_eligible', eligibleSubtotal: 0 };
  if (eligible < minimum) return { code: '', discount: 0, reason: 'min_subtotal', eligibleSubtotal: eligible };
  const value = Math.max(0, Number(rule.discount_value) || 0);
  const rawDiscount = rule.discount_type === 'percent'
    ? Math.floor(eligible * value / 100)
    : Math.floor(value);
  return {
    code,
    discount: Math.min(Math.floor(eligible), Math.max(0, rawDiscount)),
    source: 'product',
    label: String(rule.label || ''),
    eligibleSubtotal: eligible,
  };
}

async function findProductCoupon(supabase, rawCode) {
  const code = normalizeCouponCode(rawCode);
  if (!code) return null;
  const { data, error } = await supabase
    .from('product_coupons')
    .select('*')
    .eq('code', code)
    .maybeSingle();
  if (error) {
    // Missing migration must not break checkout or existing coupons.
    if (error.code === '42P01' || /product_coupons/i.test(error.message || '')) return null;
    throw error;
  }
  return data || null;
}

async function resolveProductCoupon(supabase, cart, rawCode) {
  const rule = await findProductCoupon(supabase, rawCode);
  return discountForProductCoupon(rule, cart);
}

function publicCoupon(rule) {
  return {
    code: normalizeCouponCode(rule.code),
    label: String(rule.label || ''),
    discount_type: rule.discount_type,
    discount_value: Number(rule.discount_value) || 0,
    min_subtotal_inr: Number(rule.min_subtotal_inr) || 0,
    product_slugs: Array.isArray(rule.product_slugs) ? rule.product_slugs : [],
    online_only: rule.online_only !== false,
    starts_at: rule.starts_at || null,
    expires_at: rule.expires_at || null,
  };
}

module.exports = {
  normalizeCouponCode,
  itemSlug,
  eligibleSubtotal,
  discountForProductCoupon,
  findProductCoupon,
  resolveProductCoupon,
  publicCoupon,
};
