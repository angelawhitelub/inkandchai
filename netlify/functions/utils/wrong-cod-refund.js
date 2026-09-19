/**
 * The wrong-COD double payment — the gate, the copy, and the refund.
 *
 * WHAT HAPPENED (19 Sep 2026). XpressBees' WooCommerce channel importer matches
 * the channel's "Prepaid Payment Titles" box CASE-SENSITIVELY against a value it
 * has already lowercased. Our feed sent the title `Prepaid`; the box held
 * `Prepaid`; nothing matched, and an unmatched payment title falls through to
 * the importer's default, which is COD. So orders the customer had already paid
 * for online went out of the door with a collectable amount printed on them, and
 * the delivery agent asked for the money a second time.
 *
 * The importer is fixed (the box now holds `Prepaid,prepaid,PREPAID`), but the
 * parcels already in the courier network still carry the wrong label.
 *
 * WHY A MARKER COLUMN AND NOT A RULE. Nothing in our own rows distinguishes an
 * affected order: `shipment_payment_type` reads the same on the 48 affected
 * orders as on the 154 unaffected XpressBees shipments beside them, because the
 * mistake was made inside XpressBees' importer and never written back to us. A
 * heuristic here would be guessing with real money, so `orders.wrong_cod_paise`
 * is set explicitly from the reconciled list and is the ONLY thing that makes an
 * order eligible. An order without it is not affected, whatever a customer says.
 *
 * WHY `delivered` IS THE GATE. The customer only loses money if they actually
 * hand over the cash, and they only hand over the cash at the doorstep. Before
 * delivery there is nothing to refund: refusing the parcel costs them nothing,
 * and it is the refusals that turn into RTOs. So an undelivered order gets the
 * reassurance, never the money.
 *
 * `delivered` is a proxy, not proof — it says the parcel arrived, not that cash
 * changed hands. A courier can mark a parcel delivered after waiving the COD, in
 * which case we would refund money that was never taken twice. The airtight
 * proof is XpressBees' COD remittance, which lags delivery by a week or more.
 * The trade is deliberate and belongs to the owner, not to this file: refunding
 * a customer who already paid twice within minutes of them asking is worth more
 * than the few rupees at risk from a waived COD. `remittanceKnown` below lets a
 * later remittance import tighten this without touching the bot.
 */

const REFUND_BLOCKING_STATUSES = ['refunded', 'partially_refunded', 'refund_pending', 'refund_failed'];

/** Is the bot allowed to issue these refunds at all? Default on; set to 0/off to stop it. */
function refundsEnabled(raw = process.env.BOT_WRONG_COD_REFUND) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return true;
  return !/^(0|off|false|no)$/i.test(text);
}

