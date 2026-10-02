/**
 * POST /.netlify/functions/request-replacement
 *
 * Customer-initiated replacement on a delivered order. Creates a NEW order
 * in `orders` (free, status=`replacement_pending`, source=`replacement`,
 * linked back to the original via cart_items[0]._replacement). Notifies the
 * customer over email + WhatsApp and the store owner over email.
 *
 * Body:
 *   { original_order_id, reason, note, photos?, items?, q? }
 *     items:  optional [{title, qty}] — only these books are re-shipped
 *             (default: the whole order, as before)
 *     q:      the order's email or phone, for the logged-out Track Order page
 *     reason: one of REASONS below
 *     note:   required plaintext, max 500 chars
 *     photos: required array of base64 data-URLs (max 3, max 2 MB each).
 *             Uploaded to product-images bucket under replacement-photos/.
 *
 * Auth: the Supabase JWT (Authorization: Bearer <token>) of a user who owns
 * the order (email OR phone), or — from Track Order — `q`, the email/phone used
 * at checkout, checked the same way as track-order and report-missing-books.
 *
 * Guards:
 *   - original must be `delivered` (or recently shipped — store policy)
 *   - within REPLACEMENT_WINDOW_DAYS of delivery
 *   - only ONE replacement or missing-book request per original order (prevents repeat requests)
 */

const { beginClaim } = require('./utils/customer-claim');
const { createClient } = require('@supabase/supabase-js');
const { sendEmail }    = require('./utils/email');
const { sendWhatsApp } = require('./utils/whatsapp');
const { matchMissingItems } = require('./utils/missing-book-report');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type':                 'application/json',
};

const REPLACEMENT_WINDOW_DAYS = 7;
// What the customer can pick today: defective (misprint, missing/torn pages,
// binding, damaged) and wrong_book. A missing book goes to report-missing-books.
// The older ids stay accepted so a cached page still works.
const REASONS = new Set([
  'defective',       // misprint, missing/torn pages, binding fault, damaged copy
  'wrong_book',      // wrong title sent
  'damaged',         // legacy
  'missing_pages',   // legacy
  'missing_item',    // legacy
  'incomplete_set',  // legacy
  'other',           // legacy
]);
const REASON_LABEL = {
  defective: 'Defective book / misprint',
  wrong_book: 'Wrong book delivered',
  damaged: 'Damaged in transit',
  missing_pages: 'Missing/printing defect',
  missing_item: 'Item missing from package',
  incomplete_set: 'Incomplete combo set',
  other: 'Other',
};

function last10(p) { return String(p || '').replace(/\D/g, '').slice(-10); }
function json(code, body) { return { statusCode: code, headers: CORS, body: JSON.stringify(body) }; }

