/**
 * Netlify Scheduled Function: auto-recover-carts
 * Runs every hour via netlify.toml schedule = "@hourly"
 *
 * Finds abandoned checkouts that:
 *   - Are still "open" (not converted)
 *   - Were last seen 1–48 hours ago (not still actively browsing, not too stale)
 *   - Have NOT already received a WhatsApp/email recovery message
 *   - Have a phone number (required for WhatsApp)
 *
 * Sends the cart_reminder WhatsApp template (+ recovery email if email exists)
 * with coupon CHAI10BACK for 10% off, then marks the row so it is never
 * messaged again.
 *
 * env vars required (same as rest of site):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   WHATSAPP_TOKEN, WHATSAPP_PHONE_ID
 *   RESEND_API_KEY  (optional — for email fallback)
 */

const { createClient } = require('@supabase/supabase-js');
const { sendWhatsApp }  = require('./utils/whatsapp');

const { sendEmail } = require('./utils/email');
const { classifyLead, isValidIndianMobile, isValidEmail } = require('./utils/spam-filter');

const RECOVERY_COUPON = 'CHAI10BACK';
const MIN_ABANDON_HOURS = 1;   // don't message sooner than 1 hour
const MAX_ABANDON_HOURS = 48;  // ignore leads older than 48 hours
const MAX_PER_RUN       = 30;  // safety cap — avoid blasting on first deploy

// Don't spend a MARKETING-rate WhatsApp on a cart too small to pay for it.
// Measured over August 2026: the reminder converts at 1.4-1.7% below ₹400 and
// 2.2-3.2% above it, so the two cheapest bands burned 65% of the spend
// (₹1,435 of ₹2,202) to return 26% of the recovered value. On book margins,
// with the 10% CHAI10BACK coupon on top, the sub-₹200 band was break-even.
// Override with WHATSAPP_RECOVERY_MIN_PAISE; set it to 0 to message everyone.
const MIN_CART_PAISE = process.env.WHATSAPP_RECOVERY_MIN_PAISE !== undefined
  ? Math.max(0, Number(process.env.WHATSAPP_RECOVERY_MIN_PAISE) || 0)
  : 40000;   // ₹400

// Meta rejects an unapproved or param-mismatched template before anything is
// sent or charged, so falling back to the older template is free. 132xxx are
// the template errors.
function isTemplateRejection(r) {
  const code = Number(r?.error?.code ?? r?.code ?? 0);
  const msg = String(r?.error?.message || r?.error || '').toLowerCase();
  if (code >= 132000 && code <= 132999) return true;
  return /template/.test(msg) && /(not exist|not found|does not|not approved|param)/.test(msg);
}

// Build a WhatsApp-safe book label from cart items: the first title, plus a
// "& N more book(s)" tail for multi-item carts. Strips newlines/tabs (Meta
// rejects template params containing them) and caps length.
function cartBooksLabel(items) {
  if (!Array.isArray(items) || !items.length) return 'your books';
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const first = clean(items[0]?.title).slice(0, 60) || 'your book';
  const extra = items.length - 1;
  return extra > 0 ? `${first} & ${extra} more book${extra > 1 ? 's' : ''}` : first;
}

// ── Email helper (mirrors send-abandoned-email.js) ───────────────────────────

function recoveryEmailHtml(lead) {
  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const firstName = esc(String(lead.customer_name || 'there').split(' ')[0]);
  const items = Array.isArray(lead.cart_items) ? lead.cart_items : [];
  const itemHtml = items.map(i => `<li>${esc(i.title || 'Book')} × ${esc(i.qty || 1)}</li>`).join('');
  const amount = lead.amount_paise ? `₹${(lead.amount_paise / 100).toLocaleString('en-IN')}` : '';
  return `<!doctype html><html><body style="margin:0;background:#0d0b08;font-family:Georgia,serif;color:#f0e8d8;">
  <div style="max-width:600px;margin:0 auto;padding:32px 18px;">
    <div style="font-size:28px;color:#c9a84c;margin-bottom:18px;">Ink &amp; Chai</div>
    <div style="background:#1c1916;border:1px solid rgba(201,168,76,0.2);padding:28px;">
      <h2 style="font-weight:400;color:#faf7f2;margin:0 0 14px;">Your books are still waiting 📚</h2>
      <p style="color:#a09080;line-height:1.7;">Hi ${firstName}, you left something behind at Ink &amp; Chai. Here's a private 10% coupon just for you.</p>
      <ul style="color:#f0e8d8;line-height:1.8;">${itemHtml}</ul>
      ${amount ? `<p style="color:#a09080;">Cart total: <strong style="color:#c9a84c;">${amount}</strong></p>` : ''}
      <div style="border:1px dashed rgba(201,168,76,0.5);background:rgba(201,168,76,0.07);padding:18px;margin:20px 0;text-align:center;">
        <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#a09080;margin-bottom:8px;">Your private coupon</div>
        <div style="font-size:26px;letter-spacing:4px;font-weight:700;color:#c9a84c;">${RECOVERY_COUPON}</div>
        <div style="font-size:13px;color:#a09080;margin-top:8px;">10% off on prepaid orders above ₹299. One use only.</div>
      </div>
      <a href="https://inkandchai.in/checkout/" style="display:inline-block;background:#c9a84c;color:#0d0b08;text-decoration:none;padding:12px 22px;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:600;">Complete Checkout →</a>
      <p style="color:#c9b98a;font-size:13px;line-height:1.7;margin-top:22px;border-top:1px solid rgba(201,168,76,0.18);padding-top:16px;">📸 Still doubtful? Please check our Instagram for reference — real reader photos, genuine books &amp; happy customers: <a href="https://instagram.com/theinkandchai.in" style="color:#c9a84c;font-weight:600;text-decoration:none;">@theinkandchai.in</a></p>
      <p style="color:#7a6330;font-size:12px;margin-top:18px;">Questions? Reply to this email or WhatsApp us at +91 76784 00508.</p>
    </div>
  </div></body></html>`;
}

