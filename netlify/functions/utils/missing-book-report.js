'use strict';

/**
 * A customer says a book did not arrive in their parcel. This is everything
 * that happens next, shared by the two places a customer can say it:
 *
 *   report-missing-books.js   the "Missing a book?" form on /track
 *   whatsapp-bot.js           the report_missing_book tool, in chat
 *
 * Each caller proves the customer owns the order and that it is delivered in
 * its own way (the form by email/phone typed in, the bot by the WhatsApp number
 * on the order). From there the work is identical, and it lives here so a report
 * made in chat lands in the admin panel exactly like one made on the website:
 *
 *   - `_missing` is stamped on the original order's lines (Missing Books tab),
 *   - a FREE replacement order IC-R-… is created for just those books
 *     (unshipped list and Replacements tab, pushed after the usual review
 *     window by auto-push-replacements),
 *   - the customer is emailed and WhatsApped, and the owner is emailed.
 *
 * One replacement per original order still holds. When the one on file does not
 * carry the book reported now, no parcel is promised: the customer is told a
 * person will follow up and the owner is asked to act.
 */

const { beginClaim } = require('./customer-claim');
const { sendEmail } = require('./email');
const { sendWhatsApp, sendText } = require('./whatsapp');
const { replacementCovers } = require('./missing-books');

const orderId = (o) => o.razorpay_order_id || o.id;
const lineTitle = (it) => String((it && (it.title || it.name)) || '').trim();
// Loose key for a title typed in chat: case, punctuation and spacing ignored.
const looseKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, '');

/**
 * Auto-create a FREE replacement order for just the missing book(s) — same
 * conventions as request-replacement.js (status replacement_pending, source
 * 'replacement', ₹0, `_replacement` meta on the first item) so it flows into
 * the existing unshipped list / NimbusPost push / admin replacement tooling.
 * Guard: at most ONE replacement per original order. Returns the new order id
 * or null (never throws — the report itself must still succeed).
 */
async function createMissingReplacement(supabase, order, replacementItems, comment = '', refundUpi = '', via = 'website', photos = []) {
  try {
    // One replacement per original — matches request-replacement's abuse guard.
    const { data: existing } = await supabase
      .from('orders')
      .select('razorpay_order_id, cart_items')
      .eq('source', 'replacement')
      .eq('cart_items->0->_replacement->>original_order_id', String(order.razorpay_order_id || order.id))
      .limit(1)
      .maybeSingle();
    if (existing) {
      // The one-replacement-per-order rule is unchanged. What changes is what we
      // then TELL people. The replacement already on file may not contain the
      // book just reported -- a second report naming a different title, or a
      // replacement raised earlier for a damaged or wrong book entirely. Saying
      // "replacement created" there is a promise nobody is keeping: no parcel
      // exists with that book in it. Report it uncovered instead, so the
      // customer is told a person will follow up and the owner is asked to act.
      const covers = replacementCovers(existing, replacementItems);
      return { id: existing.razorpay_order_id, existed: true, covers };
    }

    const now = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
    const randPart = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
    const origIsCW = /^IC-CW-/i.test(String(order.razorpay_order_id || ''));
    const replId = origIsCW ? `IC-R-CW-${datePart}-${randPart}` : `IC-R-${datePart}-${randPart}`;

    // Cart = ONLY the missing books, with the customer-selected quantities
    // (already capped at what they ordered), stripped of any _missing flags.
    const cart = replacementItems.map(({ _missing, _missing_at, _missing_qty, _missing_photos, ...it }) => ({ ...it }));
    cart[0]._replacement = {
      original_order_id: order.razorpay_order_id || order.id,
      reason: 'missing_item',
      reason_label: 'Item missing from package',
      note: via === 'whatsapp'
        ? 'Auto-created by the WhatsApp bot from the customer\'s chat.'
        : 'Auto-created from the customer\'s missing-book report.',
      reported_via: via,
      photos,
      ...(comment ? { customer_comment: comment } : {}),
      // Only ever set for a COD order: the handle to send a partial refund to
      // if the missing book turns out to be unarrangeable. See utils/upi-id.
      ...(refundUpi ? { refund_upi_id: refundUpi } : {}),
      requested_at: now.toISOString(),
    };

    const { error } = await supabase.from('orders').insert({
      razorpay_order_id:   replId,
      razorpay_payment_id: null,
      amount_paise:        0,                       // free reshipment
      status:              'replacement_pending',
      shipment_payment_type: 'prepaid',
      customer_name:       order.customer_name || '',
      customer_email:      order.customer_email || '',
      customer_phone:      order.customer_phone || '',
      customer_address:    order.customer_address || '',
      cart_items:          cart,
      ...(order.user_id ? { user_id: order.user_id } : {}),
      source:              'replacement',
    });
    if (error) throw error;
    return { id: replId, existed: false, covers: true };
  } catch (e) {
    console.error('[missing-book-report] replacement create failed:', e.message);
    return null;
  }
}

