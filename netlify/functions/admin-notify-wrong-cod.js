/**
 * Netlify Function: admin-notify-wrong-cod
 * POST /.netlify/functions/admin-notify-wrong-cod
 *   { "recipients": [ { order_id, name, email, book, wrong_cod, kind } ], "confirm": true }
 *
 * Tells a customer that the parcel on its way to them was booked Cash on
 * Delivery by mistake, asks them to accept it anyway, and collects a UPI id so
 * the money can be returned.
 *
 * WHY THIS EXISTS
 * ---------------
 * 66 shipments went out collectable that should not have been. 12 were caught
 * and re-booked; 6 were delivered and refunded. The rest are already moving
 * and cannot be corrected from here -- XpressBees has no payment-mode update
 * endpoint, and cancelling an in-transit AWB does not recall the parcel. The
 * only thing left that helps the customer is to reach them before the courier
 * does.
 *
 * TWO AUDIENCES, TWO MESSAGES
 * ---------------------------
 * Most of these people paid in full and are about to be asked for the same
 * money twice. But SEVEN are free replacements for a damaged or wrong book --
 * they never owed anything, there is no "double payment" to describe, and
 * sending them the paid-in-full wording would tell a customer we already
 * failed once that they had paid for something they did not. The `kind` field
 * picks the wording and nothing else in this file branches on it.
 *
 * SAFETY
 * ------
 * A message asking for a UPI id is shaped exactly like a fraud attempt, so
 * every send names the order, the book and the amount -- things only we and
 * the customer know -- and states in the message that we will never ask for a
 * card number, PIN, OTP or password. Nothing here can ask for anything else:
 * the body is built from a fixed template, not from input.
 *
 * Sends nothing unless `confirm` is true. Without it, every message is
 * rendered and returned for review, which is how the wording gets checked
 * before 48 strangers read it.
 */

const { requireAdmin } = require('./utils/admin-auth');
const { sendEmail } = require('./utils/email');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body, null, 2) });

const MAX_RECIPIENTS = 200;
const SUPPORT_EMAIL = 'support@inkandchai.in';

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const firstName = (name) => String(name || 'there').trim().split(/\s+/)[0] || 'there';

const rupees = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

/**
 * The paragraph that differs. Everything else about the message is identical,
 * because everything else about the situation is.
 */
function opening(kind, book, amount) {
  if (String(kind).toUpperCase() === 'REPLACEMENT') {
    return `We sent you a free replacement copy of <strong>${esc(book)}</strong>, and it is on its way. `
      + `You owe nothing on it — but through a mistake in our shipping system it was booked as `
      + `<strong>Cash on Delivery for ₹${rupees(amount)}</strong>. If the courier asks you for that money, `
      + `the request is wrong and it is our fault, not yours.`;
  }
  return `Your order of <strong>${esc(book)}</strong> is on its way. You paid for it in full when you placed `
    + `the order — but through a mistake in our shipping system the parcel was booked as `
    + `<strong>Cash on Delivery for ₹${rupees(amount)}</strong>. If the courier asks you for that money at `
    + `the door, it is money you have already paid us once.`;
}

function buildMessage(r) {
  const name = firstName(r.name);
  const amount = rupees(r.wrong_cod);
  const subject = `About your order ${r.order_id} — please read before the parcel arrives`;

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">
  <p>Hi ${esc(name)},</p>

  <p>${opening(r.kind, r.book, r.wrong_cod)}</p>

  <p><strong>Please still accept the parcel.</strong> If the delivery agent asks you for ₹${amount},
  pay it so the delivery is not refused — and then reply to this email with your <strong>UPI ID</strong>
  (something like <em>yourname@bank</em>). We will send the full ₹${amount} back to you the same day,
  and confirm once it is done.</p>

  <p>We are also asking XpressBees to cancel the charge before the parcel reaches you. If they manage it
  in time, you will not be asked for anything and there will be nothing to refund.</p>

  <p style="background:#f6f6f4;border-left:3px solid #c8c2b6;padding:10px 14px;margin:20px 0">
    For your safety: we will <strong>never</strong> ask you for a card number, CVV, PIN, OTP, bank password
    or a payment "to verify" anything. A UPI ID is all we need to send money to you, and it is all we will
    ever ask for.
  </p>

  <p>Order: <strong>${esc(r.order_id)}</strong>${r.awb ? ` &nbsp;·&nbsp; Tracking: <strong>${esc(r.awb)}</strong>` : ''}</p>

  <p>This was our error and I am sorry for the trouble it puts you to. If anything above is unclear,
  reply here and a person will answer.</p>

  <p>— Team Ink &amp; Chai<br>
  <a href="mailto:${SUPPORT_EMAIL}" style="color:#7a6a53">${SUPPORT_EMAIL}</a></p>
</div>`.trim();

  return { subject, html };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS);
  if (block) return block;
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const recipients = Array.isArray(body.recipients) ? body.recipients : [];
  if (!recipients.length) return json(400, { error: 'recipients[] is required' });
  if (recipients.length > MAX_RECIPIENTS) {
    return json(400, { error: `at most ${MAX_RECIPIENTS} recipients per call (got ${recipients.length})` });
  }

  const confirm = body.confirm === true;
  const results = [];

  for (const r of recipients) {
    const to = String(r.email || '').trim();
    const { subject, html } = buildMessage(r);

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      results.push({ order_id: r.order_id, status: 'no_email' });
      continue;
    }
    if (!confirm) {
      results.push({ order_id: r.order_id, status: 'preview', to, subject, html });
      continue;
    }
    try {
      const ok = await sendEmail({ to, subject, html });
      results.push({ order_id: r.order_id, status: ok === false ? 'failed' : 'sent', to });
    } catch (e) {
      results.push({ order_id: r.order_id, status: 'failed', to, error: e.message });
    }
  }

  const count = (s) => results.filter((x) => x.status === s).length;
  return json(200, {
    confirmed: confirm,
    totals: { sent: count('sent'), failed: count('failed'), no_email: count('no_email'), preview: count('preview') },
    results: confirm ? results : results.slice(0, 2),
  });
};

exports.__test = { buildMessage, opening, firstName, rupees };