// ── Main scheduled handler ────────────────────────────────────────────────────
exports.handler = async () => {
  const SUPABASE_URL         = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('auto-recover-carts: Supabase not configured');
    return { statusCode: 200 };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const now       = new Date();
  const minAgo    = new Date(now.getTime() - MIN_ABANDON_HOURS * 60 * 60 * 1000).toISOString();
  const maxAgo    = new Date(now.getTime() - MAX_ABANDON_HOURS * 60 * 60 * 1000).toISOString();

  // Fetch eligible abandoned checkouts
  const { data: leads, error } = await supabase
    .from('abandoned_checkouts')
    .select('*')
    .eq('status', 'open')
    .or('source.is.null,source.neq.paperbound')  // don't recover paperbound carts
    .lt('last_seen_at', minAgo)          // abandoned at least 1 hour ago
    .gt('last_seen_at', maxAgo)          // not older than 48 hours
    .is('followup_whatsapp_clicked_at', null) // not already messaged via WA
    .is('followup_email_sent_at', null)       // not already emailed
    .gte('amount_paise', MIN_CART_PAISE)      // worth a marketing-rate message
    .limit(MAX_PER_RUN);

  if (error) {
    console.error('auto-recover-carts: fetch error:', error.message);
    return { statusCode: 200 };
  }

  if (!leads?.length) {
    console.log('auto-recover-carts: no eligible leads');
    return { statusCode: 200 };
  }

  console.log(`auto-recover-carts: processing ${leads.length} leads`);

  let wasSent = 0, emailSent = 0, skippedSpam = 0;

  for (const lead of leads) {
    // ── Spam guard: never message bots / junk leads ────────────────────────
    // Mark them messaged so they're excluded from future runs without ever
    // costing a WhatsApp credit or an email.
    const verdict = classifyLead({
      name:  lead.customer_name,
      email: lead.customer_email,
      phone: lead.customer_phone,
    });
    if (verdict.spam) {
      skippedSpam++;
      await supabase
        .from('abandoned_checkouts')
        .update({ followup_whatsapp_clicked_at: new Date().toISOString(),
                  followup_email_sent_at: new Date().toISOString() })
        .eq('id', lead.id);
      continue;
    }

    const firstName  = String(lead.customer_name || 'there').split(' ')[0];
    const items      = Array.isArray(lead.cart_items) ? lead.cart_items : [];
    const bookLabel  = cartBooksLabel(items);   // actual title(s), e.g. "Atomic Habits & 1 more book"
    const amtRaw     = lead.amount_paise ? `₹${Math.round(lead.amount_paise / 100)}` : '';
    const now        = new Date().toISOString();
    const update     = {};

    // ── WhatsApp (primary channel) — only to a real Indian mobile ──────────
    if (lead.customer_phone && isValidIndianMobile(lead.customer_phone)) {
      try {
        // Prefer the newer cart_reminder_ig template (adds the Instagram
        // reassurance line + buttons). Fall back to the original cart_reminder
        // if the new one isn't approved yet — same 3 params, so this is a
        // zero-downtime swap before/after Meta approval.
        const p = [firstName, bookLabel, amtRaw];
        let r = await sendWhatsApp({ to: lead.customer_phone, template: 'cart_reminder_ig', params: p });
        // Retry ONLY on a template-level rejection. Any other failure (network
        // blip, timeout, 5xx) may well have delivered, and a blind resend pays
        // the marketing rate twice AND messages the customer twice.
        if (!r || (!r.ok && isTemplateRejection(r))) {
          r = await sendWhatsApp({ to: lead.customer_phone, template: 'cart_reminder', params: p });
        }
        if (r && r.ok) {
          update.followup_whatsapp_clicked_at = now;
          wasSent++;
          console.log(`WA sent → ${lead.customer_phone} (${lead.id})`);
        }
      } catch (e) {
        console.error(`WA failed for ${lead.id}:`, e.message);
      }
    }

    // ── Email (secondary channel — only to a valid, non-bot address) ───────
    if (lead.customer_email && isValidEmail(lead.customer_email)) {
      try {
        const r = await sendEmail({
          to: lead.customer_email,
          subject: `Your private 10% coupon — ${RECOVERY_COUPON} | Ink & Chai`,
          html: recoveryEmailHtml(lead),
        });
        if (r.ok) {
          update.followup_email_sent_at = now;
          emailSent++;
          console.log(`Email sent → ${lead.customer_email} (${lead.id})`);
        }
      } catch (e) {
        console.error(`Email failed for ${lead.id}:`, e.message);
      }
    }

    // ── Mark as messaged (even if only one channel succeeded) ──────────────
    if (Object.keys(update).length) {
      await supabase
        .from('abandoned_checkouts')
        .update(update)
        .eq('id', lead.id);
    }

    // Small delay to avoid rate-limiting WhatsApp API
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`auto-recover-carts done: WA=${wasSent}, email=${emailSent}, spamSkipped=${skippedSpam}/${leads.length}`);
  return { statusCode: 200 };
};