function missingEmailHtml(order, missing, replId) {
  const first = String(order.customer_name || 'there').split(' ')[0];
  const rows = missing.map(t => `
    <tr><td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#f0e8d8;">📕 ${t}</td></tr>`).join('');
  const nextStep = replId
    ? `
      <div style="margin:18px 0;padding:16px;background:#152315;border-left:3px solid #6dbf6d;">
        <p style="color:#f0e8d8;margin:0 0 6px;font-size:15px;">✅ <strong>Replacement created — nothing to pay.</strong></p>
        <p style="color:#a09080;margin:0;line-height:1.8;">
          We've automatically created a <strong style="color:#c9a84c;">free replacement order ${replId}</strong>
          for the missing ${missing.length > 1 ? 'books' : 'book'}. It ships at no charge and we'll send you
          tracking details as soon as it's dispatched.
        </p>
      </div>
      <p style="color:#a09080;line-height:1.8;margin:14px 0;">
        Prefer a refund instead? Just reply to this email or message us on WhatsApp and we'll switch it.
      </p>`
    : `
      <p style="color:#a09080;line-height:1.8;margin:14px 0;">
        Our team has been alerted and will reach out shortly. You won't be charged for anything you
        didn't receive — we'll send the missing ${missing.length > 1 ? 'books' : 'book'} or issue a
        refund, whichever you prefer. Just reply to this email or message us on WhatsApp.
      </p>`;
  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">inkandchai.in</p>
      <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">We've noted your incomplete order</h2>
      <p style="color:#a09080;line-height:1.8;margin:14px 0;">
        Hi ${first}, thanks for letting us know. You reported that your Ink &amp; Chai order
        <strong style="color:#c9a84c;">${orderId(order)}</strong> arrived <strong style="color:#f0e8d8;">incomplete</strong>.
        The following ${missing.length > 1 ? 'books were' : 'book was'} missing from your parcel:
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:15px;background:#1c1916;">
        <tbody>${rows}</tbody>
      </table>
      ${nextStep}
      <p style="color:#a09080;font-size:13px;line-height:1.8;">Thank you for your patience — we'll make this right. 💛</p>
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai &middot; support@inkandchai.in</p>
    </div>`;
}

function ownerMissingEmailHtml(order, missing, replId, comment = '', refundUpi = '', blockedBy = '', via = 'website') {
  const rows = missing.map(t => `<li style="margin:4px 0;color:#f0e8d8;">${t}</li>`).join('');
  const safeComment = String(comment || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const commentBlock = safeComment
    ? `<div style="margin:14px 0;padding:14px;background:#1c1916;border-left:3px solid #c9a84c;">
         <p style="color:#a09080;font-size:12px;margin:0 0 6px;text-transform:uppercase;letter-spacing:1px;">Customer's comment</p>
         <p style="color:#f0e8d8;margin:0;line-height:1.7;white-space:pre-wrap;">${safeComment}</p>
       </div>`
    : '';
  // COD only. Surfaced prominently because it is the ONLY way to refund this
  // customer if the missing book cannot be arranged — there is no payment to
  // reverse.
  const upiBlock = refundUpi
    ? `<div style="margin:14px 0;padding:14px;background:#151f15;border-left:3px solid #6dbf6d;">
         <p style="color:#a09080;font-size:12px;margin:0 0 6px;text-transform:uppercase;letter-spacing:1px;">COD &middot; refund UPI ID</p>
         <p style="color:#f0e8d8;margin:0;font-size:16px;"><strong>${String(refundUpi).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</strong></p>
         <p style="color:#a09080;margin:6px 0 0;font-size:12px;">Use this only if the book cannot be arranged — pay the missing book's value here.</p>
       </div>`
    : '';
  const nextLine = replId
    ? `<p style="color:#6dbf6d;font-size:14px;">✅ Replacement order <strong style="color:#c9a84c;">${replId}</strong> was created automatically (₹0, only the missing book${missing.length > 1 ? 's' : ''}). It's in the unshipped list — ship it from the Orders tab. The customer has been notified.</p>`
    : blockedBy
      ? `<p style="color:#e0a94a;font-size:14px;">⚠️ <strong>No replacement was created.</strong> This order already has replacement <strong style="color:#c9a84c;">${blockedBy}</strong>, and it does not contain ${missing.length > 1 ? 'these books' : 'this book'} — one replacement per order is the rule, so nothing is shipping for ${missing.length > 1 ? 'them' : 'it'} until you act. It is waiting under <strong>Missing Books &rarr; No replacement</strong>. The customer has been told a person will follow up, not that a parcel is on the way.</p>`
      : `<p style="color:#a09080;font-size:13px;">Next: send a replacement (Replacement flow) or issue a refund from the admin panel. The customer has been emailed a confirmation.</p>`;
  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:22px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:24px;">Admin notification</p>
      <h2 style="color:#e0a94a;font-size:20px;font-weight:400;">Customer reported an incomplete order</h2>
      <p style="color:#a09080;font-size:13px;">Reported ${via === 'whatsapp' ? 'to the <strong style="color:#f0e8d8;">WhatsApp bot</strong> — check the Bot Inbox for the chat' : 'on the website (/track)'}.</p>
      <p style="color:#a09080;font-size:13px;">Order ID: <strong style="color:#c9a84c;">${orderId(order)}</strong> &middot; status: ${order.status || '—'}</p>
      <table style="font-size:14px;line-height:1.8;color:#f0e8d8;margin:10px 0;">
        <tr><td style="color:#a09080;padding-right:16px;">Name</td><td>${order.customer_name || '—'}</td></tr>
        <tr><td style="color:#a09080;padding-right:16px;">Phone</td><td>${order.customer_phone || '—'}</td></tr>
        <tr><td style="color:#a09080;padding-right:16px;">Email</td><td>${order.customer_email || '—'}</td></tr>
      </table>
      <p style="color:#a09080;margin:14px 0 6px;">Missing book(s) the customer flagged:</p>
      <ul style="margin:0 0 16px;padding-left:20px;">${rows}</ul>
      ${commentBlock}
      ${upiBlock}
      ${nextLine}
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#7a6330;font-size:11px;">Sent to the store owner &middot; inkandchai.in</p>
    </div>`;
}


/**
 * Map what the customer named onto the order's own lines.
 *
 * `requested` is [{ title, qty|null }]. A qty of null means every copy ordered;
 * any qty is clamped to [1, ordered]. The website picker sends titles copied
 * from the order, so exact (case-insensitive) matching is enough there. A title
 * typed in chat is not: `loose` also ignores punctuation and spacing, and then
 * accepts a unique containment either way ("atomic habits" for "Atomic Habits
 * (Paperback)"). Two lines matching one name is ambiguous and matches neither --
 * better to ask than to ship the wrong book.
 *
 * → { valid: [{ title, qty, orderedQty, item }], unmatched: [title], ordered: [{ title, qty }] }
 */
function matchMissingItems(order, requested, { loose = false } = {}) {
  const items = Array.isArray(order && order.cart_items) ? order.cart_items : [];
  const byTitle = new Map();   // lower title → { item, orderedQty }
  for (const it of items) {
    const t = lineTitle(it).toLowerCase();
    if (!t) continue;
    const prev = byTitle.get(t);
    byTitle.set(t, { item: prev ? prev.item : it, orderedQty: (prev ? prev.orderedQty : 0) + (Number(it.qty) || 1) });
  }
  const lines = [...byTitle.entries()];

  const find = (title) => {
    const exact = byTitle.get(String(title).trim().toLowerCase());
    if (exact || !loose) return exact || null;
    const k = looseKey(title);
    if (!k) return null;
    const same = lines.filter(([t]) => looseKey(t) === k);
    if (same.length === 1) return same[0][1];
    if (k.length < 4) return null;
    const near = lines.filter(([t]) => { const lk = looseKey(t); return lk.includes(k) || k.includes(lk); });
    return near.length === 1 ? near[0][1] : null;
  };

  const valid = [];
  const unmatched = [];
  const seen = new Set();
  for (const r of requested || []) {
    const hit = find(r.title);
    if (!hit) { unmatched.push(r.title); continue; }
    const title = lineTitle(hit.item) || r.title;
    if (seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const cap = Math.max(1, hit.orderedQty);
    const qty = r.qty == null ? cap : Math.min(Math.max(1, Math.floor(r.qty)), cap);
    valid.push({ title, qty, orderedQty: cap, item: hit.item });
  }
  return {
    valid,
    unmatched,
    ordered: lines.map(([, v]) => ({ title: lineTitle(v.item), qty: v.orderedQty })),
  };
}

/**
 * Record the report, create the replacement and tell everyone.
 *
 * `valid` comes from matchMissingItems. `via` is 'website' or 'whatsapp'.
 * `chatText`, when given, replaces the WhatsApp template: the customer is in a
 * live chat with the bot, so one plain message through the SAME business number
 * they wrote to lands inside the 24-hour window, where a template through the
 * default number would be a second, out-of-context thread.
 *
 * Never throws for a notification failure; the report itself is what matters.
 */
async function recordMissingBookReport(supabase, order, {
  valid, comment = '', refundUpi = '', via = 'website', chatText = null, photos = [],
} = {}, deps = {}) {
  const email = deps.sendEmail || sendEmail;
  const waTemplate = deps.sendWhatsApp || sendWhatsApp;
  const waText = deps.sendText || sendText;
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];

  // Flag the missing items on the order row (idempotent), recording how many
  // of each were missing.
  const now = new Date().toISOString();
  const validQtyByTitle = new Map(valid.map(v => [v.title.toLowerCase(), v.qty]));
  const stampedItems = items.map(it => {
    const title = lineTitle(it);
    return title && validQtyByTitle.has(title.toLowerCase())
      ? {
        ...it,
        _missing: true,
        _missing_qty: validQtyByTitle.get(title.toLowerCase()),
        _missing_at: now,
        _missing_via: via,
        _missing_photos: photos,
        ...(comment ? { _missing_comment: comment } : {}),
        ...(refundUpi ? { _refund_upi_id: refundUpi } : {}),
      }
      : it;
  });
  try {
    const saved = await supabase.from('orders').update({ cart_items: stampedItems }).eq('id', order.id);
    if (saved.error) throw saved.error;
  } catch (e) {
    throw e;
  }

  // Clean replacement lines carrying the chosen (capped) quantities.
  const replacementItems = valid.map(v => {
    const { _missing, _missing_at, _missing_qty, _missing_photos, _missing_via, _missing_comment, _refund_upi_id, ...clean } = v.item;
    return { ...clean, qty: v.qty };
  });
  const repl = await createMissingReplacement(supabase, order, replacementItems, comment, refundUpi, via, photos);
  // Every message below keys off replId, and all of them already say the right
  // thing when it is null ("our team will reach out"). So the single place to
  // be honest is here: a replacement that does not carry these books is not a
  // replacement for them.
  const replId = (repl && repl.covers) ? repl.id : null;
  const blockedBy = (repl && repl.existed && !repl.covers) ? repl.id : '';

  const result = {
    email: false, whatsapp: false, ownerEmail: false,
    replacement_order_id: replId,
    replacement_existed: !!(repl && repl.existed),
    // True when a replacement exists for this order but not for these books:
    // nothing is shipping for them until someone acts.
    replacement_uncovered: !!blockedBy,
    replacement_failed: !repl,
  };
  const first = String(order.customer_name || 'there').split(' ')[0];
  // Human labels with quantity, e.g. "Market Wizards ×2, Mastering the Market Cycle".
  const missingLabels = valid.map(v => (v.qty > 1 ? `${v.title} ×${v.qty}` : v.title));
  const missingList = missingLabels.join(', ');
  result.missing = missingLabels;

  // ── Customer email confirmation ────────────────────────────────────────────
  if (order.customer_email) {
    try {
      const em = await email({
        to: order.customer_email,
        subject: replId
          ? `Replacement on the way — order ${replId}`
          : `We've noted your incomplete order ${orderId(order)}`,
        html: missingEmailHtml(order, missingLabels, replId),
      });
      result.email = !!(em && em.ok);
    } catch (e) {
      console.error('[missing-book-report] customer email:', e.message);
    }
  }

  // ── Customer WhatsApp ──────────────────────────────────────────────────────
  const plain = `Hi ${first}, thanks for reporting that your Ink & Chai order ${orderId(order)} arrived incomplete. ` +
    `Missing: ${missingList}. ` +
    (replId
      ? `We've created a free replacement order ${replId} — it ships at no charge and you'll get tracking once dispatched. 💛`
      : `Our team will reach out — we'll send the missing book(s) or refund you. 💛`);
  if (order.customer_phone) {
    try {
      if (chatText) {
        const sent = await chatText(plain);
        result.whatsapp = !!(sent && sent.ok);
      } else {
        // Template first (works outside the 24h window), free-form text fallback.
        const wa = await waTemplate({
          to: order.customer_phone,
          template: process.env.WHATSAPP_MISSING_BOOKS_TEMPLATE || 'order_incomplete',
          params: [first, orderId(order), missingList],
        });
        if (wa && wa.ok) {
          result.whatsapp = true;
          // Follow-up text with the replacement id (in-window after the template).
          if (replId && !repl.existed) {
            await waText(
              order.customer_phone,
              `📦 Good news ${first} — we've created a free replacement order ${replId} for: ${missingList}. It ships at no charge and you'll get tracking as soon as it's dispatched.`
            ).catch(() => {});
          }
        } else {
          const txt = await waText(order.customer_phone, plain);
          result.whatsapp = !!(txt && txt.ok);
          result.whatsapp_fallback = !!(txt && txt.ok);
        }
      }
    } catch (e) {
      console.error('[missing-book-report] customer whatsapp:', e.message);
    }
  }

  // ── Owner notification ─────────────────────────────────────────────────────
  const ownerEmail = process.env.STORE_OWNER_EMAIL;
  if (ownerEmail) {
    try {
      const tag = via === 'whatsapp' ? ' (WhatsApp bot)' : '';
      const sent = await email({
        to: ownerEmail,
        subject: replId
          ? `📦 Incomplete order ${orderId(order)} → replacement ${replId} created${tag} — ${missingList}`
          : `📦 Customer reported incomplete order ${orderId(order)}${tag} — ${missingList}`,
        html: ownerMissingEmailHtml(order, missingLabels, replId, comment, refundUpi, blockedBy, via),
      });
      result.ownerEmail = !!(sent && sent.ok);
    } catch (e) {
      console.error('[missing-book-report] owner email:', e.message);
    }
  }

  return result;
}

async function fileMissingBookReport(supabase, order, options = {}, deps = {}) {
  const claim = await beginClaim(supabase, order, options.photos);
  try {
    const result = await recordMissingBookReport(supabase, order, { ...options, photos: claim.photos }, deps);
    if (result.replacement_order_id) await claim.complete();
    else await claim.release(); // The recorded report blocks repeat customer claims; admin can fulfil it.
    return result;
  } catch (error) { await claim.release(); throw error; }
}

module.exports = { matchMissingItems, fileMissingBookReport, createMissingReplacement };
