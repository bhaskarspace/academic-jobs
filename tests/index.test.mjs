import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from '../search/build-index.mjs';
import { prepare, search, highlight } from '../search/query.js';
import { buildVariants } from '../search/tokenize.js';

const variants = buildVariants([['holography', 'holographic']]);
const P = (o) => ({
  sources: [{ source: 's', name: 'Src', url: o.url ?? `https://x/${o.id}`, sourceId: `s:${o.id}` }],
  url: `https://x/${o.id}`, institution: 'Somewhere', categories: [{ category: 'postdoc', confidence: 'high' }],
  fields: [], firstSeen: '2026-11-01T00:00:00Z', body: '', snippet: '', ...o,
});
const SECRET = 'The successful candidate will join a vibrant group working on black hole microstates';
const postings = [
  P({ id: 'a', title: 'Postdoc in holography', body: SECRET, deadline: '2026-12-31' }),
  P({ id: 'b', title: 'Postdoc in condensed matter', body: 'Holographic methods for strange metals.', deadline: '2026-12-01', firstSeen: '2026-11-15T00:00:00Z' }),
  P({ id: 'c', title: 'Old holography call', deadline: '2026-01-01' }),
  P({ id: 'd', title: 'PhD/postdoc in AdS/CFT', categories: [{ category: 'phd', confidence: 'high' }, { category: 'postdoc', confidence: 'high' }] }),
  P({ id: 'e', title: 'Faculty position, holography', categories: [{ category: 'faculty', confidence: 'medium' }], rolling: true }),
];
const idx = buildIndex(postings, { variants, built: '2026-11-22T00:00:00Z' });
const engine = prepare(JSON.parse(JSON.stringify(idx)));
const today = '2026-11-22';

test('the public index does not contain the ad text', () => {
  const json = JSON.stringify(idx);
  assert.ok(!json.includes('vibrant group'), 'body text leaked');
  assert.ok(!json.includes('strange metals'), 'body text leaked');
  for (const d of idx.docs) assert.ok(!('body' in d));
});

test('holography matches holographic in the ad text, title hits rank first', () => {
  const r = search(engine, 'holography', { today });
  const ids = r.results.map((x) => x.doc.id);
  assert.deepEqual(ids.sort(), ['a', 'b', 'e']); // c is expired
  const top = search(engine, 'holography', { today }).results[0].doc.id;
  assert.ok(['a', 'e'].includes(top));
  const b = r.results.find((x) => x.doc.id === 'b');
  assert.equal(b.matched[0].mask & 4, 4, 'matched in ad text');
});

test('expired postings are hidden unless asked for', () => {
  assert.ok(!search(engine, 'holography', { today }).results.some((x) => x.doc.id === 'c'));
  assert.ok(search(engine, 'holography', { today, includeExpired: true }).results.some((x) => x.doc.id === 'c'));
});

test('category filter matches any entry of the set', () => {
  const phd = search(engine, '', { today, category: 'phd' }).results.map((x) => x.doc.id);
  const pd = search(engine, '', { today, category: 'postdoc' }).results.map((x) => x.doc.id);
  assert.deepEqual(phd, ['d']);
  assert.ok(pd.includes('d') && pd.includes('a'));
});

test('AND first, then any-word fallback', () => {
  assert.equal(search(engine, 'holography condensed', { today }).mode, 'all');
  const r = search(engine, 'holography zebrafish', { today });
  assert.equal(r.mode, 'any');
  assert.ok(r.results.length > 0);
  assert.equal(search(engine, 'zebrafish', { today }).mode, 'none');
});

test('sorting by deadline puts no-deadline postings last', () => {
  const ids = search(engine, '', { today, sort: 'deadline' }).results.map((x) => x.doc.id);
  assert.deepEqual(ids.slice(0, 2), ['b', 'a']);
});

test('AdS/CFT query finds the compound', () => {
  assert.deepEqual(search(engine, 'AdS/CFT', { today }).results.map((x) => x.doc.id), ['d']);
});

test('highlight marks the matched word in the title', () => {
  const segs = highlight('Postdoc in holographic QFT', new Set(['holographi']), variants);
  assert.deepEqual(segs.filter((s) => s.hit).map((s) => s.text), ['holographic']);
});
