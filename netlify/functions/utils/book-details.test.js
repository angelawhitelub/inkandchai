const test = require('node:test');
const assert = require('node:assert');
const { bookDetailRows, schemaBookDetails, weightText, schemaDatePublished, count } = require('./book-details');

const labels = (product) => bookDetailRows(product).map(r => r.label);
const valueOf = (product, label) => (bookDetailRows(product).find(r => r.label === label) || {}).value;

test('a listing that fills nothing adds no rows', () => {
  // The whole point of the feature: an existing listing renders exactly the
  // Details table it rendered before the columns existed.
  assert.deepStrictEqual(bookDetailRows({}), []);
  assert.deepStrictEqual(bookDetailRows(null), []);
  assert.deepStrictEqual(bookDetailRows(undefined), []);
});

test('blank and whitespace-only values are dropped, not printed empty', () => {
  assert.deepStrictEqual(bookDetailRows({
    pages: '', dimensions: '   ', edition: null, published_on: undefined,
    reading_age: '\n\t', weight_grams: '',
  }), []);
});

test('a zero page count is unknown, never "Pages: 0"', () => {
  // Importers hand back 0 for books whose page count they could not read. A
  // printed "0" is worse than no row: it looks like a fact.
  assert.strictEqual(count(0), '');
  assert.strictEqual(count('0'), '');
  assert.strictEqual(count(-40), '');
  assert.strictEqual(count('320'), '320');
  assert.strictEqual(count(319.6), '320');
  assert.strictEqual(count('abc'), '');
  assert.deepStrictEqual(labels({ pages: 0 }), []);
});

test('weight switches unit at a kilo and drops trailing zeros', () => {
  assert.strictEqual(weightText(250), '250 g');
  assert.strictEqual(weightText(999), '999 g');
  assert.strictEqual(weightText(1000), '1 kg');
  assert.strictEqual(weightText(1250), '1.25 kg');
  assert.strictEqual(weightText(2000), '2 kg');
  assert.strictEqual(weightText(0), '');
  assert.strictEqual(weightText(null), '');
});

test('rows come back in reading order, anchored to the row they follow', () => {
  const rows = bookDetailRows({
    pages: 320, edition: '2nd', published_on: 'March 2024',
    dimensions: '21.6 x 14 x 2.1 cm', weight_grams: 480, reading_age: '8-12 years',
  });
  assert.deepStrictEqual(rows.map(r => r.label),
    ['Pages', 'Edition', 'Published', 'Dimensions', 'Weight', 'Reading age']);
  assert.deepStrictEqual(rows.map(r => r.after),
    ['format', 'language', 'language', 'isbn', 'isbn', 'isbn']);
});

test('free-text fields are passed through trimmed, not reformatted', () => {
  // "21.6 x 14 x 2.1 cm", "216 x 140 mm" and "8.5 x 5.5 inches" are all honest
  // answers. Normalising them would mean guessing a unit we were not told.
  assert.strictEqual(valueOf({ dimensions: '  216 x 140 mm  ' }, 'Dimensions'), '216 x 140 mm');
  assert.strictEqual(valueOf({ edition: ' Revised 3rd ' }, 'Edition'), 'Revised 3rd');
  assert.strictEqual(valueOf({ reading_age: '8-12 years' }, 'Reading age'), '8-12 years');
});

test('schema.org only gets the properties Book actually defines', () => {
  const schema = schemaBookDetails({
    pages: '320', edition: '2nd', published_on: '2024-03', reading_age: '8-12 years',
    dimensions: '21.6 x 14 x 2.1 cm', weight_grams: 480,
  });
  assert.strictEqual(schema.numberOfPages, 320);          // a number, not "320"
  assert.strictEqual(schema.bookEdition, '2nd');
  assert.strictEqual(schema.datePublished, '2024-03');
  assert.strictEqual(schema.typicalAgeRange, '8-12 years');
  // Dimensions and weight are Product properties, not CreativeWork/Book ones.
  // Emitting them here would be invalid markup for the type we declare.
  assert.ok(!('dimensions' in schema));
  assert.ok(!('weight' in schema));
});

test('prose publication dates stay out of datePublished', () => {
  // Admins type what the copyright page says. Only an ISO-shaped value is a
  // date to Google; the rest still renders in the Details table verbatim.
  assert.strictEqual(schemaDatePublished('2024'), '2024');
  assert.strictEqual(schemaDatePublished('2024-03'), '2024-03');
  assert.strictEqual(schemaDatePublished('2024-03-15'), '2024-03-15');
  assert.strictEqual(schemaDatePublished('March 2024'), undefined);
  assert.strictEqual(schemaDatePublished('Reprint 2019'), undefined);
  assert.strictEqual(schemaDatePublished('15/03/2024'), undefined);
  assert.strictEqual(schemaBookDetails({ published_on: 'March 2024' }).datePublished, undefined);
  assert.strictEqual(valueOf({ published_on: 'March 2024' }, 'Published'), 'March 2024');
});

test('an empty listing produces an all-undefined schema fragment', () => {
  // Spread into the JSON-LD object, undefined keys vanish on stringify — so a
  // listing with no details must not add empty properties to the markup.
  const schema = schemaBookDetails({});
  assert.strictEqual(JSON.stringify(schema), '{}');
});

test('values that would break out of the Details table survive as text', () => {
  // The module is deliberately HTML-free: it must hand back the raw string so
  // the caller escapes it once, rather than half-escaping here.
  const raw = '<script>alert(1)</script>';
  assert.strictEqual(valueOf({ dimensions: raw }, 'Dimensions'), raw);
  assert.strictEqual(schemaBookDetails({ edition: raw }).bookEdition, raw);
});
