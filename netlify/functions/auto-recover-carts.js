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

const RECOVERY_COUPON = 'CHAI10BACK';
const MIN_ABANDON_HOURS = 1;   // don't message sooner than 1 hour
const MAX_ABANDON_HOURS = 48;  // ignore leads older than 48 hours
const MAX_PER_RUN       = 30;  // safety cap — avoid blasting on first deploy

// ── Email helper (mirrors send-abandoned-email.js) ───────────────────────────
async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return { ok: false };
  async function attempt(from) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
    return { ok: res.ok, status: res.status };
  }
  try {
    let r = await attempt('Ink & Chai <support@inkandchai.in>');
    if (!r.ok) r = await attempt('Ink & Chai <onboarding@resend.dev>');
    return r;
  } catch { return { ok: false }; }
}

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
      <p style="color:#7a6330;font-size:12px;margin-top:24px;">Questions? Reply to this email or WhatsApp us at +91 9217175546.</p>
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
    .lt('last_seen_at', minAgo)          // abandoned at least 1 hour ago
    .gt('last_seen_at', maxAgo)          // not older than 48 hours
    .is('followup_whatsapp_clicked_at', null) // not already messaged via WA
    .is('followup_email_sent_at', null)       // not already emailed
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

  let wasSent = 0, emailSent = 0;

  for (const lead of leads) {
    const firstName  = String(lead.customer_name || 'there').split(' ')[0];
    const items      = Array.isArray(lead.cart_items) ? lead.cart_items : [];
    const itemCount  = items.length > 0 ? `${items.length} book${items.length > 1 ? 's' : ''}` : 'books';
    const amtRaw     = lead.amount_paise ? `₹${Math.round(lead.amount_paise / 100)}` : '';
    const now        = new Date().toISOString();
    const update     = {};

    // ── WhatsApp (primary channel) ──────────────────────────────────────────
    if (lead.customer_phone) {
      try {
        await sendWhatsApp({
          to: lead.customer_phone,
          template: 'cart_reminder',
          params: [firstName, itemCount, amtRaw],
        });
        update.followup_whatsapp_clicked_at = now;
        wasSent++;
        console.log(`WA sent → ${lead.customer_phone} (${lead.id})`);
      } catch (e) {
        console.error(`WA failed for ${lead.id}:`, e.message);
      }
    }

    // ── Email (secondary channel — if address available) ───────────────────
    if (lead.customer_email) {
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

  console.log(`auto-recover-carts done: WA=${wasSent}, email=${emailSent}/${leads.length}`);
  return { statusCode: 200 };
};
