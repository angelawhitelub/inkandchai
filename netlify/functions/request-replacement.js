/**
 * POST /.netlify/functions/request-replacement
 *
 * Customer-initiated replacement on a delivered order. Creates a NEW order
 * in `orders` (free, status=`replacement_pending`, source=`replacement`,
 * linked back to the original via cart_items[0]._replacement). Notifies the
 * customer over email + WhatsApp and the store owner over email.
 *
 * Body:
 *   { original_order_id, reason, note?, photos? }
 *     reason: one of REASONS below
 *     note:   optional plaintext, max 500 chars
 *     photos: optional array of base64 data-URLs (max 3, max 2 MB each).
 *             Uploaded to product-images bucket under replacement-photos/.
 *
 * Auth: requires the Supabase JWT (Authorization: Bearer <token>) — the
 * authed user must own the original order (match by email OR phone).
 *
 * Guards:
 *   - original must be `delivered` (or recently shipped — store policy)
 *   - within REPLACEMENT_WINDOW_DAYS of delivery
 *   - only ONE replacement per original (prevents abuse)
 */

const { createClient } = require('@supabase/supabase-js');
const { sendEmail }    = require('./utils/email');
const { sendWhatsApp } = require('./utils/whatsapp');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type':                 'application/json',
};

const REPLACEMENT_WINDOW_DAYS = 7;
const REASONS = new Set([
  'damaged',         // delivered damaged
  'wrong_book',      // wrong title sent
  'missing_pages',   // print/binding defect
  'missing_item',    // multi-book order, one missing
  'incomplete_set',  // combo pack, partial
  'other',
]);
const REASON_LABEL = {
  damaged: 'Damaged in transit',
  wrong_book: 'Wrong book delivered',
  missing_pages: 'Missing/printing defect',
  missing_item: 'Item missing from package',
  incomplete_set: 'Incomplete combo set',
  other: 'Other',
};

function last10(p) { return String(p || '').replace(/\D/g, '').slice(-10); }
function json(code, body) { return { statusCode: code, headers: CORS, body: JSON.stringify(body) }; }

async function uploadPhoto(sb, dataUrl, slugPrefix) {
  const m = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/i);
  if (!m) return null;
  const ct = m[1].toLowerCase();
  const ext = ct === 'image/png' ? 'png' : ct === 'image/webp' ? 'webp' : 'jpg';
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 200 || buf.length > 2_000_000) return null;       // 200B–2MB
  const path = `replacement-photos/${slugPrefix}-${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`;
  const up = await sb.storage.from('product-images').upload(path, buf, { contentType: ct, upsert: false });
  if (up.error) return null;
  return sb.storage.from('product-images').getPublicUrl(path).data.publicUrl;
}

function buildOwnerEmailHtml(orig, repl, reasonLabel, note, photos) {
  const items = (orig.cart_items || []).map(i => `<li>${(i.title || 'Book').replace(/[<>]/g,'')} × ${i.qty || 1}</li>`).join('');
  const photoHtml = (photos || []).slice(0,3).map(u => `<a href="${u}" target="_blank"><img src="${u}" style="max-width:140px;border:1px solid #2a2a2a;margin-right:6px;margin-top:6px;"/></a>`).join('');
  return `<div style="font-family:Georgia,serif;color:#f0e8d8;background:#0d0b08;padding:24px;max-width:560px;margin:0 auto;">
    <h2 style="color:#c9a84c;font-weight:400;margin:0 0 8px;">🔄 Replacement requested</h2>
    <p style="color:#a09080;font-size:13px;margin:0 0 16px;">
      Original: <strong style="color:#c9a84c;">${orig.razorpay_order_id}</strong> &nbsp;·&nbsp;
      Replacement: <strong style="color:#c9a84c;">${repl.razorpay_order_id}</strong>
    </p>
    <table style="font-size:13px;line-height:1.7;color:#f0e8d8;border-collapse:collapse;width:100%;">
      <tr><td style="color:#a09080;padding:4px 12px 4px 0;width:120px;">Customer</td><td>${(orig.customer_name||'').replace(/[<>]/g,'')}</td></tr>
      <tr><td style="color:#a09080;padding:4px 12px 4px 0;">Phone</td><td>${(orig.customer_phone||'').replace(/[<>]/g,'')}</td></tr>
      <tr><td style="color:#a09080;padding:4px 12px 4px 0;">Email</td><td>${(orig.customer_email||'').replace(/[<>]/g,'')}</td></tr>
      <tr><td style="color:#a09080;padding:4px 12px 4px 0;">Address</td><td>${(orig.customer_address||'').replace(/[<>]/g,'')}</td></tr>
      <tr><td style="color:#a09080;padding:4px 12px 4px 0;">Reason</td><td><strong style="color:#c9a84c;">${reasonLabel}</strong></td></tr>
      ${note ? `<tr><td style="color:#a09080;padding:4px 12px 4px 0;vertical-align:top;">Note</td><td style="white-space:pre-wrap;">${note.replace(/[<>]/g,'')}</td></tr>` : ''}
    </table>
    <p style="color:#a09080;font-size:13px;margin:16px 0 6px;">Items to ship as replacement:</p>
    <ul style="color:#f0e8d8;font-size:13px;margin:0;padding-left:18px;">${items}</ul>
    ${photoHtml ? `<p style="color:#a09080;font-size:13px;margin:14px 0 4px;">Customer photos:</p>${photoHtml}` : ''}
    <p style="color:#7a6330;font-size:11px;margin-top:22px;">Free replacement — no charge to customer. Push to NimbusPost when ready.</p>
  </div>`;
}

