'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('the draft fixes the title, author and language, cleaned by the feed rule', async () => {
  process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-admin-secret-0123456789';
  process.env.OPENAI_API_KEY = 'sk-test';
  const realFetch = global.fetch;
  let prompt = '';
  global.fetch = async (url, opts) => {
    prompt = JSON.parse(opts.body).messages[0].content;
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      // A model that half-listens: keeps the marketing, shouts the author.
      title: 'Trust Fall: From the no. 1 bestselling author of Better than the Movies',
      author: 'Lynn Painter', language: 'English',
      description: 'd', author_bio: 'b', tags: 't', seo_title: 's', meta_description: 'm',
    }) } }] }) };
  };
  try {
    const { handler } = require('../generate-listing-copy');
    const res = await handler({ httpMethod: 'POST', headers: { 'x-admin-key': process.env.ADMIN_SECRET },
      body: JSON.stringify({ title: 'Trust Fall: From the no. 1 bestselling author of Better than the Movies', author: 'PAINTER LYNN', isbn: '9781398565500' }) });
    const out = JSON.parse(res.body);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(out.title, 'Trust Fall by Lynn Painter');
    assert.equal(out.author, 'Lynn Painter');
    assert.equal(out.language, 'English');
    assert.match(prompt, /"<Book title> by <Author>"/);
  } finally {
    global.fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
  }
});
