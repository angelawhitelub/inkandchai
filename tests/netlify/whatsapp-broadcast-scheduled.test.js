const test = require('node:test');
const assert = require('node:assert/strict');

test('scheduled campaign skips safely until template is configured', async () => {
  const oldTemplate = process.env.WHATSAPP_BROADCAST_TEMPLATE;
  delete process.env.WHATSAPP_BROADCAST_TEMPLATE;
  try {
    const { handler } = require('../../netlify/functions/whatsapp-broadcast-scheduled');
    const response = await handler();
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).skipped, true);
  } finally {
    if (oldTemplate === undefined) delete process.env.WHATSAPP_BROADCAST_TEMPLATE;
    else process.env.WHATSAPP_BROADCAST_TEMPLATE = oldTemplate;
  }
});

test('scheduled campaign enqueues the authenticated background worker', async () => {
  const keys = ['WHATSAPP_BROADCAST_TEMPLATE', 'ADMIN_SECRET', 'URL'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const oldFetch = global.fetch;
  process.env.WHATSAPP_BROADCAST_TEMPLATE = 'broadcast_product_offer_v1';
  process.env.ADMIN_SECRET = 'secret';
  process.env.URL = 'https://example.netlify.app';
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok:true, status:202, text:async () => '' };
  };
  try {
    const { handler } = require('../../netlify/functions/whatsapp-broadcast-scheduled');
    const response = await handler();
    const body = JSON.parse(request.options.body);
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).queued, true);
    assert.equal(request.url, 'https://example.netlify.app/.netlify/functions/whatsapp-broadcast-run-background');
    assert.equal(request.options.headers['x-admin-key'], 'secret');
    assert.equal(body.rich_media, true);
    assert.equal(body.require_opt_in, true);
    assert.equal(body.source, 'scheduled');
  } finally {
    global.fetch = oldFetch;
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
});
