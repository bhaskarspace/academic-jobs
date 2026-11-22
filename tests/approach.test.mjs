import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApproachTagger } from '../search/approach.mjs';
import { loadYaml } from '../crawler/lib/config.mjs';

// Short excerpts of live postings (2026-11-22) whose tags were wrong in Phase 2.
const tag = makeApproachTagger(await loadYaml('config/approach.yaml'));
const tags = (p) => Object.fromEntries(tag(p).map((a) => [a.approach, a.confidence]));

test('UCSD theoretical cond-mat: Theory, not just Computational?', () => {
  const t = tags({
    title: 'Postdoctoral Scholar at University of California San Diego',
    unit: 'University of California, San Diego, Theoretical Physics',
    body: 'The Department of Physics invites applications for a postdoctoral position in theoretical condensed matter physics. Topics: quantum geometry; quantum many-body numerics (especially tensor network methods).',
  });
  assert.equal(t.theory, 'high');
});

test('Academia Sinica Quantum Matter Theory Group: Theory from the group name', () => {
  const t = tags({ title: 'Postdoc', unit: 'Academia Sinica, Quantum Matter Theory Group, Institute of Physics', body: 'The research topics cover quantum phenomena in nanoscale systems.' });
  assert.deepEqual(t, { theory: 'high' });
});

test('IHES "Postdoctoral position in Physics": Theory, high', () => {
  const t = tags({ title: 'Postdoctoral position in Physics', unit: 'IHES, Bures-sur-Yvette', body: 'IHES is advertising one post-doctoral position in theoretical physics with a starting date in the fall 2027.' });
  assert.equal(t.theory, 'high');
});

test('Florida theoretical/computational QI: no Experimental from the department blurb', () => {
  const t = tags({
    title: 'Postdoctoral Associate in Theoretical and computational quantum information',
    unit: 'University of Florida, Department of Physics',
    body: 'A position in theoretical and computational quantum information science and condensed matter physics. The department has faculty across theory and experiment and operates the Microkelvin Laboratory.',
  });
  assert.equal(t.theory, 'high');
  assert.equal(t.computational, 'high');
  assert.ok(!t.experimental, JSON.stringify(t));
});

test('an explicit experimental phrase still tags a theory posting', () => {
  const t = tags({ title: 'Postdoc in theoretical physics', body: 'The candidate will also join an experimental group and work hands-on with the apparatus.' });
  assert.equal(t.theory, 'high');
  assert.ok(t.experimental);
});

test('an Experimental title at a theory-named institute stays experimental', () => {
  const t = tags({ title: 'Postdoctoral Position in Experimental Particle Physics', unit: 'Beijing, Inst. Theor. Phys.', body: 'Detector R&D.' });
  assert.equal(t.experimental, 'high');
  assert.ok(!t.theory);
});