function buildOwnerEmailHtml(orig, repl, reasonLabel, note, photos) {
  const items = (repl.cart_items || orig.cart_items || []).map(i => `<li>${(i.title || 'Book').replace(/[<>]/g,'')} × ${i.qty || 1}</li>`).join('');
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
  // REQUIRED note. Enforced server-side as well as in the form so every
  // replacement request carries the customer's account of what went wrong.
  const cleanNote = String(note || '').trim().slice(0, 500);
  const MIN_NOTE = 10;
  if (cleanNote.length < MIN_NOTE) {
    return json(400, { error: `Please describe the problem (at least ${MIN_NOTE} characters) so we know what happened.` });
  }

  // ── Auth: signed-in customer, or the order's email/phone ────────────────
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const proof = String(body.q || '').trim();
  if (!token && !proof) return json(401, { error: 'Sign in, or enter the email or phone used on the order, to request a replacement' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let user = null;
  if (token) {
    try {
      const { data, error } = await sb.auth.getUser(token);
      if (error || !data?.user) throw error || new Error('no_user');
      user = data.user;
    } catch {
      return json(401, { error: 'Invalid session — sign in again' });
    }
  }
  const userEmail = user ? (user.email || '').toLowerCase() : '';
  const userPhone10 = user ? last10(user.user_metadata?.phone || user.phone || '') : '';

  // ── Fetch original order ─────────────────────────────────────────────────
  const cleanId = String(original_order_id).trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(cleanId)) return json(400, { error: 'Invalid order id' });

  let orig = null;
  {
    const { data } = await sb.from('orders').select('*')
      .eq('razorpay_order_id', cleanId).maybeSingle();
    orig = data || null;
  }
  if (!orig && /^IC-/i.test(cleanId)) {
    const { data } = await sb.from('orders').select('*').ilike('razorpay_order_id', cleanId).limit(1).maybeSingle();
    orig = data || null;
  }
  if (!orig && /^[0-9a-f-]{36}$/i.test(cleanId)) {
    const { data } = await sb.from('orders').select('*').eq('id', cleanId).maybeSingle();
    orig = data || null;
  }
  if (!orig) return json(404, { error: 'Order not found' });

  // Ownership
  let owns = false;
  if (user) {
    const ownsByEmail = userEmail && orig.customer_email && userEmail === orig.customer_email.toLowerCase();
    const ownsByPhone = userPhone10 && orig.customer_phone && userPhone10 === last10(orig.customer_phone);
    owns = !!(ownsByEmail || ownsByPhone);
  }
  if (!owns && proof) {
    const pn = proof.toLowerCase().replace(/\s+/g, '');
    const pd = last10(pn);
    owns = !!((orig.customer_email && orig.customer_email.toLowerCase().replace(/\s+/g, '') === pn)
      || (pd.length === 10 && orig.customer_phone && last10(orig.customer_phone) === pd));
  }
  if (!owns) return json(403, { error: user ? 'This order is not yours' : 'Email or phone does not match this order.' });

  // Status + window
  const status = String(orig.status || '').toLowerCase();
  if (status !== 'delivered') return json(400, { error: 'Replacements can only be requested after delivery' });
  if (!orig.delivered_at)     return json(400, { error: 'No delivery date on record — please contact support' });
  const ageMs = Date.now() - new Date(orig.delivered_at).getTime();
  const windowMs = REPLACEMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (ageMs > windowMs) return json(400, { error: `Replacement window (${REPLACEMENT_WINDOW_DAYS} days) has closed` });

  // Which books? Matched against the order itself; anything not on it is refused.
  let picked = null;
  if (Array.isArray(body.items) && body.items.length) {
    const requested = body.items.slice(0, 50)
      .map((m) => ({ title: String((m && m.title) || '').trim(), qty: Number.isFinite(Number(m && m.qty)) && Number(m.qty) > 0 ? Math.floor(Number(m.qty)) : null }))
      .filter((m) => m.title);
    const match = matchMissingItems(orig, requested);
    if (match.unmatched.length) return json(400, { error: 'These are not on this order: ' + match.unmatched.join(', ') });
    if (!match.valid.length) return json(400, { error: 'Choose the book(s) that need replacing.' });
    picked = match.valid.map((v) => ({ title: v.title, qty: v.qty }));
  }

  let claim;
  try { claim = await beginClaim(sb, orig, photos); }
  catch (error) { return json(error.statusCode || 503, { error: error.message }); }
  const photoUrls = claim.photos;

  // ── Build the replacement order row ──────────────────────────────────────
  const now = new Date();
  const datePart = now.toISOString().slice(0,10).replace(/-/g,'');
  const randPart = Math.random().toString(36).slice(2,7).toUpperCase();
  // R prefix = "this is a replacement" cue. Carry the CW marker forward if the
  // original was a Crossword-migrated genuine-tag order (IC-CW-…) so admin
  // filtering keeps working on the replacement too.
  const origIsCW = /^IC-CW-/i.test(String(orig.razorpay_order_id || ''));
  const replId = origIsCW
    ? `IC-R-CW-${datePart}-${randPart}`
    : `IC-R-${datePart}-${randPart}`;

  // Carry the original cart so warehouse knows what to re-ship. First item gets
  // a `_replacement` meta blob so the admin panel (and any downstream tooling)
  // can link back to the source order without a JOIN.
  // The report-missing-books stamps stay behind on the original. Copying them
  // onto the replacement makes the replacement look like a fresh report of a
  // book nobody is re-shipping, and the Missing Books tab would list it as
  // money owed. The original keeps its own record; this cart is just goods.
  let cartCopy = JSON.parse(JSON.stringify(Array.isArray(orig.cart_items) ? orig.cart_items : []))
    .map(({ _missing, _missing_at, _missing_qty, _missing_photos, _missing_comment, _refund_upi_id, _replacement, ...it }) => it);
  // Only the books the customer picked, at the quantity they picked (capped at
  // what was ordered). Metadata-only rows (no title) are dropped with the rest.
  if (picked) {
    const want = new Map(picked.map((p) => [p.title.toLowerCase(), p.qty]));
    cartCopy = cartCopy
      .filter((it) => want.has(String(it.title || it.name || '').trim().toLowerCase()))
      .map((it) => { const k = String(it.title || it.name || '').trim().toLowerCase(); const q = want.get(k); want.delete(k); return q ? { ...it, qty: q } : null; })
      .filter(Boolean);
    if (!cartCopy.length) return json(400, { error: 'Choose the book(s) that need replacing.' });
  }
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
    shipment_payment_type: 'prepaid',
    customer_name:       orig.customer_name || '',
    customer_email:      orig.customer_email || '',
    customer_phone:      orig.customer_phone || '',
    customer_address:    orig.customer_address || '',
    cart_items:          cartCopy,
    user_id:             (user && user.id) || orig.user_id || null,
    source:              'replacement',
  };

  const { data: inserted, error: insErr } = await sb.from('orders').insert(replRow).select().single();
  if (insErr) { await claim.release(); return json(500, { error: 'Failed to create replacement order: ' + insErr.message }); }
  await claim.complete();

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
