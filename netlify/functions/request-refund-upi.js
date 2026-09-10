/**
 * Netlify Function: request-refund-upi
 * POST /.netlify/functions/request-refund-upi   (admin only)
 *
 * Emails the customer of a CANCELLED missing-book replacement asking where to
 * send their money, and hands them a signed link that captures it.
 *
 * Why this exists: when a replacement for a missing book is cancelled, the
 * customer has paid for books they will now never receive. On a prepaid order
 * the admin panel already refunds through the gateway and cancels the
 * replacement in one action. On a COD order there is no payment to reverse --
 * the courier took cash -- so the panel's advice was literally "return the money
 * directly, then cancel the replacement from the Orders tab", with no way to
 * even ask for a UPI id, let alone record one. Those refunds were being carried
 * by hand or not at all.
 *
 * Body: { id, amount_paise?, resend? }
 *   id            replacement row uuid or its IC-R-… order id
 *   amount_paise  what to tell the customer they are owed. Defaults to the
 *                 gateway-can't-cover remainder; the sender confirms it because
 *                 an email that names the wrong figure is worse than none.
 *   resend        allow a second email for the same replacement
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { sendEmail } = require('./utils/email');
const { signRefundUpiToken } = require('./utils/refund-upi-token');
const {
  replacementMeta,
  isMissingBookReplacement,
  refundSplitPaise,
} = require('./utils/missing-books');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const rupees = (paise) => (Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function siteUrl() {
  return String(process.env.URL || 'https://inkandchai.in').replace(/\/+$/, '');
}

function bookRows(items) {
  return (Array.isArray(items) ? items : []).map((it) => {
    const qty = Number(it && it.qty) > 0 ? Number(it.qty) : 1;
    return `<tr><td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#f0e8d8;">
      &#128213; ${esc(it && (it.title || it.name) || 'Book')}${qty > 1 ? ` &times;${qty}` : ''}
    </td></tr>`;
  }).join('');
}

function customerEmailHtml({ firstName, originalId, items, amountPaise, link }) {
  return `
  <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
    <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin:0 0 4px;">Ink &amp; Chai</h1>
    <p style="color:#7a6330;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 24px;">Refund for your missing ${items.length > 1 ? 'books' : 'book'}</p>

    <p style="color:#f0e8d8;font-size:16px;line-height:1.7;margin:0 0 14px;">Hi ${esc(firstName)},</p>

    <p style="color:#a09080;font-size:15px;line-height:1.8;margin:0 0 18px;">
      We're sorry &mdash; we couldn't arrange the replacement for the ${items.length > 1 ? 'books' : 'book'} that were
      missing from order <strong style="color:#c9a84c;">${esc(originalId)}</strong>, so we've cancelled it rather than
      keep you waiting. You should not be out of pocket for something that never reached you.
    </p>

    <table style="width:100%;border-collapse:collapse;margin:0 0 20px;">${bookRows(items)}</table>

    <div style="margin:0 0 22px;padding:16px;background:#152315;border-left:3px solid #6dbf6d;">
      <p style="color:#a09080;margin:0 0 4px;font-size:13px;letter-spacing:1px;text-transform:uppercase;">Refund due to you</p>
      <p style="color:#f0e8d8;margin:0;font-size:26px;">&#8377; ${rupees(amountPaise)}</p>
    </div>

    <p style="color:#a09080;font-size:15px;line-height:1.8;margin:0 0 18px;">
      This order was <strong style="color:#f0e8d8;">cash on delivery</strong>, so there's no card or UPI payment of
      yours for us to reverse &mdash; we need somewhere to send it. Tap below and tell us your UPI ID; the transfer
      usually lands within 24 working hours of you sending it.
    </p>

    <p style="margin:0 0 22px;">
      <a href="${esc(link)}" style="display:inline-block;background:#c9a84c;color:#0d0b08;text-decoration:none;padding:14px 28px;font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">
        Send us your UPI ID
      </a>
    </p>

    <p style="color:#7a6f5f;font-size:13px;line-height:1.7;margin:0 0 18px;">
      The link is just for this order and doesn't show anyone your details. Prefer not to use it? Reply to this
      email or message us on WhatsApp with your UPI ID and we'll take it from there. We'll never ask you for a
      card number, an OTP, a PIN, or for any payment &mdash; this refund is money coming <em>to</em> you.
    </p>

    <p style="color:#7a6f5f;font-size:12px;line-height:1.7;margin:24px 0 0;border-top:1px solid #2a2a2a;padding-top:16px;">
      Ink &amp; Chai &middot; <a href="${esc(siteUrl())}" style="color:#c9a84c;">inkandchai.in</a>
    </p>
  </div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const id = String(body.id || '').trim();
  if (!id) return json(400, { error: 'Missing replacement id' });

  if (!signRefundUpiToken('probe')) {
    return json(503, { error: 'No signing secret configured, so the refund link cannot be minted. Set REFUND_UPI_LINK_SECRET (or ADMIN_SECRET).' });
  }

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // The panel sends the row uuid; a human pasting an id sends IC-R-….
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const { data: repl, error: replErr } = await sb
      .from('orders').select('*')
      .eq(isUuid ? 'id' : 'razorpay_order_id', id)
      .maybeSingle();
    if (replErr) throw replErr;
    if (!repl) return json(404, { error: 'Replacement order not found' });

    const meta = replacementMeta(repl);
    if (!meta || !isMissingBookReplacement(repl)) {
      return json(400, { error: 'That order is not a missing-book replacement, so no refund is owed for books that never arrived.' });
    }
    // Only a cancelled replacement means the books are not coming. Sending this
    // while it is still pending would tell the customer something untrue about
    // an order we are in fact still shipping.
    if (String(repl.status || '').toLowerCase() !== 'cancelled') {
      return json(400, { error: `This replacement is "${repl.status}", not cancelled. Cancel it first — the email tells the customer their books are not coming.` });
    }
    if (meta.refund_upi_id) {
      return json(400, { error: `The customer already gave us a UPI ID (${meta.refund_upi_id}). Pay that out instead of asking again.` });
    }
    if (meta.upi_requested_at && !body.resend) {
      return json(409, {
        error: `Already asked on ${new Date(meta.upi_requested_at).toLocaleString('en-IN')}. Send again only if they did not get it.`,
        already_requested_at: meta.upi_requested_at,
      });
    }

    const email = String(repl.customer_email || '').trim();
    if (!email) return json(400, { error: 'This customer has no email address on the order — ask for the UPI ID over WhatsApp and save it from the panel.' });

    const originalId = String(meta.original_order_id || '').trim();
    const { data: original } = originalId
      ? await sb.from('orders').select('*').eq('razorpay_order_id', originalId).maybeSingle()
      : { data: null };

    const split = refundSplitPaise(repl, original);
    const requested = Number(body.amount_paise);
    const amountPaise = Number.isFinite(requested) && requested > 0 ? Math.round(requested) : split.upiPaise;
    if (!(amountPaise > 0)) {
      return json(400, { error: 'Nothing is owed by UPI on this one — the gateway can refund it in full from the Replacements tab.' });
    }
    if (amountPaise > split.owedPaise) {
      return json(400, { error: `₹${rupees(amountPaise)} is more than the missing books were worth (₹${rupees(split.owedPaise)}).` });
    }

    const replId = repl.razorpay_order_id || repl.id;
    const token = signRefundUpiToken(replId);
    const link = `${siteUrl()}/refund-upi/?id=${encodeURIComponent(replId)}&t=${encodeURIComponent(token)}`;

    await sendEmail({
      to: email,
      subject: `Refund for your missing ${(repl.cart_items || []).length > 1 ? 'books' : 'book'} — ${originalId || replId}`,
      html: customerEmailHtml({
        firstName: String(repl.customer_name || 'there').split(' ')[0] || 'there',
        originalId: originalId || replId,
        items: Array.isArray(repl.cart_items) ? repl.cart_items : [],
        amountPaise,
        link,
      }),
    });

    // Stamp the replacement so the panel can show it was asked, and so a second
    // click has to be deliberate.
    const cart = JSON.parse(JSON.stringify(Array.isArray(repl.cart_items) ? repl.cart_items : []));
    const idx = cart.findIndex(it => it && it._replacement);
    if (idx >= 0) {
      cart[idx]._replacement = {
        ...cart[idx]._replacement,
        upi_requested_at: new Date().toISOString(),
        upi_requested_amount_paise: amountPaise,
        upi_request_count: Number(cart[idx]._replacement.upi_request_count || 0) + 1,
      };
      const { error: upErr } = await sb.from('orders').update({ cart_items: cart }).eq('id', repl.id);
      if (upErr) console.error('[request-refund-upi] stamp failed:', upErr.message);
    }

    return json(200, {
      ok: true,
      sent_to: email,
      amount_paise: amountPaise,
      message: `Asked ${email} for a UPI ID for ₹${rupees(amountPaise)}.`,
    });
  } catch (e) {
    console.error('[request-refund-upi]', e);
    return json(500, { error: e.message || 'Failed to send the refund-UPI request' });
  }
};
