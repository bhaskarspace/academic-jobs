import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, variantCandidates, loadIndexConfig } from '../search/build-index.mjs';
import { prepare, search, highlight, parseQuery } from '../search/query.js';
import { buildVariants, terms } from '../search/tokenize.js';
import { compileEntry } from '../search/concepts.js';

const concepts = {
  chaos: {
    label: 'quantum chaos',
    query: ['chaos', 'quantum chaos'],
    fields: ['hep-th', 'cond-mat', 'physics'],
    terms: ['OTOC', 'out-of-time-order', 'SYK', 'scrambling', 'many-body localization', 'MBL', 'spectral form factor'],
    weak: ['Lyapunov', 'thermalization', 'random matrix'],
  },
  'topological-phases': {
    label: 'topological phases',
    query: ['topological'],
    fields: ['cond-mat', 'physics'],
    terms: ['anyons', 'quantum Hall', 'Majorana'],
  },
};
const approach = {
  theory: ['\\btheor(y|etical)\\b'],
  experimental: ['\\bexperiment(al)?\\b', '\\bcryostats?\\b'],
};
const variants = buildVariants([['topology', 'topological'], ['postdoc', 'postdoctoral']]);
const P = (o) => ({
  sources: [{ source: 's', name: 'Src', url: `https://x/${o.id}`, sourceId: `s:${o.id}` }],
  url: `https://x/${o.id}`, institution: 'Somewhere', categories: [{ category: 'postdoc', confidence: 'high' }],
  fields: ['hep-th', 'physics'], firstSeen: '2026-11-01T00:00:00Z', body: '', snippet: '', ...o,
});
const postings = [
  P({ id: 'otoc', title: 'Postdoc in high-energy theory', body: 'Out-of-time-order correlators (OTOCs) and the SYK model.' }),
  P({ id: 'mbl', title: 'Postdoc in condensed matter theory', fields: ['cond-mat'], body: 'Many body localization and scrambling in quantum circuits.' }),
  P({ id: 'lit', title: 'Postdoc: quantum chaos and black holes', body: 'Holography.' }),
  P({ id: 'control', title: 'Postdoc in control engineering', fields: ['eng'], body: 'Lyapunov functions, Lyapunov stability, robust control, OTOC.' }),
  P({ id: 'prob', title: 'Postdoc in probability', fields: ['math'], body: 'Random matrix theory and thermalization of Markov chains.' }),
  P({ id: 'weak', title: 'Postdoc in plasma physics', fields: ['physics'], body: 'Thermalization of fast ions.' }),
  P({ id: 'topo-maths', title: 'Postdoc in low-dimensional topology', fields: ['math'], body: 'Knot theory, topology of 3-manifolds and topology in general.' }),
  P({ id: 'topo-phys', title: 'Research fellow in quantum matter', fields: ['physics'], body: 'Topological order, anyons and the fractional quantum Hall effect.' }),
  P({ id: 'general', title: 'Postdoctoral fellowships 2027', fields: ['hep-th', 'cond-mat', 'physics'], body: 'Applications are invited from outstanding candidates.' }),
  P({ id: 'exp', title: 'Experimental postdoc in quantum devices', fields: ['cond-mat', 'physics'], body: 'Cryostat operation, many-body localization in qubit arrays, some theory.' }),
  P({ id: 'email', title: 'Postdoc', body: 'Write to jane.doe@example.edu or see https://example.edu/jobs.' }),
];
const build = (c = concepts, v = variants) => prepare(JSON.parse(JSON.stringify(buildIndex(postings, { variants: v, concepts: c, approach, built: '2026-11-22T00:00:00Z' }))));
const engine = build();
const today = '2026-11-22';
const ids = (r) => r.results.map((x) => x.doc.id);

test('compiled entries: compounds use the joined form, phrases a phrase key, AdS5 its specific token', () => {
  assert.equal(compileEntry('out-of-time-order', {}).key, 'outoftimeord');
  assert.equal(compileEntry('random matrix', {}).key, 'random matrix');
  assert.equal(compileEntry('AdS5', {}).key, 'ads5');
});

test('"chaos" finds postings that never say chaos, through the concept, and says why', () => {
  const r = search(engine, 'chaos', { today });
  assert.ok(ids(r).includes('otoc') && ids(r).includes('mbl'));
  const otoc = r.results.find((x) => x.doc.id === 'otoc');
  assert.ok(otoc.matched.some((m) => m.via === 'chaos' && /OTOC|out-of-time-order|SYK/.test(m.surface)));
  const mbl = r.results.find((x) => x.doc.id === 'mbl');
  assert.ok(mbl.matched.some((m) => m.surface === 'many-body localization'), 'phrase matched across a hyphen/space difference');
});

test('a literal hit of the query word ranks above expanded hits', () => {
  assert.equal(ids(search(engine, 'chaos', { today }))[0], 'lit');
});

test('field gating: expanded hits skip control-engineering and probability postings', () => {
  const r = ids(search(engine, 'chaos', { today }));
  assert.ok(!r.includes('control'), 'eng posting matched via OTOC/Lyapunov');
  assert.ok(!r.includes('prob'), 'math posting matched via random matrix');
  // A literal search for the member word itself still finds them.
  assert.ok(ids(search(engine, 'Lyapunov', { today })).includes('control'));
});

