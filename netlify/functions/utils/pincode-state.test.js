const test = require('node:test');
const assert = require('node:assert');
const { pincodeInState, stateInAddress } = require('./pincode-state');

test('the state is the LAST one named, not a landmark earlier in the line', () => {
  // IC-20260924-OJD4Y: "Punjab hotel" is a landmark in Visakhapatnam.
  assert.equal(stateInAddress('39-28-41, Mahath Colony, Punjab hotel Jun, Visakhapatnam, Andhra Pradesh, 530007'), 'AP');
  assert.equal(stateInAddress('Tower 56, Hadapsar, Pune, Maharashtra, 411028'), 'MH');
  assert.equal(stateInAddress('Raipur, Chattisgarh, 492001'), 'CG');   // the common misspelling
  assert.equal(stateInAddress('Kalina, Mumbai'), '');
});

test('a pincode is placed in its state by its prefix', () => {
  assert.equal(pincodeInState('411028', 'MH'), true);
  assert.equal(pincodeInState('561202', 'MH'), false);
  assert.equal(pincodeInState('561202', 'KA'), true);
  assert.equal(pincodeInState('795001', 'MN'), true);
});

test('shared prefixes count for both states, so the caller refuses rather than guesses', () => {
  assert.equal(pincodeInState('403512', 'GA'), true);
  assert.equal(pincodeInState('403512', 'MH'), true);
  assert.equal(pincodeInState('160022', 'CH'), true);
  assert.equal(pincodeInState('160022', 'PB'), true);
});
