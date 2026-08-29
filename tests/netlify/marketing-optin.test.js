const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const gen = fs.readFileSync(path.join(root, 'generate_site.py'), 'utf8');
const toml = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');
const optin = require(path.join(root, 'netlify/functions/utils/marketing-optin.js'));

test('the consent box is not pre-ticked', () => {
  // A pre-ticked box is not consent. This is the single most important
  // property in the file: getting it wrong is what puts the business number's
  // quality rating -- and therefore the order/shipping messages -- at risk.
  const input = gen.match(/<input id="ch-wa-optin"[^>]*>/);
  assert.ok(input, 'the opt-in checkbox exists');
  assert.doesNotMatch(input[0], /\bchecked\b/);
});

test('consent reaches all three payment paths', () => {
  // COD, Razorpay and PhonePe each build their own payload; a customer who
  // ticks the box must be recorded whichever button they press.
  const matches = gen.match(/whatsapp_optin: addr\.whatsapp_optin/g) || [];
  assert.equal(matches.length, 3, 'all three checkout payloads carry the flag');
  assert.match(gen, /whatsapp_optin: !!document\.getElementById\('ch-wa-optin'\)\?\.checked/);
});

test('every order endpoint records the consent it receives', () => {
  for (const fn of ['cod-order', 'create-order', 'phonepe-create-order']) {
    const src = fs.readFileSync(path.join(root, `netlify/functions/${fn}.js`), 'utf8');
    assert.match(src, /recordMarketingOptIn/, `${fn} records consent`);
  }
});

test('an unticked box records nothing', async () => {
  // The absence of a flag must never be read as consent.
  const calls = [];
  const fakeSupabase = { from: () => { calls.push('touched'); throw new Error('should not be reached'); } };
  assert.equal(await optin.recordMarketingOptIn(fakeSupabase, '', 'checkout_cod'), false);
  assert.equal(await optin.recordMarketingOptIn(null, '9999999999', 'checkout_cod'), false);
  assert.equal(calls.length, 0, 'no write is attempted without a phone');
});

test('a failed consent write never breaks the order', async () => {
  // Losing a marketing opt-in is a rounding error; failing a paid order is not.
  const exploding = { from: () => ({ upsert: async () => ({ error: { message: 'table missing' } }) }) };
  assert.equal(await optin.recordMarketingOptIn(exploding, '9999999999', 'checkout_cod'), false);

  const throwing = { from: () => { throw new Error('connection refused'); } };
  assert.equal(await optin.recordMarketingOptIn(throwing, '9999999999', 'checkout_cod'), false);
});

test('consent is stored under the same key the broadcast filters on', async () => {
  // whatsapp-broadcast.js compares phoneKey(subscriber) against phoneKey(order).
  // If we stored a raw '+91 99999 99999' here, the subscriber would never match
  // and the campaign would silently reach nobody.
  const { phoneKey } = require(path.join(root, 'netlify/functions/utils/bot-optout.js'));
  let written = null;
  const spy = { from: () => ({ upsert: async (row) => { written = row; return { error: null }; } }) };
  assert.equal(await optin.recordMarketingOptIn(spy, '+91 99999 99999', 'checkout_cod'), true);
  assert.equal(written.customer_phone, phoneKey('+91 99999 99999'));
  assert.equal(written.status, 'subscribed');
  assert.equal(written.consent_source, 'checkout_cod');
});

test('re-ticking the box resubscribes instead of erroring', () => {
  // customer_phone is the primary key, so a repeat customer must upsert.
  const src = fs.readFileSync(path.join(root, 'netlify/functions/utils/marketing-optin.js'), 'utf8');
  assert.match(src, /\.upsert\(/);
  assert.match(src, /onConflict: 'customer_phone'/);
});

test('the campaign runs at 7 PM IST, outside marketing quiet hours', () => {
  const cron = toml.match(/\[functions\."whatsapp-broadcast-scheduled"\]\s*\n\s*schedule = "([^"]+)"/);
  assert.ok(cron, 'the campaign is scheduled');
  // 13:30 UTC = 19:00 IST. Netlify crons are UTC.
  assert.equal(cron[1], '30 13 * * 2,5');
});
