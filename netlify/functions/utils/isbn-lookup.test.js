const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findIsbn, decideIsbn, parseAiAnswer, responseText, splitTitleAuthor, titleMatches,
} = require('./isbn-lookup');

const US = '9780593336823';      // Berkley paperback (valid)
const UK = '9781408725764';      // Sphere paperback (valid)

// Fake network: Open Library and OpenAI answers chosen per test.
function fakeFetch({ ol, ai, olFail } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (String(url).includes('openlibrary.org')) {
      if (olFail) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return { ok: true, status: 200, json: async () => ol };
    }
    if (String(url).includes('api.openai.com')) {
      return { ok: true, status: 200, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: ai }] }] }) };
    }
    throw new Error('unexpected ' + url);
  };
  fn.calls = calls;
  return fn;
}
const OL = {
  docs: [
    { title: 'The Love Hypothesis', author_name: ['Ali Hazelwood'], isbn: ['0593336828', UK, 'garbage'], publisher: ['Berkley', 'Sphere'] },
    { title: 'Love, Theoretically', isbn: ['9780593336861'] },          // other book: ignored
  ],
};
const ENV = { OPENAI_API_KEY: 'test' };

test('catalogue titles are split into title and author for the databases', () => {
  assert.deepEqual(splitTitleAuthor('The Love Hypothesis by Ali Hazelwood', ''), { title: 'The Love Hypothesis', author: 'Ali Hazelwood' });
  assert.deepEqual(splitTitleAuthor('Atomic Habits: An Easy Way', 'James Clear'), { title: 'Atomic Habits', author: 'James Clear' });
  assert.ok(titleMatches('The Love Hypothesis', 'Love Hypothesis (Paperback)'));
  assert.ok(!titleMatches('The Love Hypothesis', 'Love, Theoretically'));
});

test('the model answer is parsed from the raw Responses shape; a bad checksum is dropped', () => {
  const text = responseText({ output: [{ type: 'web_search_call' }, { type: 'message', content: [{ type: 'output_text', text: `**ISBN13:** ${US}\nPUBLISHER: Berkley\nSOURCE: see https://www.amazon.in/dp/x.\nREASON: Indian listing.` }] }] });
  const a = parseAiAnswer(text);
  assert.equal(a.isbn, US);
  assert.equal(a.publisher, 'Berkley');
  assert.equal(a.source_url, 'https://www.amazon.in/dp/x.');
  assert.equal(parseAiAnswer('ISBN13: 9780593336824').isbn, '');   // one digit off
  assert.equal(parseAiAnswer('ISBN13: NONE').isbn, '');
});

test('the model pick is filled only when a book database lists it for this title', async () => {
  const ok = await findIsbn({ title: 'The Love Hypothesis by Ali Hazelwood' }, ENV,
    fakeFetch({ ol: OL, ai: `ISBN13: ${UK}\nPUBLISHER: Sphere\nSOURCE: https://amazon.in/x\nREASON: India edition.` }));
  assert.equal(ok.status, 'verified');
  assert.equal(ok.fill, true);
  assert.equal(ok.isbn, UK);
  assert.equal(ok.candidates, 2);                      // the ISBN-10 became the same ISBN-13 as US

  // A confident, checksum-valid number that no database has for this book.
  const made = await findIsbn({ title: 'The Love Hypothesis', author: 'Ali Hazelwood' }, ENV,
    fakeFetch({ ol: OL, ai: 'ISBN13: 9780593336861\nSOURCE: https://example.com' }));
  assert.equal(made.status, 'unverified');
  assert.equal(made.fill, false);
});

test('database candidates reach the model prompt; a source that is down is reported, not fatal', async () => {
  const f = fakeFetch({ ol: OL, ai: 'ISBN13: NONE' });
  const r = await findIsbn({ title: 'The Love Hypothesis', author: 'Ali Hazelwood' }, ENV, f);
  const prompt = f.calls.find((c) => c.url.includes('openai')).body.input;
  assert.ok(prompt.includes(US) && prompt.includes(UK));
  assert.equal(r.status, 'none');                      // Open Library alone is not edition-specific
  assert.equal(r.fill, false);

  const down = await findIsbn({ title: 'The Love Hypothesis' }, ENV,
    fakeFetch({ olFail: true, ai: `ISBN13: ${US}\nSOURCE: https://amazon.in/x` }));
  assert.equal(down.status, 'unverified');             // nothing to verify against -> not filled
  assert.ok(down.notes.some((n) => /Open Library: timed out/.test(n)));
});

test('without the model, only a single Google Books edition is filled', () => {
  const one = [{ isbn: US, source: 'Google Books', publisher: 'Berkley' }];
  assert.equal(decideIsbn({ candidates: one }).fill, true);
  assert.equal(decideIsbn({ candidates: [...one, { isbn: UK, source: 'Google Books' }] }).fill, false);
  assert.equal(decideIsbn({ candidates: [{ isbn: US, source: 'Open Library' }] }).fill, false);
});
