/**
 * Push an order to the NimbusPost panel exactly once, whichever path gets
 * there first.
 *
 * WHY
 * ---
 * A prepaid order can be confirmed by two independent events — the customer's
 * browser returning from the gateway, and the gateway's webhook — and neither
 * is guaranteed to happen. PhonePe made that painfully clear: its only push
 * trigger was the browser return (phonepe-verify-status), the webhook pushed
 * nothing at all, and the browser return is exactly the step that goes missing
 * when a customer starts in an in-app browser and lands back in their default
 * one. Those orders then sat unpushed until someone noticed and pushed them by
 * hand from the admin panel — a median of about eight hours later, against
 * roughly zero for COD.
 *
 * The obvious fix, pushing from both paths, trades a delay for a duplicate
 * panel order. So the stamp doubles as the lock: `nimbus_pushed_at` is claimed
 * with a conditional update, and only the caller that actually flips it from
 * NULL performs the push. Postgres settles the race, so the two paths can
 * fire simultaneously and still produce one shipment.
 *
 * A failed push releases the claim, so the order goes back to looking
 * un-pushed and the next trigger — the other path, or a manual bulk push —
 * retries it. That is the safe direction to fail in: a second attempt at worst
 * creates a duplicate NimbusPost rejects, while a stuck claim would silently
 * strand a paid order forever.
 */

const { pushOrderToNimbusPost } = require('./nimbuspost-import');
const { ensureOrderAddress } = require('./address-fixer');

/**
 * Automatic panel pushes are OFF unless NIMBUS_AUTO_PUSH is "on" (26 Sep 2026:
 * the owner wants every NimbusPost order to be a deliberate, manual push).
 * This gates every automatic path -- checkout, both payment webhooks, the
 * WhatsApp bot, new replacements, and the two sweeps -- and nothing else. The
 * admin's "Push to NimbusPost Panel" buttons call nimbuspost-order-push
 * directly and are unaffected. Turn it back on with
 *   npx wrangler secret put NIMBUS_AUTO_PUSH --name inkandchai   (value: on)
 */
function nimbusAutoPushOn() {
  return ['on', 'true', '1', 'yes'].includes(String(process.env.NIMBUS_AUTO_PUSH || '').trim().toLowerCase());
}

/**
 * Why an order must not go to NimbusPost because another courier has it, or
 * null. tracking_id: an AWB from any courier. ithink_pushed_at: created in the
 * iThink panel, whose AWB only arrives later by import. xpressbees_feed_at: the
 * owner pressed "Push to XpressBees" for it.
 */
function bookedElsewhere(order) {
  if (!order) return null;
  if (String(order.tracking_id || '').trim()) return `already has AWB ${String(order.tracking_id).trim()}`;
  if (order.ithink_pushed_at) return 'already pushed to iThink';
  if (order.xpressbees_feed_at) return 'already queued for XpressBees';
  return null;
}

/**
 * @param {object} supabase  service-role client
 * @param {object} order     order row; needs `id` or `razorpay_order_id`
 * @returns {Promise<{pushed: boolean, reason?: string, error?: string}>}
 *   Never throws — every caller treats the push as non-fatal.
 */
async function pushToNimbusOnce(supabase, order) {
  const col = order?.id ? 'id' : 'razorpay_order_id';
  const key = order?.id || order?.razorpay_order_id;
  const label = order?.razorpay_order_id || key;
  if (!key) return { pushed: false, reason: 'no_order_key' };
  // Before the claim, so the order stays un-pushed and a manual push sees it.
  if (!nimbusAutoPushOn()) return { pushed: false, reason: 'auto_push_off' };

  // Already with another courier. IC-20260914-9VP7A shipped three times: it
  // was booked in iThink (ithink_pushed_at) but its AWB never came back into
  // tracking_id, so this looked un-pushed and a sweep sent it to NimbusPost
  // too. Reported as already_pushed -- callers treat that as "handled".
  const elsewhere = bookedElsewhere(order);
  if (elsewhere) {
    console.log(`[NimbusPost] not pushing ${label}: ${elsewhere}`);
    return { pushed: false, reason: 'already_pushed', detail: elsewhere };
  }

  try { await ensureOrderAddress(supabase, order); }
  catch (error) { return { pushed: false, reason: 'address_review', error: error.message }; }

  // Claim. `.is('nimbus_pushed_at', null)` is what makes this exclusive; the
  // other three repeat bookedElsewhere against the row as it is NOW, since the
  // caller's copy of the order may be minutes old.
  let claimed;
  try {
    const { data, error } = await supabase
      .from('orders')
      .update({ nimbus_pushed_at: new Date().toISOString() })
      .eq(col, key)
      .is('nimbus_pushed_at', null)
      .is('tracking_id', null)
      .is('ithink_pushed_at', null)
      .is('xpressbees_feed_at', null)
      .select('id');
    if (error) throw error;
    claimed = data;
  } catch (e) {
    console.error(`[NimbusPost] claim failed for ${label} (non-fatal):`, e.message);
    return { pushed: false, reason: 'claim_failed', error: e.message };
  }

  if (!claimed?.length) return { pushed: false, reason: 'already_pushed' };

  try {
    await pushOrderToNimbusPost(order);
    console.log(`[NimbusPost] auto-pushed ${label}`);
    return { pushed: true };
  } catch (e) {
    // Release the claim so the next trigger can retry.
    await supabase
      .from('orders')
      .update({ nimbus_pushed_at: null })
      .eq(col, key)
      .catch(() => {});
    console.error(`[NimbusPost] auto-push failed for ${label} (non-fatal, claim released):`, e.message);
    return { pushed: false, reason: 'push_failed', error: e.message };
  }
}

module.exports = { pushToNimbusOnce, nimbusAutoPushOn, bookedElsewhere };
