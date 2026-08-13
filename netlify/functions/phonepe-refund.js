/**
 * Netlify Function: phonepe-refund
 * POST /.netlify/functions/phonepe-refund
 *
 * Admin endpoint — issues a refund via PhonePe's current v2 Refund API for
 * orders with status='refund_pending' that have a PhonePe payment ID
 * (starts with "OM" or "T" — not Razorpay "pay_").
 *
 * Body: { order_id: "IC-20260530-U67JU" }  (razorpay_order_id / display ID)
 *
 * PhonePe Refund API (v2):
 *   POST {host}/pg/v1/refund          -- legacy v1 path, still registered
 *   POST {host}/pg/payments/v2/refund -- current v2 path
 *   Body: { merchantRefundId, originalMerchantOrderId, amount: <paise> }
 *   Auth: O-Bearer <oauth_token>
 *
 * The old path `/pg/checkout/v2/order/{id}/refund` returns
 * "Api Mapping Not Found" — that endpoint was never registered, the docs
 * were wrong / pre-release. Use /pg/payments/v2/refund with the order id
 * in the body as `originalMerchantOrderId`.
 */

const { createClient } = require('@supabase/supabase-js');
const { sendRefundInitiated, cleanRefundItems, rupees } = require('./utils/refund-notifications');
const { refundUtrFrom } = require('./utils/phonepe-core');
const { requireAdmin } = require('./utils/admin-auth');
const { refundIdForAttempt } = require('./utils/refund-id');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

let _tokenCache = { authorization: null, expiresAt: 0 };

function phonePeHeaders(authorization) {
  // Match the WORKING phonepe-create-order / verify-status / reconcile functions
  // EXACTLY: only Content-Type + Authorization. In PhonePe's OAuth v2 flow the
  // merchant is identified by the OAuth token itself — sending extra headers like
  // X-MERCHANT-ID (or the x-source-* SDK telemetry) causes the PG-V2 endpoints to
  // return "Authorization failed [Please check the authorization token]".
  return {
    'Content-Type': 'application/json',
    'Authorization': authorization,
  };
}

