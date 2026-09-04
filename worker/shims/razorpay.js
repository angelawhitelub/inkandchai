/**
 * Razorpay SDK stand-in.
 *
 * The npm SDK is built on Node's `http` module, which does not exist on
 * Workers. create-order.js uses exactly one call — orders.create — so this
 * implements that against the REST API with fetch and keeps the same shape:
 * `new Razorpay({ key_id, key_secret })` then `await rzp.orders.create(...)`.
 *
 * This is on the money path. A failure must throw (never resolve with a
 * half-made order), and the thrown error keeps the SDK's `statusCode` and
 * `error.description` fields so existing catch blocks read the same.
 */
const API = 'https://api.razorpay.com/v1';

function authHeader(keyId, keySecret) {
  const raw = `${keyId}:${keySecret}`;
  const b64 = typeof btoa === 'function'
    ? btoa(raw)
    : Buffer.from(raw, 'utf8').toString('base64');
  return `Basic ${b64}`;
}

class RazorpayError extends Error {
  constructor(status, payload) {
    const desc = (payload && payload.error && payload.error.description) || `Razorpay HTTP ${status}`;
    super(desc);
    this.name = 'RazorpayError';
    this.statusCode = status;
    this.error = (payload && payload.error) || { description: desc };
  }
}

class Razorpay {
  constructor({ key_id, key_secret } = {}) {
    if (!key_id || !key_secret) throw new Error('Razorpay: key_id and key_secret are required');
    this._auth = authHeader(key_id, key_secret);

    this.orders = {
      create: (params) => this._post('/orders', params),
      fetch:  (id) => this._get(`/orders/${encodeURIComponent(id)}`),
    };

    this.payments = {
      fetch: (id) => this._get(`/payments/${encodeURIComponent(id)}`),
      refund: (id, params) => this._post(`/payments/${encodeURIComponent(id)}/refund`, params || {}),
    };
  }

  async _request(method, pathname, body) {
    const res = await fetch(API + pathname, {
      method,
      headers: {
        Authorization: this._auth,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }

    if (!res.ok) throw new RazorpayError(res.status, payload);
    return payload;
  }

  _post(pathname, body) { return this._request('POST', pathname, body); }
  _get(pathname) { return this._request('GET', pathname); }
}

module.exports = Razorpay;
module.exports.default = Razorpay;
