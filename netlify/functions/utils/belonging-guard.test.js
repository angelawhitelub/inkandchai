/**
 * Owner rule 2026-11-17: "Belonging: A Journey of Love" askers and buyers never
 * get the team's WhatsApp number 9217175546 from the bot.
 */
const test = require('node:test');
const assert = require('node:assert');
const g = require('./belonging-guard');

const fakeDb = (rows, error = null) => ({
  from() {
    const q = {
      select() { return q; }, or() { return q; }, order() { return q; },
      limit() { return Promise.resolve({ data: rows, error }); },
    };
    return q;
  },
});

test('the message, history or order context naming the book triggers the rule', async () => {
  assert.ok(await g.applies({ userMessage: 'I ordered Belonging, it is not hardcover' }));
  assert.ok(await g.applies({ userMessage: 'sonia gandhi book kab aayegi' }));
  assert.ok(await g.applies({ userMessage: 'ok', history: [{ role: 'user', content: 'Belonging: A Journey of Love is fake?' }] }));
  assert.ok(await g.applies({ userMessage: 'where is it', extraContext: 'Books: Belonging: A Journey of Love by Sonia Gandhi' }));
  assert.ok(!(await g.applies({ userMessage: 'where is my order', history: [{ role: 'user', content: 'Ikigai' }] })));
});

test('a customer who ordered the book is covered whatever they type', async () => {
  const db = fakeDb([{ cart_items: [{ title: 'Ikigai' }] }, { cart_items: [{ slug: 'belonging-a-journey-of-love-by-sonia-gandhi', title: 'Belonging' }] }]);
  assert.ok(await g.applies({ userMessage: 'give me your number', phone: '919812345678', db }));
  assert.ok(!(await g.applies({ userMessage: 'hi', phone: '919812345678', db: fakeDb([{ cart_items: [{ title: 'Ikigai' }] }]) })));
  assert.ok(!(await g.applies({ userMessage: 'hi', phone: '919812345678', db: fakeDb(null, { message: 'down' }) })));
});

test('scrub removes the number and link in every spelling and says the team replies here', () => {
  for (const r of [
    'Sure! Tap here to chat directly with a member of our support team 👉 https://wa.me/919217175546 — they\'re available 7 days a week 😊',
    'Call us on +91 92171 75546.',
    'Our number is 9217175546.',
    'WhatsApp +91-92171-75546 please.',
    'wa.me/919217175546',
  ]) {
    const out = g.scrub(`I understand your concern. ${r}`);
    assert.doesNotMatch(out, /9217|92171|75546|wa\.me/, out);
    assert.match(out, /I understand your concern\./);
    assert.match(out, /next available agent will take up your issue and talk to you here/);
    assert.match(out, /\[ESCALATE\]$/, 'a removed number means a person must reply: queued');
  }
});

test('scrub keeps [ESCALATE] and leaves clean replies alone', () => {
  const out = g.scrub("Let me connect you with our team! https://wa.me/919217175546 [ESCALATE]");
  assert.match(out, /\[ESCALATE\]$/);
  assert.doesNotMatch(out, /wa\.me|9217/);
  const clean = 'The product page clearly mentioned the paperback edition 📕';
  assert.strictEqual(g.scrub(clean), clean);
  // Other numbers (an order amount, a pincode) are not touched.
  assert.strictEqual(g.scrub('Your ₹349 order to 110002 is on its way.'), 'Your ₹349 order to 110002 is on its way.');
});

test('the prompt carries both owner points and the no-number rule', () => {
  assert.match(g.PROMPT, /PAPERBACK edition, not the hardcover/);
  assert.match(g.PROMPT, /official copy published by HarperCollins India/);
  assert.match(g.PROMPT, /NEVER share any phone number or wa\.me link/);
});
