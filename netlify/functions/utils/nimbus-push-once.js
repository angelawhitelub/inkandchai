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

  // Claim. `.is('nimbus_pushed_at', null)` is what makes this exclusive.
  let claimed;
  try {
    const { data, error } = await supabase
      .from('orders')
      .update({ nimbus_pushed_at: new Date().toISOString() })
      .eq(col, key)
      .is('nimbus_pushed_at', null)
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

module.exports = { pushToNimbusOnce };
