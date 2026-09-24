const test = require('node:test');
const assert = require('node:assert');
const dp = require('./delhivery-pincodes');

test('the export loaded and looks like the real thing', () => {
  assert.ok(dp.count > 15000, `only ${dp.count} pincodes — the generated file looks truncated`);
  assert.match(dp.generatedAt, /^\d{4}-\d{2}-\d{2}$/);
});

test('a pincode in the export is serviceable, one absent from it is not', () => {
  assert.equal(dp.isServiceable('411030'), true);   // Pune
  assert.equal(dp.isServiceable('110006'), true);   // our own pickup
  // Well-formed but absent from the export -- the case this module exists for.
  assert.equal(dp.isServiceable('811111'), false);
});

test('an unreadable pincode is NOT serviceable — never assume coverage', () => {
  // Failing closed matters: the alternative is booking a parcel to a pincode
  // nobody could read and finding out a week later.
  for (const bad of ['', null, undefined, 'abc', '41103', '4110301', '011030', '911030', 0]) {
    assert.equal(dp.isServiceable(bad), false, `${JSON.stringify(bad)} should not be serviceable`);
    assert.equal(dp.classify(bad).valid, false);
  }
});

test('a pincode is read out of a messy string', () => {
  assert.equal(dp.normalizePin(' 411030 '), '411030');
  assert.equal(dp.normalizePin('411-030'), '411030');
  assert.equal(dp.normalizePin(411030), '411030');
});

test('COD is refused where Delhivery does not collect it, and everywhere off-network', () => {
  const noCod = require('../../../data/delhivery-pincodes.generated.js').noCod;
  assert.ok(noCod.length > 0, 'expected at least one no-COD pincode in the export');
  for (const p of noCod) {
    assert.equal(dp.isServiceable(p), true, `${p} should still be deliverable`);
    assert.equal(dp.codServiceable(p), false);
  }
  assert.equal(dp.codServiceable('811111'), false);
});

test('canShip asks about COD only when money is owed at the door', () => {
  const noCod = require('../../../data/delhivery-pincodes.generated.js').noCod;
  const p = noCod[0];
  // Prepaid to a no-COD pincode is perfectly shippable.
  assert.equal(dp.canShip(p, { isCOD: false }).ok, true);
  assert.equal(dp.canShip(p, { isCOD: true }).ok, false);
  assert.match(dp.canShip(p, { isCOD: true }).reason, /COD/);
});

test('off-network is refused for prepaid too, with a reason worth showing', () => {
  const v = dp.canShip('811111', { isCOD: false });
  assert.equal(v.ok, false);
  assert.match(v.reason, /not in Delhivery serviceable pincodes/);
});

test('reverse pickup and replacement are narrower than delivery', () => {
  const gen = require('../../../data/delhivery-pincodes.generated.js');
  assert.ok(gen.noReplacement.length > gen.noReverse.length,
    'replacement coverage should be the narrower of the two');
  const p = gen.noReplacement[0];
  assert.equal(dp.isServiceable(p), true);
  assert.equal(dp.replacementServiceable(p), false);
  assert.equal(dp.replacementServiceable('811111'), false);
});
