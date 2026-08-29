const test = require('node:test');
const assert = require('node:assert/strict');

const { sendWhatsApp } = require('../../netlify/functions/utils/whatsapp');
const { _internal } = require('../../netlify/functions/whatsapp-broadcast');

test('marketing template uses MM API with an image header and dynamic product button', async () => {
  const oldToken = process.env.WHATSAPP_TOKEN;
  const oldFetch = global.fetch;
  process.env.WHATSAPP_TOKEN = 'test-token';
  let payload, requestedUrl;
  global.fetch = async (url, options) => {
    requestedUrl = url;
    payload = JSON.parse(options.body);
    return { ok:true, status:200, json:async () => ({ messages:[{ id:'wamid.test' }] }) };
  };
  try {
    const result = await sendWhatsApp({
      to:'9999999999', template:'broadcast_product_offer_v1',
      params:['Asha', 'romance books', 'Book link', 'Use SAVE12'],
      headerImageUrl:'https://inkandchai.in/images/book.webp',
      urlButtonParam:'book-slug',
      marketing:true,
    });
    assert.equal(result.ok, true);
    assert.match(requestedUrl, /\/marketing_messages$/);
    assert.deepEqual(payload.template.components[0], {
      type:'header', parameters:[{ type:'image', image:{ link:'https://inkandchai.in/images/book.webp' } }],
    });
    assert.equal(payload.template.components[2].parameters[0].text, 'book-slug');
  } finally {
    global.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.WHATSAPP_TOKEN;
    else process.env.WHATSAPP_TOKEN = oldToken;
  }
});

test('transactional templates remain on the standard Cloud API endpoint', async () => {
  const oldToken = process.env.WHATSAPP_TOKEN;
  const oldFetch = global.fetch;
  process.env.WHATSAPP_TOKEN = 'test-token';
  let requestedUrl;
  global.fetch = async url => {
    requestedUrl = url;
    return { ok:true, status:200, json:async () => ({ messages:[{ id:'wamid.order' }] }) };
  };
  try {
    const result = await sendWhatsApp({
      to:'9999999999', template:'order_confirmed', params:['IC-123'],
    });
    assert.equal(result.ok, true);
    assert.match(requestedUrl, /\/messages$/);
    assert.doesNotMatch(requestedUrl, /\/marketing_messages$/);
  } finally {
    global.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.WHATSAPP_TOKEN;
    else process.env.WHATSAPP_TOKEN = oldToken;
  }
});

test('recommendation copy includes price, markdown saving, and product link', () => {
  const line = _internal.formatBookLine({
    title:'A Very Good Book', price_inr:'299', original_price_inr:'599',
    url:'/product/a-very-good-book/',
  });
  assert.match(line, /₹299/);
  assert.match(line, /50% off MRP/);
  assert.match(line, /https:\/\/inkandchai\.in\/product\/a-very-good-book\//);
});

test('promotion copy chooses the strongest live prepaid offer', () => {
  const now = new Date('2026-08-29T06:00:00Z');
  const label = _internal.promotionLabel([
    { code:'SAVE10', discount_type:'percent', discount_value:10, min_subtotal_inr:499, payment_methods:['prepaid'], status:'active' },
    { code:'SAVE15', discount_type:'percent', discount_value:15, min_subtotal_inr:999, payment_methods:['prepaid'], status:'active' },
    { code:'OLD20', discount_type:'percent', discount_value:20, payment_methods:['prepaid'], status:'ended' },
  ], now);
  assert.equal(label, 'Use SAVE15 for 15% off on prepaid orders above ₹999.');
});

test('relative catalog images become public HTTPS URLs', () => {
  assert.equal(
    _internal.absoluteImageUrl({ image_url:'/images/cover.webp' }),
    'https://inkandchai.in/images/cover.webp',
  );
});
