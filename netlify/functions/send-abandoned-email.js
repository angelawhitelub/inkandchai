/**
 * Netlify Function: send-abandoned-email
 * POST /.netlify/functions/send-abandoned-email
 *
 * Admin-only: sends a checkout recovery email through Resend.
 */

const { createClient } = require('@supabase/supabase-js');
const { sendWhatsApp } = require('./utils/whatsapp');

const { sendEmail } = require('./utils/email');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

const RECOVERY_COUPON = 'CHAI10BACK';


function emailBase(content) {
  return `<!doctype html><html><body style="margin:0;background:#faf7f2;font-family:Arial,sans-serif;color:#2a2018;">
  <div style="max-width:620px;margin:0 auto;padding:28px 18px;">
    <div style="font-family:Georgia,serif;font-size:28px;color:#8a6a1f;margin-bottom:18px;">Ink &amp; Chai</div>
    <div style="background:#fff;border:1px solid #dccda8;padding:24px;">${content}</div>
    <p style="color:#8a7a62;font-size:12px;line-height:1.6;">Ink &amp; Chai · inkandchai.in · Reply to this email or WhatsApp us at +91 76784 00508.</p>
  </div></body></html>`;
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const id = String(body.id || '').trim();
  if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id required' }) };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: lead, error } = await supabase
      .from('abandoned_checkouts')
      .select('*')
      .eq('id', id)
      .single();
    if (error) throw error;
    if (!lead?.customer_email) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Lead has no email address' }) };
    }

    const items = Array.isArray(lead.cart_items) ? lead.cart_items : [];
    const itemHtml = items.map(item => `<li>${esc(item.title || 'Book')} × ${esc(item.qty || 1)}</li>`).join('');
    const firstName = esc(String(lead.customer_name || 'there').split(' ')[0]);
    const amount = lead.amount_paise ? `₹${(lead.amount_paise / 100).toLocaleString('en-IN')}` : '';
    const result = await sendEmail({
      to: lead.customer_email,
      subject: `Your private 10% Ink & Chai coupon: ${RECOVERY_COUPON}`,
      html: emailBase(`
        <h1 style="font-family:Georgia,serif;font-weight:400;color:#2a2018;margin:0 0 12px;">A private 10% coupon for your books</h1>
        <p style="line-height:1.7;">Hi ${firstName}, the books you selected at Ink &amp; Chai are still waiting in checkout.</p>
        <ul style="line-height:1.8;">${itemHtml}</ul>
        ${amount ? `<p><strong>Total:</strong> ${amount}</p>` : ''}
        <div style="border:1px dashed #8a6a1f;background:#faf7f2;padding:16px;margin:18px 0;text-align:center;">
          <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#8a7a62;margin-bottom:8px;">Use private coupon</div>
          <div style="font-size:24px;letter-spacing:3px;font-weight:700;color:#8a6a1f;">${RECOVERY_COUPON}</div>
          <div style="font-size:13px;color:#5a4a38;margin-top:8px;">Get 10% off on your prepaid order above ₹299.</div>
        </div>
        <p style="line-height:1.7;">Apply the coupon at checkout before you pay. This code is not shown publicly on the website.</p>
        <p><a href="https://inkandchai.in/checkout/" style="display:inline-block;background:#8a6a1f;color:#fff;text-decoration:none;padding:12px 20px;font-size:12px;letter-spacing:2px;text-transform:uppercase;">Complete Checkout</a></p>
        <p style="line-height:1.7;margin-top:20px;border-top:1px solid #e8ddc8;padding-top:16px;color:#5a4a38;">📸 Still doubtful? Please check our Instagram for reference — real reader photos, genuine books and happy customers: <a href="https://instagram.com/theinkandchai.in" style="color:#8a6a1f;font-weight:600;text-decoration:none;">@theinkandchai.in</a></p>
      `),
    });

    if (!result.ok) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: result.body?.message || result.error || 'Email failed' }) };
    }

    await supabase.from('abandoned_checkouts').update({ followup_email_sent_at: new Date().toISOString() }).eq('id', id);

    // WhatsApp cart reminder (in addition to email, if phone exists)
    if (lead.customer_phone) {
      const itemCount = items.length > 0 ? `${items.length} book${items.length > 1 ? 's' : ''}` : 'books';
      const amtRaw = lead.amount_paise ? `₹${Math.round(lead.amount_paise / 100)}` : '';
      // Prefer cart_reminder_ig (Instagram reassurance + buttons); fall back to
      // cart_reminder if it isn't approved yet. Same 3 params either way.
      const waParams = [String(lead.customer_name || 'there').split(' ')[0], itemCount, amtRaw];
      let waRes = await sendWhatsApp({ to: lead.customer_phone, template: 'cart_reminder_ig', params: waParams });
      if (!waRes || !waRes.ok) {
        await sendWhatsApp({ to: lead.customer_phone, template: 'cart_reminder', params: waParams });
      }
      await supabase.from('abandoned_checkouts').update({ followup_whatsapp_clicked_at: new Date().toISOString() }).eq('id', id);
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('send-abandoned-email error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
