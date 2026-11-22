import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../crawler/lib/config.mjs';
import { makeCategorizer, makeFieldTagger } from '../crawler/lib/categorize.mjs';

const cfg = await loadConfig();
const cat = makeCategorizer(cfg.categories);
const simple = (r) => r.map((c) => `${c.category}:${c.confidence}`);

test('categories are a set: INSPIRE POSTDOC + JUNIOR gives both', () => {
  assert.deepEqual(simple(cat({ scheme: 'inspire', values: ['POSTDOC', 'JUNIOR'], title: 'Research position' })), ['postdoc:high', 'faculty:high']);
});

test('AJO "Postdoctoral or Fellowship"', () => {
  assert.deepEqual(simple(cat({ scheme: 'ajo', values: ['Postdoctoral or Fellowship'], title: 'x' })), ['postdoc:high', 'fellowship:high']);
});

test('bundled Indian advert: JRF/SRF/RA is PhD-track and postdoc', () => {
  assert.deepEqual(simple(cat({ title: 'Junior Research Fellow / Senior Research Fellow / Research Associate' })), ['phd:medium', 'postdoc:medium']);
  assert.deepEqual(simple(cat({ title: 'Recruitment of JRF and SRF' })), ['phd:medium']);
});

test('Indian ranks', () => {
  assert.deepEqual(simple(cat({ title: 'Assistant Professor Grade I' })), ['faculty:medium']);
  assert.deepEqual(simple(cat({ title: 'ANRF National Post Doctoral Fellowship (N-PDF)' })), ['postdoc:medium', 'fellowship:medium']);
  assert.deepEqual(simple(cat({ title: 'ANRF Project Associate-I' })), ['other:medium']);
});

test('"Postdoctoral position" is not a PhD; "SRF cavity" is not an SRF', () => {
  assert.deepEqual(simple(cat({ title: 'Postdoctoral Position in High-Energy Nuclear Theory' })), ['postdoc:medium']);
  assert.deepEqual(simple(cat({ title: 'Postdoctoral Researcher SRF Cavity Control' })), ['postdoc:medium']);
  assert.deepEqual(simple(cat({ title: 'Postdoc for recent PhD holders' })), ['postdoc:medium']);
});

test('body text is a low-confidence fallback only', () => {
  assert.deepEqual(simple(cat({ title: 'Advertisement 12/2026', body: 'Applications are invited for the post of Junior Research Fellow' })), ['phd:low']);
  assert.deepEqual(simple(cat({ title: 'Advertisement 12/2026', body: '' })), ['other:low']);
});

test('fixed categories from config are high confidence', () => {
  assert.deepEqual(simple(cat({ fixed: ['postdoc', 'fellowship'], title: 'IISER Pune PDRA positions' })), ['postdoc:high', 'fellowship:high']);
});

test('field tags from subjects', () => {
  const f = makeFieldTagger(cfg.fields);
  assert.deepEqual(f({ subject: 'Condensed Matter Physics; Physics; Quantum Information Science' }), ['cond-mat', 'physics', 'quant-ph']);
  assert.ok(f({ arxiv: ['hep-th', 'math-ph'] }).includes('physics'));
});