function buildCustomerEmailHtml(orig, repl, reasonLabel) {
  return `<div style="font-family:Georgia,serif;color:#f0e8d8;background:#0d0b08;padding:24px;max-width:560px;margin:0 auto;">
    <h2 style="color:#c9a84c;font-weight:400;margin:0 0 8px;">Replacement order confirmed 📦</h2>
    <p style="color:#a09080;line-height:1.7;font-size:14px;">
      Hi ${(orig.customer_name||'there').split(' ')[0].replace(/[<>]/g,'')},<br/>
      We've created a free replacement for your order <strong style="color:#c9a84c;">${orig.razorpay_order_id}</strong>.
      Reason: <em>${reasonLabel}</em>.
    </p>
    <p style="color:#a09080;line-height:1.7;font-size:14px;">
      Your replacement order ID is <strong style="color:#c9a84c;">${repl.razorpay_order_id}</strong>.
      We'll ship the new copy from our warehouse — you'll receive a tracking email as soon as the courier collects it (typically within 1–2 working days).
    </p>
    <p style="color:#a09080;line-height:1.7;font-size:14px;">
      <strong>Keep the original book/packaging</strong> until you receive the replacement, in case our team needs to inspect it.
    </p>
    <p style="color:#7a6330;font-size:11px;margin-top:18px;">Ink & Chai · inkandchai.in · Reply to this email for support.</p>
  </div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return json(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const { original_order_id, reason, note, photos } = body;
  if (!original_order_id || !reason) return json(400, { error: 'original_order_id and reason are required' });
  if (!REASONS.has(reason))          return json(400, { error: 'Invalid reason' });
  const cleanNote = String(note || '').trim().slice(0, 500);

  // ── Auth: signed-in customer only ────────────────────────────────────────
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return json(401, { error: 'Sign in to request a replacement' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let user;
  try {
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data?.user) throw error || new Error('no_user');
    user = data.user;
  } catch {
    return json(401, { error: 'Invalid session — sign in again' });
  }
  const userEmail = (user.email || '').toLowerCase();
  const userPhone10 = last10(user.user_metadata?.phone || user.phone || '');

  // ── Fetch original order ─────────────────────────────────────────────────
  const cleanId = String(original_order_id).trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(cleanId)) return json(400, { error: 'Invalid order id' });

  let orig = null;
  {
    const { data } = await sb.from('orders').select('*')
      .eq('razorpay_order_id', cleanId).maybeSingle();
    orig = data || null;
  }
  if (!orig && /^[0-9a-f-]{36}$/i.test(cleanId)) {
    const { data } = await sb.from('orders').select('*').eq('id', cleanId).maybeSingle();
    orig = data || null;
  }
  if (!orig) return json(404, { error: 'Order not found' });

  // Ownership
  const ownsByEmail = userEmail && orig.customer_email && userEmail === orig.customer_email.toLowerCase();
  const ownsByPhone = userPhone10 && orig.customer_phone && userPhone10 === last10(orig.customer_phone);
  if (!ownsByEmail && !ownsByPhone) return json(403, { error: 'This order is not yours' });

  // Status + window
  const status = String(orig.status || '').toLowerCase();
  if (status !== 'delivered') return json(400, { error: 'Replacements can only be requested after delivery' });
  if (!orig.delivered_at)     return json(400, { error: 'No delivery date on record — please contact support' });
  const ageMs = Date.now() - new Date(orig.delivered_at).getTime();
  const windowMs = REPLACEMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (ageMs > windowMs) return json(400, { error: `Replacement window (${REPLACEMENT_WINDOW_DAYS} days) has closed` });

  // Only one replacement per original
  const { data: prior } = await sb.from('orders')
    .select('razorpay_order_id').eq('source', 'replacement')
    .ilike('cart_items', `%${orig.razorpay_order_id}%`).limit(1);
  if (prior && prior.length) {
    return json(409, { error: 'A replacement was already created for this order: ' + prior[0].razorpay_order_id });
  }

  // ── Upload photos (best-effort) ──────────────────────────────────────────
  const photoUrls = [];
  if (Array.isArray(photos) && photos.length) {
    for (const p of photos.slice(0, 3)) {
      const u = await uploadPhoto(sb, p, orig.razorpay_order_id);
      if (u) photoUrls.push(u);
    }
  }

  // ── Build the replacement order row ──────────────────────────────────────
  const now = new Date();
  const datePart = now.toISOString().slice(0,10).replace(/-/g,'');
  const randPart = Math.random().toString(36).slice(2,7).toUpperCase();
  // R prefix in the id segment is the at-a-glance "this is a replacement" cue
  // in the admin panel and in customer emails.
  const replId = `IC-R-${datePart}-${randPart}`;

  // Carry the original cart so warehouse knows what to re-ship. First item gets
  // a `_replacement` meta blob so the admin panel (and any downstream tooling)
  // can link back to the source order without a JOIN.
  const cartCopy = JSON.parse(JSON.stringify(Array.isArray(orig.cart_items) ? orig.cart_items : []));
  if (cartCopy.length) {
    cartCopy[0]._replacement = {
      original_order_id: orig.razorpay_order_id,
      reason,
      reason_label: REASON_LABEL[reason] || reason,
      note: cleanNote,
      photos: photoUrls,
      requested_at: now.toISOString(),
    };
  }

  const replRow = {
    razorpay_order_id:   replId,
    razorpay_payment_id: null,
    amount_paise:        0,              // free
    status:              'replacement_pending',
    customer_name:       orig.customer_name || '',
    customer_email:      orig.customer_email || '',
    customer_phone:      orig.customer_phone || '',
    customer_address:    orig.customer_address || '',
    cart_items:          cartCopy,
    user_id:             user.id,
    source:              'replacement',
  };

  const { data: inserted, error: insErr } = await sb.from('orders').insert(replRow).select().single();
  if (insErr) return json(500, { error: 'Failed to create replacement order: ' + insErr.message });

  // ── Notifications (non-fatal) ────────────────────────────────────────────
  const reasonLabel = REASON_LABEL[reason] || reason;
  const owner = process.env.STORE_OWNER_EMAIL;
  if (owner) {
    sendEmail({
      to: owner,
      subject: `🔄 Replacement requested — ${orig.razorpay_order_id} → ${replId} (${reasonLabel})`,
      html: buildOwnerEmailHtml(orig, inserted, reasonLabel, cleanNote, photoUrls),
    }).catch(e => console.error('[replacement] owner email:', e.message));
  }
  if (orig.customer_email) {
    sendEmail({
      to: orig.customer_email,
      subject: `Replacement order confirmed — ${replId}`,
      html: buildCustomerEmailHtml(orig, inserted, reasonLabel),
    }).catch(e => console.error('[replacement] customer email:', e.message));
  }
  if (orig.customer_phone) {
    sendWhatsApp({
      to: orig.customer_phone,
      template: 'replacement_confirmed',
      params: [
        (orig.customer_name || 'there').split(' ')[0],
        replId,
        orig.razorpay_order_id,
        reasonLabel,
      ],
    }).catch(e => console.error('[replacement] whatsapp:', e.message));
  }

  return json(200, {
    success: true,
    replacement_order_id: replId,
    original_order_id: orig.razorpay_order_id,
    message: 'Replacement created — you will receive an email + WhatsApp confirmation shortly.',
  });
};
