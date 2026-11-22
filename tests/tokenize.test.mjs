import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terms, tokenize, buildVariants } from '../search/tokenize.js';
import { stem } from '../search/stem.js';

const has = (s, ...want) => {
  const got = terms(s);
  for (const w of want) assert.ok(got.includes(w), `${JSON.stringify(s)} -> ${JSON.stringify(got)} lacks ${w}`);
  return got;
};

test('AdS/CFT splits into parts plus the compound', () => {
  has('AdS/CFT correspondence', 'ads', 'cft', 'adscft');
  has('the AdS-CFT dictionary', 'ads', 'cft', 'adscft');
  // AdS is protected from stemming (Porter2 would give "ad")
  assert.ok(!terms('AdS/CFT').includes('ad'));
});

test('AdS_5 and friends', () => {
  for (const s of ['AdS_5', 'AdS5', 'AdS$_5$', 'AdS_{5}']) has(s, 'ads', 'ads5');
  has('AdS_3/CFT_2', 'ads', 'cft');
});

test('N=4 SYM', () => {
  has('N=4 SYM', 'n=4', 'sym');
  has('N = 4 super Yang-Mills', 'yang', 'mill');
});

test('group names keep their parentheses', () => {
  has('SU(N) gauge theory', 'su(n)');
  has('U(1) symmetry', 'u(1)');
  has('SL(2,R) and SO(3)', 'so(3)');
  assert.ok(!terms('SU(N)').includes('sun'), 'SU(N) must not become "sun"');
});

test('TTbar in its spellings', () => {
  for (const s of ['TTbar', 'T\\bar{T}', 'TT̄', 'TT̄-deformed', 'ttbar deformations']) has(s, 'ttbar');
});

test('2+1D in its spellings', () => {
  for (const s of ['2+1D', '(2+1)-dimensional', '2+1 dimensions', '(2+1)D']) has(s, '2+1d');
  has('1+1d CFT', '1+1d');
});

test('hyphenated compounds', () => {
  has('many-body localization', 'mani', 'bodi', 'manybodi', 'local');
  has('out-of-time-order correlators', 'time', 'order', 'outoftimeord', 'correl');
});

test('Greek letters become their names', () => {
  has('β-function', 'beta', 'function');
  has('λ and Δ', 'lambda', 'delta');
  has('Schrödinger', 'schroding');
  assert.deepEqual(terms('η/s ratio').slice(0, 1), ['eta']);
});

test('holography vs holographic: Porter2 differs, the variants table folds them', () => {
  assert.notEqual(stem('holography'), stem('holographic'));
  const variants = buildVariants([['holography', 'holographic', 'holographically']]);
  const a = terms('holography', { variants });
  const b = terms('holographic', { variants });
  const c = terms('holographically', { variants });
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
});

test('the shipped variants file covers holography and chaos', async () => {
  const { loadVariants } = await import('../search/build-index.mjs');
  const variants = await loadVariants();
  assert.deepEqual(terms('holographic', { variants }), terms('holography', { variants }));
  assert.deepEqual(terms('chaotic', { variants }), terms('chaos', { variants }));
});

test('offsets point at the original text', () => {
  const s = 'Postdoc in (holography), AdS/CFT.';
  for (const t of tokenize(s)) assert.ok(t.start >= 0 && t.end <= s.length && t.end > t.start, JSON.stringify(t));
  const h = tokenize(s).find((t) => t.term === 'holographi');
  assert.equal(s.slice(h.start, h.end), 'holography');
});

test('stopwords, bare numbers and Devanagari are dropped', () => {
  assert.deepEqual(terms('the of and 2026'), []);
  assert.deepEqual(terms('भौतिक विज्ञान Physics'), ['physic']);
});

test('email addresses and URLs are not indexed', () => {
  assert.deepEqual(terms('Write to jane.doe@example.edu or see https://example.edu/jobs now'), ['write', 'see', 'now']);
  assert.deepEqual(terms('E-mail: todo(at)nifs.ac.jp, chen_[at]_as.edu.tw or jo%40x.org'), ['mail', 'email']);
  assert.deepEqual(terms('see (https://x.org/a) and physics.iisc.ac.in or ictp-ap.org.'), ['see']);
  assert.ok(terms('Ph.D. and U.S.A.').length > 0, 'abbreviations are still indexed');
});
