const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Lives in utils/ because a top-level *.test.js in netlify/functions/ becomes a
// Netlify function with an illegal name and breaks the deploy for the whole site.
const { describeNonText, collectInboundMessages, buttonLabelOf } =
  require(path.resolve(__dirname, '..', 'whatsapp-bot.js'))._internal;

// Context: a customer thread in the Bot Inbox opened with the word "Why", as if
// the conversation started mid-sentence. Nothing had been deleted — three
// separate paths dropped inbound messages before they were ever persisted.

// ── 1. Non-text messages were dropped entirely ──────────────────────────────
test('every media type gets a readable placeholder', () => {
  assert.equal(describeNonText({ type: 'image' }), '[📷 Photo]');
  assert.equal(describeNonText({ type: 'audio' }), '[🎤 Voice note]');
  assert.equal(describeNonText({ type: 'video' }), '[🎥 Video]');
  assert.equal(describeNonText({ type: 'sticker' }), '[🌟 Sticker]');
  assert.equal(describeNonText({ type: 'document' }), '[📄 Document]');
});

test('a caption is kept — it is usually the actual question', () => {
  assert.equal(
    describeNonText({ type: 'image', image: { caption: 'Is this the right book?' } }),
    '[📷 Photo] Is this the right book?');
});

test('a document falls back to its filename', () => {
  assert.equal(
    describeNonText({ type: 'document', document: { filename: 'invoice.pdf' } }),
    '[📄 Document] invoice.pdf');
});

test('a caption beats the filename when both are present', () => {
  assert.equal(
    describeNonText({ type: 'document', document: { filename: 'x.pdf', caption: 'my receipt' } }),
    '[📄 Document] my receipt');
});

test('a reaction records which emoji was sent', () => {
  assert.equal(describeNonText({ type: 'reaction', reaction: { emoji: '👍' } }), '[❤️ Reaction] 👍');
});

test('a location records its name or address', () => {
  assert.equal(describeNonText({ type: 'location', location: { name: 'Bachupally' } }),
    '[📍 Location] Bachupally');
  assert.equal(describeNonText({ type: 'location', location: { address: 'Flat 418, b block' } }),
    '[📍 Location] Flat 418, b block');
});

test('an unknown message type still produces something storable', () => {
  assert.equal(describeNonText({ type: 'ephemeral' }), '[ephemeral]');
  assert.equal(describeNonText({}), '[unknown]');
  assert.equal(describeNonText(null), '[unknown]');
});

test('a runaway caption is truncated rather than stored whole', () => {
  const out = describeNonText({ type: 'image', image: { caption: 'x'.repeat(5000) } });
  assert.ok(out.length < 450, `placeholder was ${out.length} chars`);
});

test('placeholders never come back empty', () => {
  for (const type of ['image', 'audio', 'video', 'document', 'sticker', 'location',
                      'contacts', 'reaction', 'order', 'unsupported', 'weird']) {
    const out = describeNonText({ type });
    assert.ok(out && out.trim().length > 0, type);
  }
});

// ── 2. Button taps were handled but never logged ────────────────────────────
test('a button tap is labelled with what the customer actually saw', () => {
  assert.equal(buttonLabelOf({ type: 'button', button: { text: 'Confirm order', payload: 'CONF_1' } }),
    'Confirm order');
  assert.equal(buttonLabelOf({ type: 'interactive',
    interactive: { button_reply: { title: 'Cancel order', id: 'cancel_1' } } }), 'Cancel order');
});

test('the internal payload is used only when there is no visible label', () => {
  assert.equal(buttonLabelOf({ type: 'button', button: { payload: 'CONFIRM_COD' } }), 'CONFIRM_COD');
  assert.equal(buttonLabelOf({ type: 'interactive', interactive: { button_reply: { id: 'cancel_2' } } }),
    'cancel_2');
});

test('a message with no button at all yields an empty label', () => {
  assert.equal(buttonLabelOf({ type: 'text', text: { body: 'hi' } }), '');
  assert.equal(buttonLabelOf(null), '');
});

// ── 3. Only the first message of a batched delivery was read ────────────────
const wrap = (messages, meta = { phone_number_id: '1188708014316574' }) =>
  ({ entry: [{ changes: [{ value: { metadata: meta, messages } }] }] });

test('every message in a batched delivery is collected', () => {
  const body = wrap([{ id: 'a', from: '91', type: 'text', text: { body: 'one' } },
                     { id: 'b', from: '91', type: 'text', text: { body: 'two' } },
                     { id: 'c', from: '91', type: 'text', text: { body: 'three' } }]);
  const got = collectInboundMessages(body);
  assert.equal(got.length, 3);
  assert.deepEqual(got.map(g => g.msg.text.body), ['one', 'two', 'three']);
});

test('messages spread across several entries and changes are all collected', () => {
  const body = { entry: [
    { changes: [{ value: { messages: [{ id: 'a', type: 'text' }] } },
                { value: { messages: [{ id: 'b', type: 'text' }] } }] },
    { changes: [{ value: { messages: [{ id: 'c', type: 'text' }, { id: 'd', type: 'text' }] } }] },
  ] };
  assert.deepEqual(collectInboundMessages(body).map(g => g.msg.id), ['a', 'b', 'c', 'd']);
});

test('each message keeps the value it arrived in, so replies go out the right number', () => {
  const body = { entry: [
    { changes: [{ value: { metadata: { phone_number_id: 'NUM_A' }, messages: [{ id: 'a' }] } }] },
    { changes: [{ value: { metadata: { phone_number_id: 'NUM_B' }, messages: [{ id: 'b' }] } }] },
  ] };
  const got = collectInboundMessages(body);
  assert.equal(got[0].value.metadata.phone_number_id, 'NUM_A');
  assert.equal(got[1].value.metadata.phone_number_id, 'NUM_B');
});

test('delivery receipts and other message-less payloads yield nothing', () => {
  assert.deepEqual(collectInboundMessages({ entry: [{ changes: [{ value: { statuses: [{ id: 's' }] } }] }] }), []);
  assert.deepEqual(collectInboundMessages({ entry: [{ changes: [{ value: { messages: [] } }] }] }), []);
});

test('a malformed payload never throws', () => {
  for (const body of [null, undefined, {}, { entry: null }, { entry: [null] },
                      { entry: [{ changes: null }] }, { entry: [{ changes: [null] }] },
                      { entry: [{ changes: [{}] }] }]) {
    assert.deepEqual(collectInboundMessages(body), []);
  }
});

test('a status payload mixed in with real messages does not hide them', () => {
  const body = { entry: [{ changes: [
    { value: { statuses: [{ id: 's1' }] } },
    { value: { messages: [{ id: 'real', type: 'text' }] } },
  ] }] };
  assert.deepEqual(collectInboundMessages(body).map(g => g.msg.id), ['real']);
});
