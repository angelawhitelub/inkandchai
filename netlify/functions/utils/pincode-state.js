/**
 * Which state does a pincode belong to, and which state does an address name?
 *
 * Used for one decision only: when an address contains TWO different 6-digit
 * codes, keep the one that lies in the state the address names. On 5 Sep
 *   "Tower 56, ..., (561202), Amanora Park Town, Hadapsar, Pune,
 *    Maharashtra, 411028"
 * shipped to 561202 -- Karnataka -- and came back RTO. 411028 is the only
 * candidate in Maharashtra.
 *
 * DELIBERATELY GENEROUS. Each state lists every prefix it could plausibly own,
 * overlaps included (Bihar/Jharkhand, UP/Uttarakhand, Punjab/Chandigarh). A
 * generous table can only make two candidates BOTH look plausible, and the
 * caller then refuses to guess -- a safe outcome. A tight table could reject
 * the right pincode and hand over the wrong one, which is the bug this exists
 * to stop. So when in doubt, add the prefix.
 *
 * Source: India Post postal circles, keyed on the first 2-3 digits.
 */

const STATE_PREFIXES = {
  DL: ['11'],
  HR: ['12', '13'],
  PB: ['14', '15', '160'],
  CH: ['160', '140'],
  HP: ['17'],
  JK: ['18', '19'],
  LA: ['194'],
  UP: ['20', '21', '22', '23', '24', '25', '26', '27', '28'],
  UK: ['244', '246', '247', '248', '249', '262', '263'],
  RJ: ['30', '31', '32', '33', '34'],
  GJ: ['36', '37', '38', '39'],
  DN: ['396'],                         // Dadra & Nagar Haveli and Daman & Diu
  MH: ['40', '41', '42', '43', '44'],
  GA: ['403'],
  MP: ['45', '46', '47', '48'],
  CG: ['49'],
  TS: ['50'],
  AP: ['50', '51', '52', '53'],        // 50x runs into both Telangana and AP
  KA: ['56', '57', '58', '59'],
  TN: ['60', '61', '62', '63', '64'],
  PY: ['605', '607', '609', '533', '673'],
  KL: ['67', '68', '69'],
  LD: ['682'],
  WB: ['70', '71', '72', '73', '74'],
  SK: ['737'],
  AN: ['744'],
  OR: ['75', '76', '77'],
  AS: ['78'],
  AR: ['790', '791', '792'],
  ML: ['793', '794'],
  MN: ['795'],
  MZ: ['796'],
  NL: ['797', '798'],
  TR: ['799'],
  BR: ['80', '81', '82', '83', '84', '85'],
  JH: ['81', '82', '83', '84'],
};

// Every spelling customers actually type. Longest first, so "new delhi"
// is tried before "delhi" and "andhra pradesh" before nothing shorter.
const STATE_NAMES = [
  ['andaman and nicobar', 'AN'], ['andaman & nicobar', 'AN'],
  ['dadra and nagar haveli', 'DN'], ['daman and diu', 'DN'],
  ['jammu and kashmir', 'JK'], ['jammu & kashmir', 'JK'],
  ['arunachal pradesh', 'AR'], ['himachal pradesh', 'HP'],
  ['madhya pradesh', 'MP'], ['andhra pradesh', 'AP'], ['andhrapradesh', 'AP'],
  ['uttar pradesh', 'UP'], ['uttarpradesh', 'UP'],
  ['west bengal', 'WB'], ['tamil nadu', 'TN'], ['tamilnadu', 'TN'],
  ['chhattisgarh', 'CG'], ['chattisgarh', 'CG'], ['chhatisgarh', 'CG'],
  ['uttarakhand', 'UK'], ['uttaranchal', 'UK'],
  ['maharashtra', 'MH'], ['maharastra', 'MH'],
  ['karnataka', 'KA'], ['karnatak', 'KA'],
  ['telangana', 'TS'], ['rajasthan', 'RJ'], ['jharkhand', 'JH'],
  ['puducherry', 'PY'], ['pondicherry', 'PY'],
  ['lakshadweep', 'LD'], ['chandigarh', 'CH'], ['meghalaya', 'ML'],
  ['nagaland', 'NL'], ['mizoram', 'MZ'], ['manipur', 'MN'], ['tripura', 'TR'],
  ['new delhi', 'DL'], ['delhi', 'DL'],
  ['haryana', 'HR'], ['punjab', 'PB'], ['gujarat', 'GJ'], ['kerala', 'KL'],
  ['odisha', 'OR'], ['orissa', 'OR'], ['assam', 'AS'], ['bihar', 'BR'],
  ['sikkim', 'SK'], ['ladakh', 'LA'], ['goa', 'GA'],
];

/** Does this pincode fall inside this state's postal prefixes? */
function pincodeInState(pin, code) {
  const list = STATE_PREFIXES[code];
  if (!list) return false;
  const p = String(pin || '');
  // A few prefixes are shared (Goa inside Maharashtra's 40x, Chandigarh with
  // Punjab); treat a state's neighbours as plausible rather than exclusive.
  const extra = code === 'GA' ? STATE_PREFIXES.MH
              : code === 'CH' ? STATE_PREFIXES.PB
              : code === 'PB' ? STATE_PREFIXES.CH
              : code === 'LA' ? STATE_PREFIXES.JK
              : code === 'UK' ? STATE_PREFIXES.UP
              : code === 'TS' ? STATE_PREFIXES.AP
              : [];
  return [...list, ...extra].some((pre) => p.startsWith(pre));
}

/**
 * The state the address names -- the LAST one mentioned, because an address
 * reads from street to state and a landmark can carry a state's name
 * ("Punjab hotel, ..., Visakhapatnam, Andhra Pradesh").
 * Returns a state code or ''.
 */
function stateInAddress(address) {
  const s = ' ' + String(address || '').toLowerCase().replace(/[^a-z&]+/g, ' ') + ' ';
  let best = { code: '', at: -1 };
  for (const [name, code] of STATE_NAMES) {
    const needle = ' ' + name + ' ';
    const at = s.lastIndexOf(needle);
    // Longer names are listed first; a shorter name only wins by appearing
    // strictly later, so "delhi" inside "new delhi" never displaces it.
    if (at > best.at) best = { code, at };
  }
  return best.code;
}

module.exports = { pincodeInState, stateInAddress, STATE_PREFIXES };