async function getAccessToken(host) {
  if (_tokenCache.authorization && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.authorization;
  }
  const body = new URLSearchParams({
    client_id: process.env.PHONEPE_CLIENT_ID,
    client_secret: process.env.PHONEPE_CLIENT_SECRET,
    client_version: process.env.PHONEPE_CLIENT_VERSION || '1',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`${host}/identity-manager/v1/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error('PhonePe OAuth failed: ' + (data.message || data.error || ('HTTP ' + res.status)));
  }
  // PhonePe's PG-V2 refund/status APIs ONLY accept the literal "O-Bearer" prefix,
  // even though identity-manager may return token_type=Bearer. Their official
  // Node SDK hardcodes this — mirror it. Using "Bearer" here yields
  // "Authorization failed [Please check the authorization token]".
  _tokenCache = {
    authorization: `O-Bearer ${data.access_token}`,
    expiresAt: data.expires_at ? data.expires_at * 1000 : Date.now() + (data.expires_in || 3300) * 1000,
  };
  return _tokenCache.authorization;
}

async function getRefundStatus(host, authorization, merchantRefundId) {
  const res = await fetch(
    `${host}/pg/payments/v2/refund/${encodeURIComponent(merchantRefundId)}/status`,
    {
      method: 'GET',
      headers: phonePeHeaders(authorization),
    }
  );
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS);
  if (_adminBlock) return _adminBlock;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const displayId = String(body.order_id || '').trim();
  if (!displayId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide order_id' }) };
  }

  const host = process.env.PHONEPE_HOST || 'https://api.phonepe.com/apis';

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data: order } = await supabase
      .from('orders')
      .select('*')
      .eq('razorpay_order_id', displayId)
      .maybeSingle();

    if (!order) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: `Order not found: ${displayId}` }) };
    }
    if (order.status === 'refunded') {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Order is already refunded.' }) };
    }

    const REFUNDABLE = ['paid', 'confirmed', 'shipped', 'out_for_delivery',
      'delivered', 'refund_pending', 'refund_failed', 'partially_refunded',
      'cancelled', 'rto', 'undelivered', 'lost'];
    if (!REFUNDABLE.includes(order.status)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Order status is '${order.status}' — not eligible for refund.` }) };
    }

    // These two were one branch, so an order with NO payment id at all was told
    // it "has a Razorpay payment" — which sent whoever read it to the wrong
    // dashboard looking for a transaction that was never there.
    const paymentId = order.razorpay_payment_id || '';
    if (paymentId.startsWith('pay_')) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'This order has a Razorpay payment — refund it with the Razorpay tool, not this one.' }) };
    }
    if (!paymentId) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'This order has no recorded gateway payment id, so there is nothing to refund against. Check the order in the gateway dashboard first.' }) };
    }

    const orderAmount = order.amount_paise;
    if (!orderAmount || orderAmount <= 0) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Order has no amount to refund.' }) };
    }

    if (order.status === 'partially_refunded') {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'A partial refund was already issued on this order — issue a remaining-balance refund directly in the PhonePe dashboard.' }) };
    }

    let amountPaise = orderAmount;
    if (body.amount_paise != null) amountPaise = Math.round(Number(body.amount_paise));
    else if (body.amount_rupees != null) amountPaise = Math.round(Number(body.amount_rupees) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid refund amount.' }) };
    }
    if (amountPaise > orderAmount) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Refund ₹${amountPaise / 100} exceeds order amount ₹${orderAmount / 100}.` }) };
    }
    const isFullRefund = amountPaise >= orderAmount;
    // Which books the admin ticked. Only meaningful on a partial — a full
    // refund covers everything, so naming a subset would be misleading.
    const refundItems = isFullRefund ? [] : cleanRefundItems(body.refund_items);

    // Attempt-derived, never clock-derived (utils/refund-id.js). A timestamp id
    // is unreconstructible, so a refund that completed under one became
    // invisible to every later check and the order looked unrefunded forever.
    const refundAttempt = Math.max(0, Number(order.refund_attempts) || 0);
    const merchantRefundId = refundIdForAttempt(displayId, refundAttempt);
    const authorization = await getAccessToken(host);

    const refundBody = {
      merchantRefundId,
      originalMerchantOrderId: displayId,
      amount: amountPaise,
    };
    const refundHeaders = phonePeHeaders(authorization);

    async function callRefund(path) {
      const r = await fetch(`${host}${path}`, {
        method: 'POST',
        headers: refundHeaders,
        body: JSON.stringify(refundBody),
      });
      const text = await r.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
      return { ok: r.ok, status: r.status, data };
    }

    let refundRes = await callRefund('/pg/payments/v2/refund');
    // If PhonePe rejected our auth (e.g. we handed out a cached bad-format token
    // from a warm Lambda), drop the cache and retry once with a fresh token.
    if (!refundRes.ok && /authorization|unauthori[sz]ed|invalid token/i.test(JSON.stringify(refundRes.data))) {
      console.warn('PhonePe rejected authorization — clearing token cache and retrying once');
      _tokenCache = { authorization: null, expiresAt: 0 };
      const freshAuth = await getAccessToken(host);
      const freshHeaders = phonePeHeaders(freshAuth);
      const r = await fetch(`${host}/pg/payments/v2/refund`, {
        method: 'POST', headers: freshHeaders, body: JSON.stringify(refundBody),
      });
      const text = await r.text();
      let d; try { d = text ? JSON.parse(text) : {}; } catch { d = { message: text }; }
      refundRes = { ok: r.ok, status: r.status, data: d };
    }
    if (!refundRes.ok && /api mapping not found/i.test(JSON.stringify(refundRes.data))) {
      console.warn('PhonePe v2 refund returned ApiMappingNotFound, falling back to v1');
      refundRes = await callRefund('/pg/v1/refund');
    }
    const refundData = refundRes.data;
    console.log('PhonePe refund response:', refundRes.status, JSON.stringify(refundData).slice(0, 400));

    // ── DIAGNOSTIC: if refund was rejected for auth, test the SAME token against
    // a read-only order-status call. If that succeeds, the token is valid and the
    // problem is refund-specific (PhonePe merchant refund API not enabled). If it
    // also 401s, the OAuth credentials themselves are wrong/unscoped. ──────────
    if (!refundRes.ok && /authorization|unauthori[sz]ed/i.test(JSON.stringify(refundData))) {
      try {
        const probe = await fetch(`${host}/pg/checkout/v2/order/${encodeURIComponent(displayId)}/status`, {
          method: 'GET', headers: phonePeHeaders(await getAccessToken(host)),
        });
        const ptext = (await probe.text()).slice(0, 200);
        console.log(`[PHONEPE-DIAG] Same token vs order-status → HTTP ${probe.status}: ${ptext}`);
        console.log(`[PHONEPE-DIAG] Verdict: ${probe.ok
          ? 'TOKEN VALID — refund is blocked at PhonePe (enable Refund API on the merchant / check MID scope).'
          : 'TOKEN REJECTED EVERYWHERE — PHONEPE_CLIENT_ID/SECRET are wrong or not the production PG keys.'}`);
      } catch (e) {
        console.log('[PHONEPE-DIAG] probe error:', e.message);
      }
    }

    if (!refundRes.ok) {
      const looksRetryable = refundRes.status === 409 ||
        /duplicate|already|exists/i.test(
          `${refundData.message || ''} ${refundData.error || ''} ${refundData.errorCode || ''}`
        );
      if (looksRetryable) {
        const statusCheck = await getRefundStatus(host, authorization, merchantRefundId);
        if (statusCheck.ok) {
          const state = String(statusCheck.data?.state || '').toUpperCase();
          if (state && state !== 'FAILED') {
            const dbStatus = state === 'COMPLETED'
              ? (isFullRefund ? 'refunded' : 'partially_refunded')
              : 'refund_pending';
            await supabase
              .from('orders')
              .update({ status: dbStatus, razorpay_payment_id: paymentId })
              .eq('id', order.id);
            return {
              statusCode: 200,
              headers: CORS,
              body: JSON.stringify({
                success: true,
                refund_id: merchantRefundId,
                phonepe_refund_id: statusCheck.data?.refundId || null,
                state,
                amount: `₹${rupees(amountPaise)}`,
                is_full: isFullRefund,
                message: `${isFullRefund ? 'Full refund' : 'Partial refund'} of ₹${rupees(amountPaise)} is ${state.toLowerCase()} at PhonePe.`,
              }),
            };
          }
        }
      }

      const failMsg = refundData.message || refundData.error || refundData.errorCode ||
        `PhonePe refund API returned HTTP ${refundRes.status}: ${JSON.stringify(refundData).slice(0, 200)}`;
      // Record the failure so the scheduled retry job re-attempts it later.
      await supabase.from('orders').update({
        status: 'refund_failed', refund_id: merchantRefundId, refund_state: 'FAILED',
        refund_attempts: (Number(order.refund_attempts) || 0) + 1,
        refund_last_error: String(failMsg).slice(0, 300),
        refund_updated_at: new Date().toISOString(),
      }).eq('id', order.id).then(() => {}, () => {});
      throw new Error(failMsg);
    }

    let refundState = String(refundData.state || refundData.status || '').toUpperCase();
    const phonePeRefundId = refundData.refundId || null;

    // PhonePe's refund POST almost always returns PENDING even when the refund
    // actually completes within a few seconds. If we stopped here, the customer
    // notification would be deferred to the hourly reconcile job (1–6 PM IST) —
    // so an admin issuing a refund sees "nothing sent". Poll the refund status a
    // few times right here to catch the common fast-completing case and notify
    // immediately. MONEY-SAFE: we only ever promote to COMPLETED/FAILED on a
    // CONFIRMED state from PhonePe; a refund still PENDING after this short window
    // stays 'refund_pending' and the scheduled reconcile job confirms + notifies.
    // The UTR is the bank-visible reference for this refund and is what the
    // customer is told to quote. It only exists once PhonePe has actually moved
    // the money, so it comes from the status payload, never from the POST reply.
    let refundUtr = refundUtrFrom(refundData);
    if (refundState !== 'COMPLETED' && refundState !== 'FAILED') {
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const poll = await getRefundStatus(host, authorization, merchantRefundId).catch(() => null);
        refundUtr = refundUtrFrom(poll?.data) || refundUtr;
        const st = String(poll?.data?.state || '').toUpperCase();
        if (st === 'COMPLETED') { refundState = 'COMPLETED'; break; }
        if (st === 'FAILED')    { refundState = 'FAILED'; break; }
      }
    }

    if (refundState === 'FAILED') {
      // Mark it refund_failed + record the id/error so the scheduled retry job
      // re-attempts it once the merchant balance replenishes (PhonePe fails a
      // refund when the day's refunds exceed the day's received payments).
      await supabase.from('orders').update({
        status: 'refund_failed', refund_id: merchantRefundId, refund_state: 'FAILED',
        refund_attempts: (Number(order.refund_attempts) || 0) + 1,
        refund_last_error: String(refundData.message || 'PhonePe rejected the refund').slice(0, 300),
        refund_updated_at: new Date().toISOString(),
      }).eq('id', order.id).then(() => {}, () => {});
      throw new Error('PhonePe rejected the refund: ' + (refundData.message || JSON.stringify(refundData).slice(0, 200)));
    }

    const nextStatus = refundState === 'COMPLETED'
      ? (isFullRefund ? 'refunded' : 'partially_refunded')
      : 'refund_pending';
    const updatePayload = {
      status: nextStatus, razorpay_payment_id: paymentId,
      // Persist the refund id + state so the scheduled retry job can re-check
      // this refund precisely (a PENDING refund can fail asynchronously later).
      // NOTE: refund_id MUST stay our merchantRefundId — it's the lookup key for
      // getRefundStatus and hence the double-refund guard. PhonePe's own
      // reference goes in phonepe_refund_id (what a customer quotes to a bank).
      refund_id: merchantRefundId, refund_state: refundState || 'PENDING',
      // Count this attempt even on success: the id is derived from the attempt
      // number, so leaving it unincremented would make the next refund on this
      // order reuse an id PhonePe has already seen.
      refund_attempts: refundAttempt + 1,
      refund_updated_at: new Date().toISOString(),
    };
    if (phonePeRefundId) updatePayload.phonepe_refund_id = phonePeRefundId;
    if (refundUtr) updatePayload.refund_utr = refundUtr;
    // Persist WHICH books this partial covers. A PhonePe partial often comes
    // back PENDING and is only confirmed hours later by the retry job, which
    // has no access to this request — without storing it, that notification
    // could only quote an amount.
    if (refundItems.length) updatePayload.refund_items = refundItems;

    // Resilience: two of these columns come from migrations that may not have
    // been run on this database yet. Drop whichever one Postgres complains about
    // and retry, rather than losing the refund status update — that record is
    // what the retry job and the double-refund guard both read.
    // Loops because more than one can be missing at once.
    {
      let payload = updatePayload;
      const MIGRATION_HINT = {
        phonepe_refund_id: 'sql/orders_phonepe_refund_id.sql',
        refund_items: 'sql/refund_partial_notifications.sql',
        refund_utr: 'sql/orders_refund_utr.sql',
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        const { error } = await supabase.from('orders').update(payload).eq('id', order.id);
        if (!error) break;
        const missing = Object.keys(MIGRATION_HINT).find(
          col => col in payload && new RegExp(col, 'i').test(error.message || ''));
        if (!missing) { console.error('[phonepe-refund] order update failed:', error.message); break; }
        console.warn(`[phonepe-refund] ${missing} column missing — run ${MIGRATION_HINT[missing]}`);
        const { [missing]: _dropped, ...rest } = payload;
        payload = rest;
      }
    }

    // Notify the customer ONLY when PhonePe has CONFIRMED the refund COMPLETED.
    // PhonePe frequently returns PENDING and then FAILS the refund asynchronously
    // (merchant-balance policy) — so a PENDING refund must NOT trigger any "refund
    // issued" message, or we promise money that never arrives. While it is still
    // pending, the scheduled retry/reconcile job sends the notification once the
    // refund actually completes. Dedup-guarded by refund_notified_at.
    if (nextStatus !== 'refund_pending') {
      // sendRefundInitiated is the ONLY customer email here now. It used to be
      // followed by a second "Refund processed" mail from this file, so every
      // refund sent two — and they disagreed, one promising 2–3 business days
      // and the other 5–7. The surviving one is itemised and partial-aware.
      await sendRefundInitiated(order, amountPaise, {
        // UTR first: it is the only reference the customer's bank can trace.
        supabase, state: refundState, refundRef: refundUtr || phonePeRefundId, items: refundItems,
      }).catch(e => console.error('refund-initiated notify:', e.message));
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        refund_id: merchantRefundId,
        phonepe_refund_id: phonePeRefundId,
        refund_utr: refundUtr || null,
        state: refundState || 'PENDING',
        amount: `₹${rupees(amountPaise)}`,
        is_full: isFullRefund,
        message: nextStatus === 'refunded'
          ? `Full refund of ₹${rupees(amountPaise)} completed.`
          : nextStatus === 'partially_refunded'
            ? `Partial refund of ₹${rupees(amountPaise)} completed.`
          : `Refund of ₹${rupees(amountPaise)} accepted by PhonePe and is ${String(refundState || 'PENDING').toLowerCase()}.`,
      }),
    };
  } catch (err) {
    console.error('phonepe-refund error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
