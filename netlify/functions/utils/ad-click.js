/**
 * Whether an order came from a Google Ads click, as the checkout saw it.
 *
 * WHY
 * ---
 * Checkout fires a purchase conversion on every order, but Google only records
 * one when it can tie the order to an ad click. Orders from organic search,
 * WhatsApp, Instagram or direct visits never become conversions at all. The
 * daily retraction feed (google-ads-adjustments.js) could not tell the two
 * apart, so it asked Google to retract ~1,360 conversions a day that never
 * existed -- and Google flags an account whose uploads are half errors
 * ("Offline conversion data issues are affecting performance").
 *
 * Checkout now reports what it saw (public/js/ad-click.js): the gclid / gbraid
 * / wbraid from the landing URL or the Google tag's _gcl_* cookies, or 'none'.
 * The feed skips orders marked 'none'.
 *
 * VALUES in orders.ad_click
 *   null           not recorded (orders placed before this existed, WhatsApp
 *                  and admin orders, or the script did not load) -- treated as
 *                  "might be a conversion", so still retracted. Unknown is
 *                  never taken as "no".
 *   'none'         checkout looked and there was no Google click
 *   'gclid:<id>'   / 'gbraid:<id>' / 'wbraid:<id>'
 */

const CLICK = /^(gclid|gbraid|wbraid):[A-Za-z0-9_.\-]{8,200}$/;

/** The value to store, or null for anything malformed (which stays "unknown"). */
function cleanAdClick(value) {
  const v = String(value == null ? '' : value).trim();
  if (v === 'none') return 'none';
  return CLICK.test(v) ? v : null;
}

/**
 * Record it on the order. Deliberately a separate UPDATE after the insert, not
 * a column on the insert: a failed order insert is stashed as a lost order, and
 * this must never be able to cause that -- not even before the column exists.
 */
async function recordAdClick(supabase, orderId, value) {
  const adClick = cleanAdClick(value);
  if (!adClick || !orderId) return;
  try {
    const { error } = await supabase.from('orders').update({ ad_click: adClick }).eq('razorpay_order_id', orderId);
    if (error) console.warn('[ad-click] not recorded:', error.message);
  } catch (e) {
    console.warn('[ad-click] not recorded:', e.message);
  }
}

module.exports = { cleanAdClick, recordAdClick };
