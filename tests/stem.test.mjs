import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stem } from '../search/stem.js';

// Sample from the Snowball English (Porter2) vocabulary/output lists.
const CASES = {
  consign: 'consign', consigned: 'consign', consigning: 'consign', consignment: 'consign',
  consist: 'consist', consisted: 'consist', consistency: 'consist', consistent: 'consist',
  consistently: 'consist', consisting: 'consist', consists: 'consist',
  generously: 'generous', generate: 'generat', generation: 'generat', communication: 'communic',
  caresses: 'caress', ponies: 'poni', ties: 'tie', cats: 'cat', agreed: 'agre', sized: 'size',
  hopping: 'hop', tanned: 'tan', falling: 'fall', hissing: 'hiss', fizzed: 'fizz', failing: 'fail',
  filing: 'file', happy: 'happi', cried: 'cri', crying: 'cri', skies: 'sky', news: 'news',
  thermalization: 'thermal', localization: 'local', entanglement: 'entangl', theory: 'theori',
  dynamics: 'dynam', superconducting: 'superconduct', superconductivity: 'superconduct',
};

test('Porter2 sample', () => {
  for (const [w, s] of Object.entries(CASES)) assert.equal(stem(w), s, w);
});
