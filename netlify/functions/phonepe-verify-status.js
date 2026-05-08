/**
 * Netlify Function: phonepe-verify-status
 * GET /.netlify/functions/phonepe-verify-status?id=<orderId>
 *
 * PhonePe redirects the customer here after payment. We:
 *   1. Call PhonePe's /pg/v1/status/{merchantId}/{orderId} to get the
 *      authoritative status (don't trust query string params alone).
 *   2. Look at the result and 302 the customer to:
 *        - /checkout/success/?id=<orderId>   on COMPLETED
 *        - /checkout/?failed=1&id=<orderId>  on FAILED/CANCELLED
 *
 * The webhook (separate function) does the actual database update +
 * email — this function only handles the customer-visible redirect.
 */

const crypto = require('crypto');

exports.handler = async (event) => {
  const id = event.queryStringParameters?.id;
  const siteUrl = process.env.SITE_URL || 'https://inkandchai.in';

  if (!id) {
    return { statusCode: 302, headers: { Location: siteUrl + '/checkout/?failed=1' }, body: '' };
  }

  const merchantId = process.env.PHONEPE_MERCHANT_ID;
  const saltKey    = process.env.PHONEPE_SALT_KEY;
  const saltIndex  = process.env.PHONEPE_SALT_INDEX || '1';
  const host       = process.env.PHONEPE_HOST || 'https://api.phonepe.com/apis/hermes';

  if (!merchantId || !saltKey) {
    console.error('PhonePe credentials missing');
    return { statusCode: 302, headers: { Location: siteUrl + '/checkout/?failed=1&id=' + encodeURIComponent(id) }, body: '' };
  }

  // X-VERIFY for status endpoint = SHA256(/pg/v1/status/{mid}/{txn} + saltKey) + ### + saltIndex
  const path = `/pg/v1/status/${merchantId}/${id}`;
  const xVerify = crypto.createHash('sha256').update(path + saltKey).digest('hex') + '###' + saltIndex;

  try {
    const res = await fetch(host + path, {
      headers: {
        'Content-Type': 'application/json',
        'X-VERIFY': xVerify,
        'X-MERCHANT-ID': merchantId,
      },
    });
    const data = await res.json().catch(() => ({}));
    const code = data.code || data.data?.responseCode || '';

    if (code === 'PAYMENT_SUCCESS' || data.data?.state === 'COMPLETED') {
      return {
        statusCode: 302,
        headers: { Location: `${siteUrl}/checkout/?paid=1&id=${encodeURIComponent(id)}` },
        body: '',
      };
    }
    return {
      statusCode: 302,
      headers: { Location: `${siteUrl}/checkout/?failed=1&id=${encodeURIComponent(id)}&code=${encodeURIComponent(code)}` },
      body: '',
    };
  } catch (err) {
    console.error('PhonePe status verify error:', err);
    return {
      statusCode: 302,
      headers: { Location: `${siteUrl}/checkout/?failed=1&id=${encodeURIComponent(id)}` },
      body: '',
    };
  }
};
