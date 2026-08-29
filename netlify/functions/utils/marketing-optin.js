/**
 * Record WhatsApp marketing consent captured at checkout.
 *
 * The scheduled broadcast sends to `whatsapp_marketing_subscribers` and nothing
 * else, so this is the only way that list ever grows. Placing an order is NOT
 * consent -- the customer has to tick the box -- which is why the checkbox is
 * unticked by default and why an absent flag is treated as "no", never as
 * "assume yes".
 *
 * This is a side effect of ordering, not part of it. Every failure is swallowed:
 * losing a marketing opt-in is a rounding error, failing a paid order over one
 * is not.
 */
const { phoneKey } = require('./bot-optout');

async function recordMarketingOptIn(supabase, phone, source) {
  try {
    // Only an explicit tick counts. Anything else -- absent, null, 'false' --
    // leaves the customer off the list.
    if (!supabase || !phone) return false;
    const key = phoneKey(phone);
    if (!key) return false;

    // Upsert rather than insert: a repeat customer re-ticking the box should
    // re-subscribe them if they had opted out, and must not error on the
    // customer_phone primary key.
    const { error } = await supabase
      .from('whatsapp_marketing_subscribers')
      .upsert({
        customer_phone: key,
        status: 'subscribed',
        consent_source: String(source || 'checkout').slice(0, 120),
        consent_recorded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'customer_phone' });

    if (error) {
      console.warn('[marketing-optin] could not record consent:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[marketing-optin] could not record consent:', err && err.message);
    return false;
  }
}

module.exports = { recordMarketingOptIn };