/** The last ten digits, which is the only part of an Indian mobile we can compare on. */
function ten(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

/**
 * Decide what may happen to this order. Pure: no network, no clock beyond the
 * row. Returns one of:
 *   not-affected   — no marker, so this is not one of ours
 *   not-yours      — the marker is real but the order belongs to another phone
 *   disabled       — refunds switched off by env
 *   already-done   — we have already refunded this one
 *   in-refund       — a refund is mid-flight or the row is in a refund state
 *   not-delivered  — affected, still out; reassure, do not pay
 *   refundable     — affected, delivered, untouched; pay them
 */
function assess(order, { phone = null, enabled = refundsEnabled(), remittanceKnown = null } = {}) {
  const amountPaise = Number(order?.wrong_cod_paise || 0);
  if (!order || !amountPaise || amountPaise <= 0) return { verdict: 'not-affected', amountPaise: 0 };

  if (phone != null && ten(order.customer_phone) !== ten(phone)) {
    return { verdict: 'not-yours', amountPaise };
  }
  if (order.wrong_cod_refund_at) {
    return { verdict: 'already-done', amountPaise, at: order.wrong_cod_refund_at, ref: order.wrong_cod_refund_ref || null };
  }
  if (REFUND_BLOCKING_STATUSES.includes(String(order.status || '').toLowerCase())) {
    return { verdict: 'in-refund', amountPaise };
  }
  if (String(order.status || '').toLowerCase() !== 'delivered') {
    return { verdict: 'not-delivered', amountPaise, status: String(order.status || '').toLowerCase() };
  }
  // A remittance import, when one exists, can veto a delivery the courier never
  // actually collected on. Until then it passes null and changes nothing.
  if (remittanceKnown === false) return { verdict: 'not-collected', amountPaise };
  if (!enabled) return { verdict: 'disabled', amountPaise };
  return { verdict: 'refundable', amountPaise };
}

/**
 * What the model is told about this order. Instructions, not prose to recite —
 * the bot writes its own words in the customer's own language, but the branch it
 * takes is decided here and not by the model.
 */
function botContext(order, opts = {}) {
  const a = assess(order, opts);
  if (a.verdict === 'not-affected' || a.verdict === 'not-yours') return '';
  const rupees = (a.amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const id = order.razorpay_order_id || order.id;
  const head = `\nWRONG COD ON THIS ORDER — ₹${rupees} was wrongly printed as Cash on Delivery on order ${id}, `
    + `which the customer had ALREADY paid online. This is our mistake, it is confirmed in our records, and it is not in doubt. `
    + `Never suggest the customer is mistaken or ask them to prove they paid.`;

  if (a.verdict === 'refundable') {
    return head + `\nThis order is DELIVERED, so they paid a second time in cash. Apologise plainly, tell them the ₹${rupees} `
      + `is being returned to the payment method they originally paid with, and call the refund_wrong_cod tool NOW. `
      + `Do not ask for a UPI id and do not send them to email or to the support number — you can do this yourself, here.`;
  }
  if (a.verdict === 'already-done') {
    const when = a.at ? new Date(a.at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '';
    return head + `\nThe ₹${rupees} has ALREADY been refunded${when ? ` on ${when}` : ''} to their original payment method`
      + `${a.ref ? ` (reference ${a.ref})` : ''} — it reflects in 2–3 business days. Tell them that, with the reference exactly as written. `
      + `Do NOT call refund_wrong_cod again.`;
  }
  if (a.verdict === 'in-refund') {
    return head + `\nA refund on this order is already in progress at the payment gateway. Tell them it is on its way and needs nothing from them. `
      + `Do NOT call refund_wrong_cod.`;
  }
  // not-delivered / not-collected / disabled all get the same customer-facing answer.
  const upiLine = order.wrong_cod_upi
    ? `\nThey have ALREADY given us a UPI id (${order.wrong_cod_upi}) for this and our team has it. Do NOT ask for it again — tell them it is with the team and the ₹${rupees} is being sent to that UPI id.`
    : `\nIF THEY STILL WILL NOT PAY TWICE — and many people will not, because they do not trust a promise from a shop that has just made a mistake — do NOT argue and do NOT keep repeating the promise. Offer the other way round instead: we send them the ₹${rupees} FIRST, by UPI, and they use it to pay the delivery agent. Ask for their UPI id (like 9876543210@ybl) and call the record_wrong_cod_upi tool with exactly what they type. Never ask for a bank account number, IFSC, card number, OTP or CVV — a UPI id is all we need and all we may ask for.`;
  return head + `\nThe parcel is NOT delivered yet (status: ${a.status || 'in transit'}), so they have not paid twice yet and there is nothing to refund at this moment. `
    + `Tell them clearly: please DO accept the parcel and pay the ₹${rupees} the delivery agent asks for, and the moment it is delivered `
    + `we refund that ₹${rupees} straight back to the payment method they originally paid with — they do not need to do anything, ask anyone, or share any bank details. `
    + `Say why it matters: if they refuse the parcel it travels back to us, they wait weeks for the book, and it helps nobody. `
    + `Be warm and take the blame. Do NOT call refund_wrong_cod for this order — it will refuse anyway.`
    + upiLine;
}

/**
 * Where a customer-supplied UPI id has to land. This is a manual payout: the
 * bot never sends money to a UPI id, it only collects one and hands it to a
 * human. That is deliberate — a pre-delivery payout is money out of the door
 * before anything has been collected, and a customer could take it and still
 * refuse the parcel. A person should look at each one.
 */
function ownerUpiEmail({ order, amountPaise, upi }) {
  const id = order.razorpay_order_id || order.id || '';
  const rupees = (Number(amountPaise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const subject = `UPI payout needed — ₹${rupees} to ${upi} (${id})`;
  const text = [
    `PAY ₹${rupees} TO ${upi}`,
    '',
    `Order:    ${id}`,
    `Customer: ${order.customer_name || '—'} (${order.customer_phone || '—'})`,
    `Status:   ${order.status || '—'}`,
    `AWB:      ${order.tracking_id || '—'}`,
    '',
    'Why: this parcel went out wrongly labelled Cash on Delivery on an order the',
    'customer had already paid for online. They will not pay a second time and',
    'wait for a refund, so we send the money first and they pay the agent with it.',
    '',
    'TIME MATTERS — the parcel is out for delivery. If this is paid after the',
    'agent has already come and gone, the customer refuses it, it becomes an RTO,',
    'and we are out the book as well as the goodwill.',
    '',
    'The bot told the customer this is being sent. Nothing has been paid yet.',
  ].join('\n');
  const html = `<div style="font-family:Georgia,serif;color:#3a2f25;max-width:560px;margin:0 auto;padding:24px;background:#faf7f2;">
    <h2 style="font-weight:400;color:#8a6a1f;margin:0 0 4px;">Pay ₹${esc(rupees)} by UPI</h2>
    <p style="font-family:Menlo,Consolas,monospace;font-size:19px;color:#3a2f25;margin:6px 0 18px;"><strong>${esc(upi)}</strong></p>
    <table style="border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:3px 14px 3px 0;color:#7a6a58;">Order</td><td><strong>${esc(id)}</strong></td></tr>
      <tr><td style="padding:3px 14px 3px 0;color:#7a6a58;">Customer</td><td>${esc(order.customer_name || '—')} (${esc(order.customer_phone || '—')})</td></tr>
      <tr><td style="padding:3px 14px 3px 0;color:#7a6a58;">Status</td><td>${esc(order.status || '—')}</td></tr>
      <tr><td style="padding:3px 14px 3px 0;color:#7a6a58;">AWB</td><td>${esc(order.tracking_id || '—')}</td></tr>
    </table>
    <p style="line-height:1.7;margin:18px 0;">This parcel went out wrongly labelled Cash on Delivery on an order the customer had
      <strong>already paid online</strong>. They will not pay a second time and wait for a refund, so we send the money first
      and they pay the delivery agent with it.</p>
    <p style="line-height:1.7;margin:18px 0;padding:10px 14px;background:#f2ece1;border-left:3px solid #8a6a1f;">
      <strong>Time matters.</strong> The parcel is out for delivery. Paid after the agent has been and gone, the customer
      refuses it, it becomes an RTO, and we lose the book as well as the goodwill.</p>
    <p style="color:#7a6a58;font-size:12px;">The bot has told the customer this is being sent. Nothing has been paid yet.</p>
  </div>`;
  return { subject, html, text };
}

/**
 * Issue the refund. ONE implementation, shared by the WhatsApp bot and the
 * button on the tracking page, because two code paths that both move money
 * eventually disagree about when they may — and the disagreement is only ever
 * found by paying someone twice or not at all.
 *
 * Callers must have established WHO is asking. This establishes what may happen.
 *
 * @returns {{ok:boolean, verdict:string, amountPaise:number, ref?:string, error?:string}}
 */
async function performWrongCodRefund({ supabase, order, source = 'unknown', deps = {} }) {
  const {
    issueRazorpayRefund = require('./razorpay-refund').issueRazorpayRefund,
    issuePhonePeRefund = require('./phonepe-refund-core').issuePhonePeRefund,
    notifyOwnerRefund = require('./refund-notifications').notifyOwnerRefund,
  } = deps;

  const verdict = assess(order);
  const displayId = order.razorpay_order_id || order.id;
  if (verdict.verdict !== 'refundable') {
    return { ok: false, verdict: verdict.verdict, amountPaise: verdict.amountPaise, ref: verdict.ref };
  }

  const pid = String(order.razorpay_payment_id || '');
  if (!pid) return { ok: false, verdict: 'no-payment-id', amountPaise: verdict.amountPaise };

  // Claim before spending. The conditional update is the whole concurrency
  // story: two tabs, or a tab and the bot, cannot both win it.
  const claimedAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from('orders')
    .update({ wrong_cod_refund_at: claimedAt })
    .eq('id', order.id)
    .is('wrong_cod_refund_at', null)
    .select('id')
    .maybeSingle();
  if (claimErr) return { ok: false, verdict: 'error', amountPaise: verdict.amountPaise, error: claimErr.message };
  if (!claimed) return { ok: false, verdict: 'already-done', amountPaise: verdict.amountPaise };

  let ref = '';
  try {
    if (pid.startsWith('pay_')) {
      const refund = await issueRazorpayRefund(pid, verdict.amountPaise, {
        notes: { reason: 'Wrong COD collected on a prepaid order', order_id: displayId, source },
        supabase,
      });
      ref = refund.id;
    } else {
      const attempt = Math.max(0, Number(order.refund_attempts) || 0);
      const res = await issuePhonePeRefund({ displayId, amountPaise: verdict.amountPaise, attempt });
      if (!res.ok) throw new Error(res.error || 'PhonePe refund failed');
      ref = res.merchantRefundId;
    }
  } catch (e) {
    // Hand the claim back so a retry can still pay them, and leave the reason
    // where a human will see it.
    await supabase.from('orders')
      .update({ wrong_cod_refund_at: null, wrong_cod_refund_ref: `failed ${claimedAt}: ${e.message}`.slice(0, 200) })
      .eq('id', order.id);
    console.error(`[WRONG-COD-REFUND] ${displayId} (${source}) failed: ${e.message}`);
    return { ok: false, verdict: 'gateway-failed', amountPaise: verdict.amountPaise, error: e.message };
  }

  // The order STAYS delivered. This returns a duplicate payment, not the sale.
  await supabase.from('orders')
    .update({ wrong_cod_refund_at: new Date().toISOString(), wrong_cod_refund_ref: ref })
    .eq('id', order.id);
  await notifyOwnerRefund(order, verdict.amountPaise, {
    provider: pid.startsWith('pay_') ? 'Razorpay' : 'PhonePe',
    reason: `wrong COD collected on a prepaid order (refunded via ${source})`,
    refundId: ref,
  }).catch(() => {});
  console.log(`[WRONG-COD-REFUND] ${displayId} (${source}) refunded ${verdict.amountPaise}p ref=${ref}`);
  return { ok: true, verdict: 'refunded', amountPaise: verdict.amountPaise, ref };
}

/** Auto-refund on delivery. Same switch shape as the bot's, its own env var. */
function autoRefundEnabled(raw = process.env.WRONG_COD_AUTO_REFUND) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return true;
  return !/^(0|off|false|no)$/i.test(text);
}

function refundedEmail({ order, amountPaise, ref }) {
  const id = order.razorpay_order_id || order.id || '';
  const first = String(order.customer_name || 'there').split(' ')[0];
  const amt = (Number(amountPaise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return {
    subject: `We've sent back the ₹${amt} you were wrongly charged (${id})`,
    html: `<div style="font-family:Georgia,serif;color:#3a2f25;max-width:540px;margin:0 auto;padding:24px;background:#faf7f2;">
      <h2 style="font-weight:400;color:#8a6a1f;margin:0 0 14px;">Your ₹${esc(amt)} is on its way back</h2>
      <p style="line-height:1.8;">Hi ${esc(first)},</p>
      <p style="line-height:1.8;">Your order <strong>${esc(id)}</strong> has been delivered — thank you for taking it.</p>
      <p style="line-height:1.8;">You had already paid for it online, but a mistake in our shipping system printed it as
        Cash on Delivery, so you were asked for the money a second time at the door. That was our error, and you should
        not have been put through it.</p>
      <p style="line-height:1.8;">We have refunded <strong>₹${esc(amt)}</strong> to the payment method you originally paid
        with. It normally reflects within 2–3 business days.${ref ? ` Your reference is
        <span style="font-family:Menlo,Consolas,monospace;">${esc(ref)}</span>.` : ''}</p>
      <p style="line-height:1.8;">You did not have to ask us for this, and you do not need to do anything now. If it has
        not appeared after 3 business days, reply to this email or message us on WhatsApp and we will chase it.</p>
      <p style="line-height:1.8;">Sorry again, and I hope the book makes up for some of it.</p>
      <p style="color:#7a6a58;font-size:12px;margin-top:26px;">Ink &amp; Chai · inkandchai.in</p>
    </div>`,
  };
}

/**
 * The refund nobody had to ask for.
 *
 * Called the moment an affected order is marked delivered, by whichever of the
 * webhook or the poller saw it first. A customer who has just been made to pay
 * twice should not also have to notice, work out who to tell, and chase us --
 * by the time they have done that we have already lost them, which is exactly
 * how the two RTOs happened.
 *
 * Best effort by construction: it re-reads the row, it never throws, and it can
 * do nothing at all without disturbing the status write that called it. Being
 * missed here costs a delay, because the button and the bot both still work.
 */
async function autoRefundOnDelivery({ supabase, orderId, source = 'delivery', deps = {} }) {
  const { sendEmail = require('./email').sendEmail } = deps;
  try {
    if (!autoRefundEnabled()) return { skipped: 'disabled' };
    const { data: order, error } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
    // A missing wrong_cod_* column fails this select outright; that is fine,
    // it simply means the migration has not run and nobody is eligible yet.
    if (error || !order) return { skipped: error ? `lookup: ${error.message}` : 'no-order' };
    if (assess(order).verdict !== 'refundable') return { skipped: assess(order).verdict };

    const res = await performWrongCodRefund({ supabase, order, source, deps });
    if (!res.ok) return { skipped: res.verdict, error: res.error };

    if (order.customer_email) {
      const mail = refundedEmail({ order, amountPaise: res.amountPaise, ref: res.ref });
      await sendEmail({ to: order.customer_email, subject: mail.subject, html: mail.html }).catch(() => {});
    }
    console.log(`[WRONG-COD-AUTO] ${order.razorpay_order_id || orderId} refunded ${res.amountPaise}p on delivery (${source})`);
    return { ok: true, amountPaise: res.amountPaise, ref: res.ref };
  } catch (e) {
    // Never let a refund problem break a status write.
    console.error('[WRONG-COD-AUTO]', e.message);
    return { skipped: 'error', error: e.message };
  }
}

module.exports = { assess, botContext, refundsEnabled, autoRefundEnabled, ten, ownerUpiEmail, refundedEmail, performWrongCodRefund, autoRefundOnDelivery, REFUND_BLOCKING_STATUSES };