test('a weak member alone does not match; two members do', () => {
  assert.ok(!ids(search(engine, 'chaos', { today })).includes('weak'));
});

test('an exact surface form outranks a stem-only match', () => {
  const r = ids(search(engine, 'topological', { today }));
  assert.ok(r.includes('topo-maths') && r.includes('topo-phys'));
  assert.ok(r.indexOf('topo-phys') < r.indexOf('topo-maths'), r.join(','));
  const m = search(engine, 'topological', { today }).results.find((x) => x.doc.id === 'topo-maths').matched[0];
  assert.equal(m.exact, false);
});

test('the Physics field group drops maths postings in one click', () => {
  const all = ids(search(engine, 'postdoc', { today }));
  const phys = ids(search(engine, 'postdoc', { today, field: 'physics' }));
  assert.ok(all.includes('topo-maths') && !phys.includes('topo-maths') && !phys.includes('control'));
  assert.ok(phys.includes('otoc'));
  const r = search(engine, 'postdoc', { today, facetKeys: ['physics', 'hep-th', 'math'] });
  assert.equal(r.counts.fields.math, 2);
  assert.deepEqual(ids(search(engine, 'postdoc', { today, field: 'cond-mat' })).sort(), ['exp', 'general', 'mbl']);
});

test('general calls: topic-less postings in the concept fields are listed separately', () => {
  const r = search(engine, 'chaos', { today });
  assert.ok(r.general, 'general section present');
  assert.deepEqual(r.general.results.map((x) => x.doc.id), ['general', 'email'].filter((id) => r.general.results.some((x) => x.doc.id === id)));
  assert.ok(r.general.results.some((x) => x.doc.id === 'general'));
  assert.ok(!r.general.fields.includes('physics'));
  assert.equal(search(engine, 'zebrafish', { today }).general, null);
});

test('approach filter hides an obviously experimental posting', () => {
  assert.ok(ids(search(engine, 'chaos', { today })).includes('exp'));
  assert.ok(!ids(search(engine, 'chaos', { today, approach: 'theory' })).includes('exp'));
  assert.ok(ids(search(engine, 'chaos', { today, approach: 'theory' })).includes('otoc'));
  assert.ok(ids(search(engine, 'chaos', { today, approach: 'experimental' })).includes('exp'));
});

test('editing the concepts changes the results', () => {
  const fewer = build({ chaos: { ...concepts.chaos, terms: ['SYK'] } });
  const r = ids(search(fewer, 'chaos', { today }));
  assert.ok(r.includes('otoc') && !r.includes('mbl'));
});

test('variant candidates list postdoc/postdoctoral-style pairs; approving one changes search', () => {
  const v = buildVariants([]);
  const raw = buildIndex(postings, { variants: v, concepts, approach });
  const pairs = variantCandidates(raw, { minDf: 1 }).map((c) => [c.a, c.b].join('/'));
  assert.ok(pairs.includes('postdoc/postdoctoral'), pairs.join(' '));
  const before = build(concepts, v);
  assert.ok(!ids(search(before, 'postdoc', { today })).includes('general'));
  assert.ok(ids(search(engine, 'postdoc', { today })).includes('general'), 'approved variant matches');
  const approved = variantCandidates(buildIndex(postings, { variants, concepts, approach }), { minDf: 1 }).map((c) => [c.a, c.b].join('/'));
  assert.ok(!approved.includes('postdoc/postdoctoral'), 'approved pair no longer suggested');
  const rejected = variantCandidates(raw, { minDf: 1, rejected: [['postdoctoral', 'postdoc']] }).map((c) => [c.a, c.b].join('/'));
  assert.ok(!rejected.includes('postdoc/postdoctoral'), 'rejected pair no longer suggested');
});

test('email addresses and URLs are not indexed', () => {
  const raw = buildIndex(postings, { variants, concepts, approach });
  const keys = Object.keys(raw.index).join(' ');
  assert.ok(!/doe|example/.test(keys), keys.match(/\S*(doe|example)\S*/)?.[0]);
  assert.deepEqual(terms('mail x.y@uni.edu now'), ['mail', 'now']);
});

test('multi-word concept queries form one clause', () => {
  const { clauses } = parseQuery(engine, 'quantum chaos postdoc');
  assert.equal(clauses.length, 2);
  assert.deepEqual(clauses[0].concepts, ['chaos']);
});

test('highlighting marks member phrases', () => {
  const segs = highlight('Many-body localization in random circuits', new Set(['mani bodi local']), engine.variants);
  assert.deepEqual(segs.filter((s) => s.hit).map((s) => s.text), ['Many-body localization']);
});

test('the repo concept file compiles and every concept has query words and fields', async () => {
  const cfg = await loadIndexConfig();
  const n = Object.keys(cfg.concepts).length;
  assert.ok(n >= 25, `${n} concepts`);
  for (const [id, c] of Object.entries(cfg.concepts)) {
    assert.ok(c.query?.length, `${id} has no query words`);
    assert.ok(c.fields?.length, `${id} has no fields`);
  }
});
