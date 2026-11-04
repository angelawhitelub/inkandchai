const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('./order-cover');

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer;
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer;
const answer = (body, ok = true) => async () => ({ ok, arrayBuffer: async () => body });
const PARAMS = ['Asha', 'IC-1', '₹549', 'Delhi', 'Ikigai'];
const CART = [{ title: 'No cover' }, { title: 'Ikigai', img: '/images/ikigai.webp' }];
const IMAGE = 'order_confirmed_image';

function recorder({ failImage = false } = {}) {
  const sent = [];
  return { sent, sendWhatsApp: async (m) => {
    sent.push(m);
    if (failImage && m.headerImageUrl) throw new Error('template not approved');
    return { ok: true };
  } };
}
async function withTemplate(name, fn) {
  const was = process.env.WHATSAPP_ORDER_CONFIRMED_IMAGE_TEMPLATE;
  if (name) process.env.WHATSAPP_ORDER_CONFIRMED_IMAGE_TEMPLATE = name;
  else delete process.env.WHATSAPP_ORDER_CONFIRMED_IMAGE_TEMPLATE;
  try { await fn(); } finally {
    if (was === undefined) delete process.env.WHATSAPP_ORDER_CONFIRMED_IMAGE_TEMPLATE;
    else process.env.WHATSAPP_ORDER_CONFIRMED_IMAGE_TEMPLATE = was;
  }
}

test('cover URLs are public https, and inline data is refused', () => {
  assert.equal(C.coverUrl({ img: '/images/a.webp' }), 'https://inkandchai.in/images/a.webp');
  assert.equal(C.coverUrl({ img: 'http://x.dev/a.jpg' }), 'https://x.dev/a.jpg');
  assert.equal(C.coverUrl({ img: 'data:image/png;base64,AA' }), '');
  assert.equal(C.coverUrl({}), '');
});

test('email cells show the cover beside an escaped title, or just the title', () => {
  const html = C.coverAndTitleHtml({ title: 'Tom & Jerry', img: '/images/a.webp' });
  assert.match(html, /<img src="https:\/\/inkandchai\.in\/images\/a\.webp"/);
  assert.match(html, /Tom &amp; Jerry/);
  assert.equal(C.coverAndTitleHtml({ title: 'Plain' }), '<span style="color:#f0e8d8;">Plain</span>');
  assert.equal(C.orderCoversHtml([]), '');
  assert.match(C.orderCoversHtml([{ title: 'Ikigai', qty: 2, img: '/images/i.webp' }]), /Ikigai × 2/);
});

test('without the image template the plain confirmation goes out and nothing is fetched', async () => {
  await withTemplate('', async () => {
    const r = recorder();
    await C.sendOrderConfirmed({ to: '91', params: PARAMS, cart: CART }, { ...r, fetch: () => { throw new Error('fetched'); } });
    assert.deepEqual(r.sent, [{ to: '91', template: 'order_confirmed', params: PARAMS }]);
  });
});

test('with the template, the first cover goes as a JPEG header', async () => {
  await withTemplate(IMAGE, async () => {
    const r = recorder();
    await C.sendOrderConfirmed({ to: '91', params: PARAMS, cart: CART }, { ...r, fetch: answer(JPEG) });
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0].template, IMAGE);
    assert.ok(r.sent[0].headerImageUrl.startsWith('https://wsrv.nl/?url=https%3A%2F%2Finkandchai.in%2Fimages%2Fikigai.webp'));
    assert.ok(r.sent[0].headerImageUrl.includes('output=jpg'));
  });
});

test('any doubt about the image still sends the plain confirmation, once', async () => {
  await withTemplate(IMAGE, async () => {
    const cases = [
      [CART, answer(WEBP)],
      [CART, answer(JPEG, false)],
      [CART, async () => { throw new Error('timeout'); }],
      [[{ title: 'No cover' }], answer(JPEG)],
    ];
    for (const [cart, fetchImpl] of cases) {
      const r = recorder();
      await C.sendOrderConfirmed({ to: '91', params: PARAMS, cart }, { ...r, fetch: fetchImpl });
      assert.deepEqual(r.sent.map((m) => m.template), ['order_confirmed']);
    }
  });
});

test('a rejected image template falls back to the plain confirmation', async () => {
  await withTemplate(IMAGE, async () => {
    const r = recorder({ failImage: true });
    await C.sendOrderConfirmed({ to: '91', params: PARAMS, cart: CART }, { ...r, fetch: answer(JPEG) });
    assert.deepEqual(r.sent.map((m) => m.template), [IMAGE, 'order_confirmed']);
  });
});
