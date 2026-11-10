/**
 * Netlify Function: email-unsubscribe   (PUBLIC, behind a signed link)
 *
 *   GET  ?e=<base64url address>&t=<token>  -> a page with one "Unsubscribe" button
 *   POST same query                        -> records the unsubscribe, says so
 *
 * GET never unsubscribes: mail scanners and link previews fetch every link in
 * an email, and they would quietly unsubscribe people who never clicked.
 * The token is an HMAC over the address (utils/email-unsub), so only the
 * person we emailed can unsubscribe that address.
 *
 * Covers marketing emails only (new-title alerts). Order and delivery emails
 * still arrive.
 */
const U = require('./utils/email-unsub');

const page = (title, inner) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Ink &amp; Chai</title><meta name="robots" content="noindex">
<style>body{margin:0;background:#f7f3ec;color:#2b2118;font:16px/1.6 Georgia,serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
.card{background:#fff;border:1px solid #e6dccb;border-radius:14px;max-width:440px;width:100%;padding:28px;text-align:center}
h1{font-weight:400;font-size:22px;margin:0 0 10px}p{color:#6b5a48;margin:0 0 18px}
button{background:#2b2118;color:#fff;border:0;border-radius:10px;padding:12px 22px;font:inherit;cursor:pointer}
a{color:#8a6a2f}</style></head><body><div class="card">${inner}</div></body></html>`,
});

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

exports.handler = async (event = {}) => {
  const q = event.queryStringParameters || {};
  let email = '';
  try { email = Buffer.from(String(q.e || ''), 'base64url').toString('utf8'); } catch { email = ''; }
  if (!U.isEmail(email) || !U.verifyEmail(email, q.t)) {
    return page('Link not valid', '<h1>This link is not valid</h1><p>It may have been cut short. Reply to any of our emails and we will take you off the list.</p><p><a href="https://inkandchai.in/">Ink &amp; Chai</a></p>');
  }
  if (event.httpMethod === 'POST') {
    try {
      await U.markUnsubscribed(email);
    } catch (e) {
      console.error('[email-unsubscribe]', e.message);
      return page('Try again', '<h1>Something went wrong</h1><p>We could not save that just now. Please try again in a minute.</p>');
    }
    return page('Unsubscribed', `<h1>You're unsubscribed</h1><p>${esc(U.normEmail(email))} will not get new-book emails from us any more. Order and delivery updates still come through.</p><p><a href="https://inkandchai.in/">Back to Ink &amp; Chai</a></p>`);
  }
  const action = `?e=${encodeURIComponent(q.e)}&t=${encodeURIComponent(q.t)}`;
  return page('Unsubscribe', `<h1>Stop new-book emails?</h1><p>${esc(U.normEmail(email))} will no longer get emails about new books. Order and delivery updates still come through.</p>
<form method="post" action="${esc(action)}"><button type="submit">Unsubscribe</button></form>`);
};
