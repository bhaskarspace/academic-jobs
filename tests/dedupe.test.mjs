import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { findDuplicates, makeInstitutionKey, sameInstitution, shingles, containment, titleSubject } from '../crawler/lib/dedupe.mjs';
import { loadConfig } from '../crawler/lib/config.mjs';

const { institutions } = await loadConfig();
// INSPIRE text is CC0 and kept whole; AJO/MathJobs text is a 70-word excerpt.
const raw = JSON.parse(await readFile(new URL('./fixtures/dedupe/pairs.json', import.meta.url), 'utf8'));
// One "posting" per fixture item, as run.mjs sees them before the similarity merge.
const postings = raw.map((r, i) => ({ id: `p${i}`, firstSeen: `2026-11-${String(10 + i).padStart(2, '0')}`, sources: [{ source: r.source, sourceId: r.sourceId }], ...r }));
const byId = Object.fromEntries(postings.map((p) => [p.sourceId, p.id]));
const merged = (list, dups) => {
  const groups = new Map(list.map((p) => [p.id, new Set([p.sourceId])]));
  for (const { keep, drop } of dups) { for (const s of groups.get(drop)) groups.get(keep).add(s); groups.delete(drop); }
  return [...groups.values()].map((g) => [...g].sort().join(' + '));
};
const groupsOf = (list = postings, cfg = institutions) => merged(list, findDuplicates(list, cfg));

test('Oxford: INSPIRE "Three Postdoc Positions" = AJO and MathJobs "Postdoctoral Research Associate in Mathematical Physics"', () => {
  const groups = groupsOf();
  assert.ok(groups.includes('ajo:33335 + inspire:3222725 + mathjobs:29422'), groups.join('\n'));
});

test('NYU: INSPIRE "Feinberg Postdoctoral Prize Fellowship" = AJO "Postdoctoral Asscociate / Carl Feinberg Institute Fellow"', () => {
  const groups = groupsOf();
  assert.ok(groups.includes('ajo:33181 + inspire:3215723'), groups.join('\n'));
});

test('same institution and deadline but a different advert stays separate (Beecroft, James Arthur)', () => {
  const groups = groupsOf();
  assert.ok(groups.includes('ajo:32694'));
  assert.ok(groups.includes('ajo:32872'));
});

test('templated ads for different subjects stay separate (Caltech physics / mathematics)', () => {
  const groups = groupsOf();
  assert.ok(groups.includes('ajo:32612'), groups.join('\n'));
  assert.ok(groups.includes('mathjobs:28804'));
  assert.deepEqual([...titleSubject('Faculty Position in Mathematics')], ['mathematics']);
  assert.deepEqual([...titleSubject('Three Postdoc Positions')], []);
  // The full Caltech ads share most of their text (0.70 on live data). Synthetic stand-in: one
  // template, two subjects. It merges on text alone; the subject rule keeps it apart.
  const template = (subject, focus) => `The Division at the Example Institute of Technology invites applications for faculty positions in ${subject}. ${focus} `
    + 'The division offers a collaborative environment, generous start-up support, small classes, excellent graduate students and close links '
    + 'to national laboratories. Applicants should send a cover letter, a curriculum vitae, a statement of research plans and a teaching '
    + 'statement, and arrange for three letters of reference. Review of applications begins in January and continues until filled.';
  const t = [
    { id: 'x1', title: 'Faculty Position in Experimental or Theoretical Physics', body: template('experimental and theoretical physics', 'We seek candidates in any area of physics, from particle and condensed matter physics to astrophysics, gravitation and quantum information.'), source: 'ajo', sourceId: 'ajo:1' },
    { id: 'x2', title: 'Faculty Position in Mathematics', body: template('mathematics', 'Applicants working in any field of pure or applied mathematics will be considered, including analysis, algebra, geometry and probability.'), source: 'mathjobs', sourceId: 'mathjobs:1' },
  ].map((p) => ({ ...p, institution: 'Example Institute of Technology', deadline: '2027-02-28', sources: [{ source: p.source, sourceId: p.sourceId }] }));
  const c = containment(shingles(t[0].body), shingles(t[1].body));
  assert.ok(c >= 0.5 && c < 0.9, String(c));
  assert.deepEqual(findDuplicates(t, institutions), []);
  t[1].title = 'Faculty Position';  // no subject named: the text decides
  assert.equal(findDuplicates(t, institutions).length, 1);
});

test('the merged posting keeps the ID seen first', () => {
  const d = findDuplicates(postings, institutions).find((x) => [x.keep, x.drop].includes(byId['inspire:3215723']));
  assert.equal(d.keep, byId['inspire:3215723']);
  assert.equal(d.drop, byId['ajo:33181']);
});

test('never merges two postings from the same source, and honours notDuplicates', () => {
  const ajo = postings.filter((p) => p.source === 'ajo');
  const twins = ajo.map((p) => ({ ...p, id: `${p.id}b`, sourceId: `${p.sourceId}b`, sources: [{ source: 'ajo', sourceId: `${p.sourceId}b` }] }));
  assert.deepEqual(findDuplicates([...ajo, ...twins], institutions), []);
  const groups = groupsOf(postings, { ...institutions, notDuplicates: [['inspire:3215723', 'ajo:33181']] });
  assert.ok(groups.includes('inspire:3215723'), groups.join('\n'));
});

test('institution block: alias table and shared distinctive words', () => {
  const key = makeInstitutionKey(institutions.aliases);
  assert.ok(sameInstitution(key('U. Oxford (main)'), key('University of Oxford, Mathematical Institute')));
  assert.ok(sameInstitution(key('New York U. (main)'), key('New York University, Center for Cosmology and Particle Physics')));
  assert.ok(sameInstitution(key('Universität Hamburg'), key('University of Hamburg, Department of Physics')));
  assert.ok(!sameInstitution(key('University of Oxford'), key('University of Cambridge')));
});

test('deadline check: more than 3 days apart never merges', () => {
  const shifted = postings.map((p) => (p.source === 'ajo' ? { ...p, deadline: '2027-03-01' } : p));
  const groups = groupsOf(shifted);
  assert.ok(groups.includes('ajo:33181'), groups.join('\n'));
});
