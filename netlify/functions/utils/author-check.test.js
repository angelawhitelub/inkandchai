'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkAuthor, samePerson } = require('./author-check');

// Open Library, as it answered on 11 Oct 2026: The Witch is Freida McFadden's.
const LIBRARY = { 'the witch': ['Freida McFadden'], 'trust fall': ['Lynn Painter'] };
function openLibrary({ down = false } = {}) {
  return async (url) => {
    if (down) throw new Error('offline');
    const q = new URL(url).searchParams;
    const title = q.get('title').toLowerCase();
    const author = q.get('author').toLowerCase();
    const authors = (LIBRARY[title] || []).filter((a) => a.toLowerCase().split(' ').pop() === author.split(' ').pop());
    return { ok: true, json: async () => ({ docs: authors.map((a) => ({ title: q.get('title'), author_name: [a] })) }) };
  };
}
const WITCH = 'The Witch: The haunting new thriller from the #1 Sunday Times bestselling author';

test('a wrong author is replaced when a book database names the right one', async () => {
  const r = await checkAuthor({ title: WITCH, given: 'Ruth Ware', suggested: 'Freida McFadden' }, { fetchImpl: openLibrary() });
  assert.equal(r.status, 'corrected');
  assert.equal(r.author, 'Freida McFadden');
  assert.match(r.note, /"Ruth Ware" → "Freida McFadden"/);
});

test('the typed author stays when the database backs it, or when nothing confirms the AI', async () => {
  const kept = await checkAuthor({ title: 'Trust Fall', given: 'Lynn Painter', suggested: 'Someone Else' }, { fetchImpl: openLibrary() });
  assert.equal(kept.author, 'Lynn Painter');
  assert.equal(kept.status, 'kept');
  const obscure = await checkAuthor({ title: 'A Small Local Book', given: 'Real Writer', suggested: 'Famous Writer' }, { fetchImpl: openLibrary() });
  assert.equal(obscure.author, 'Real Writer');
  assert.equal(obscure.status, 'unconfirmed');
  const offline = await checkAuthor({ title: WITCH, given: 'Ruth Ware', suggested: 'Freida McFadden' }, { fetchImpl: openLibrary({ down: true }) });
  assert.equal(offline.author, 'Ruth Ware', 'no answer is not a confirmation');
});

test('spelling, case and order fixes need no lookup; an empty author is filled', async () => {
  const never = async () => { throw new Error('should not look up'); };
  assert.deepEqual(await checkAuthor({ title: WITCH, given: 'Freida Mcfadden', suggested: 'Freida McFadden' }, { fetchImpl: never }),
    { author: 'Freida McFadden', status: 'same', note: '' });
  assert.equal((await checkAuthor({ title: 'X', given: 'PAINTER LYNN', suggested: 'Lynn Painter' }, { fetchImpl: never })).author, 'Lynn Painter');
  assert.equal((await checkAuthor({ title: 'X', given: '', suggested: 'Lynn Painter' }, { fetchImpl: never })).status, 'filled');
  assert.ok(samePerson('Saint-Exupéry Antoine de', 'Antoine de Saint-Exupery'));
});

test('when the AI just repeats a wrong author, an unanchored question and the database fix it', async () => {
  let asked = 0;
  const r = await checkAuthor({ title: WITCH, given: 'Ruth Ware', suggested: 'Ruth Ware', whoWrote: async () => { asked++; return 'Freida McFadden'; } },
    { fetchImpl: openLibrary() });
  assert.equal(asked, 1);
  assert.equal(r.status, 'corrected');
  assert.equal(r.author, 'Freida McFadden');
  // A right author is never second-guessed: the database lists it, so no question is asked.
  let asked2 = 0;
  const ok = await checkAuthor({ title: 'Trust Fall', given: 'Lynn Painter', suggested: 'Lynn Painter', whoWrote: async () => { asked2++; return 'X'; } },
    { fetchImpl: openLibrary() });
  assert.equal(asked2, 0);
  assert.equal(ok.author, 'Lynn Painter');
});
