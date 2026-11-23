// Phase 6: every IISER's recruitment and PhD admissions pages, from trimmed fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as htmlList from '../crawler/adapters/html-list.mjs';
import * as htmlTable from '../crawler/adapters/html-table.mjs';
import * as htmlPage from '../crawler/adapters/html-page.mjs';
import * as rss from '../crawler/adapters/rss.mjs';
import { carryForward, rowOpen } from '../crawler/lib/listing.mjs';
import { normalize } from '../crawler/lib/normalize.mjs';
import { makeCategorizer, makeFieldTagger } from '../crawler/lib/categorize.mjs';
import { loadConfig } from '../crawler/lib/config.mjs';
import { buildIndex, loadIndexConfig } from '../search/build-index.mjs';
import { prepare, search } from '../search/query.js';

const cfg = await loadConfig();
const src = (id) => cfg.sources.find((s) => s.id === id);
const fx = (p) => readFile(new URL(`./fixtures/${p}`, import.meta.url), 'utf8');
const memCache = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); } }; };
const quiet = () => {};
const categorize = makeCategorizer(cfg.categories);
const fieldsOf = makeFieldTagger(cfg.fields);
const norm = (raw) => normalize(raw, { categorize, fieldsOf, sourceName: raw.institution });
const today = '2026-11-23';
/** A fake http client serving fixtures by URL; records the URLs asked for. */
const site = (pages) => {
  const calls = [];
  return { calls, get: async (url) => { calls.push(url); if (!(url in pages)) throw Object.assign(new Error(`unexpected ${url}`), { code: 'HTTP_404' }); return { url, status: 200, body: await fx(pages[url]) }; } };
};
const crawl = async (mod, id, pages) => {
  const http = site(pages);
  const items = await mod.crawl(src(id), { http, log: quiet, cache: memCache(), today });
  return { items, calls: http.calls, posts: items.map(norm) };
};
const cat = (p) => p.categories.map((c) => `${c.category}:${c.confidence}`).join(',');

test('Kolkata project table: PDF as the URL, contact person as PI, walk-in dates, department as field', async () => {
  const s = src('iiser-kolkata-projects');
  const { items, posts } = await crawl(htmlTable, s.id, { [s.url]: 'iiser-kolkata/advertisements.html' });
  assert.equal(items.length, 3);
  const jrf = posts.find((p) => /JRF/.test(p.title));
  assert.match(jrf.url, /\/web\/assets\/advertisements\/.*\.pdf$/);
  assert.equal(jrf.deadline, '2026-11-22');
  assert.equal(cat(jrf), 'phd:medium');
  assert.deepEqual(jrf.fields, ['bio']);
  assert.deepEqual(jrf.facts.pi, { value: 'Prof. Robert John', confidence: 'high' });
  assert.equal(posts.find((p) => /Walk-in/.test(p.title)).deadline, '2026-11-18', '"Walk-in-interview : 18.11.2026"');
});

test('Mohali RSS: deadline read from the advert prose, posted from pubDate, feed window is partial', async () => {
  const s = src('iiser-mohali-projects');
  const { items, posts } = await crawl(rss, s.id, { [s.url]: 'iiser-mohali/project-openings.rss' });
  assert.equal(items.length, 3);
  assert.equal(items.partial, true);
  const jrf = posts[0];
  assert.match(jrf.title, /Junior Research Fellow in Indo-French project/);
  assert.equal(jrf.posted, '2026-11-18');
  assert.equal(jrf.deadline, '2026-12-15');
  assert.deepEqual(jrf.deadlineInfo, { kind: 'deadline', confidence: 'medium', from: 'page' });
  assert.equal(cat(jrf), 'phd:medium');
  assert.ok(!JSON.stringify(items).includes('@iisermohali'), 'no addresses');
});

test('TVM pagination: reads on while a page has open adverts, stops at the first all-closed page', async () => {
  const s = src('iiser-tvm-openings');
  const jrf = 'https://www.iisertvm.ac.in/openings/read/openings-recruitment-for-the-post-of-jrf-on-an-externally-funded-project-diophantine-approximation-with-prime-restriction';
  const { items, posts, calls } = await crawl(htmlTable, s.id, {
    [s.url]: 'iiser-tvm/openings-1.html',
    'https://www.iisertvm.ac.in/openings/index/2?': 'iiser-tvm/openings-2.html',
    [jrf]: 'iiser-tvm/opening-jrf.html',
    'https://www.iisertvm.ac.in/openings/read/openings-recruitment-for-the-post-of-ra-on-an-externally-funded-project-towards-eicks-conjecture-power-structure-in-p-groups-and-an-analogue-of-baers-theorem-for-profinite-groups': 'iiser-tvm/opening-jrf.html',
  });
  assert.ok(calls.includes('https://www.iisertvm.ac.in/openings/index/2?'), 'page 1 had open adverts, so page 2 was read');
  assert.ok(!calls.some((u) => /index\/3/.test(u)), 'page 2 was all closed: page 3 not read');
  assert.equal(items.length, 5);
  assert.equal(items.partial, true);
  assert.ok(!calls.some((u) => /2026-11-10|apprentice/i.test(u)), 'no detail page for a closed advert');
  const j = posts.find((p) => p.url === jrf);
  assert.equal(j.deadline, '2026-11-30');
  assert.equal(j.posted, '2026-10-16');
  assert.equal(j.facts.project.value, 'Diophantine approximation with prime restriction');
  assert.equal(j.facts.funding.value, 'ANRF');
  assert.match(j.pdfUrls[0], /\/files\/read\//);
  assert.ok(!j.fields.includes('humanities'), '"Science Education and Research" is not a field');
});

test('rowOpen: a deadline today or later, or no deadline but posted recently', () => {
  assert.ok(rowOpen({ deadline: '2026-11-23' }, today));
  assert.ok(!rowOpen({ deadline: '2026-11-22' }, today));
  assert.ok(rowOpen({ posted: '2026-11-01' }, today));
  assert.ok(!rowOpen({ posted: '2026-06-01' }, today));
  assert.ok(!rowOpen({}, today));
});

test('a posting that moved to an unread page is carried forward, not marked gone', () => {
  const items = Object.defineProperties([{ sourceId: 'a', posted: '2026-11-10' }, { sourceId: 'b', posted: '2026-09-01' }], { partial: { value: true }, oldestPosted: { value: '2026-09-01' } });
  const prev = [{ sourceId: 'a' }, { sourceId: 'old', posted: '2026-08-20' }, { sourceId: 'removed', posted: '2026-10-01' }, { sourceId: 'undated' }];
  assert.deepEqual(carryForward(items, prev).map((p) => p.sourceId), ['old', 'undated']);
  assert.deepEqual(carryForward(Object.assign([], items), prev), [], 'a complete read carries nothing');
});

test('Berhampur: one table per advert; Advt. No., dates and posts from the header and rows', async () => {
  const s = src('iiser-berhampur-postdoc');
  const { items, posts } = await crawl(htmlList, s.id, { [s.url]: 'iiser-berhampur/post-doc.html' });
  assert.equal(items.length, 3);
  const p = posts[0];
  assert.equal(p.title, 'Post-Doctoral Research Fellow');
  assert.equal(p.ref, 'IISERBPR/ADV/PDRF/MATH/2026/04');
  assert.equal(p.posted, '2026-11-19');
  assert.equal(p.deadline, '2026-12-02');
  assert.equal(cat(p), 'postdoc:high');
  assert.deepEqual(p.fields, ['math']);
  assert.ok(p.pdfUrls.every((u) => /\.pdf$/.test(u) && !/\/job\/$/.test(u)));
});

test('Berhampur PhD admissions: titles from the header text, result notices left out', async () => {
  const s = src('iiser-berhampur-admissions');
  const { posts } = await crawl(htmlList, s.id, { [s.url]: 'iiser-berhampur/phd-admissions.html' });
  assert.ok(posts.length >= 2);
  assert.ok(posts.every((p) => /admission|walk-in/i.test(p.title) && !/result|shortlist|selected/i.test(p.title)), posts.map((p) => p.title).join(' | '));
  const first = posts.find((p) => /Semester-II of AY 2026-27 \(January 2027\)/.test(p.title));
  assert.equal(first.deadline, '2026-10-24');
  assert.equal(cat(first), 'phd:high');
  assert.ok(first.fields.includes('hep-th') && first.fields.includes('cond-mat'), 'physics expands to its subfields');
});

test('Bhopal PDF vacancy: the application-form row is not a posting', async () => {
  const s = src('iiser-bhopal-pdf');
  const { posts } = await crawl(htmlTable, s.id, { [s.url]: 'iiser-bhopal/vacancy.html' });
  assert.deepEqual(posts.map((p) => p.title), ['Advertisement for IPDF (Biological Sciences)']);
  assert.equal(posts[0].deadline, '2026-11-25');
  assert.equal(cat(posts[0]), 'postdoc:high');
  assert.match(posts[0].url, /\/assets_external\/dofa\/.*\.pdf$/);
});

test('Bhopal PhD admission cards: department fields, deadline from the card text', async () => {
  const s = src('iiser-bhopal-admissions');
  const { posts } = await crawl(htmlList, s.id, { [s.url]: 'iiser-bhopal/phd-admission.html' });
  assert.equal(posts.length, 2);
  const chem = posts.find((p) => /Chemistry/.test(p.title));
  assert.deepEqual(chem.fields, ['chem'], 'a chemistry round is not a physics call');
  assert.equal(chem.deadline, '2026-11-26');
  assert.equal(cat(chem), 'phd:high');
  assert.notEqual(posts[0].url, posts[1].url);
});

test('Tirupati: Advt. No. lifted out of the title, detail link kept, due date', async () => {
  const s = src('iiser-tirupati-projects');
  const { items, posts } = await crawl(htmlTable, s.id, {
    [s.url]: 'iiser-tirupati/projects-1.html',
    [s.pages.next.replace('{n}', '2')]: 'iiser-tvm/openings-2.html', // any page without rows of this table ends the read
  });
  assert.equal(items.length, 3);
  const p = posts[0];
  assert.equal(p.title, 'Project Assistant under DST, Govt. of India, Funded Project.');
  assert.equal(p.ref, '92/2026');
  assert.equal(p.facts.advt.value, '92/2026');
  assert.equal(p.deadline, '2026-12-04');
  assert.equal(p.url, 'https://www.iisertirupati.ac.in/jobs/advt_922026/');
});

test('Tirupati admissions page: one posting per current round, past rounds dropped', async () => {
  const s = src('iiser-tirupati-phd-admissions');
  const { posts } = await crawl(htmlPage, s.id, { [s.url]: 'iiser-tirupati/admission-phd.html' });
  assert.deepEqual(posts.map((p) => p.title), ['IISER Tirupati: ADMISSION TO Ph.D. PROGRAM – JANUARY 2027']);
  assert.equal(posts[0].rolling, false);
});

test('Kolkata and TVM admissions: PhD calls only, no result notices', async () => {
  for (const [id, file] of [['iiser-kolkata-admissions', 'iiser-kolkata/admission.html'], ['iiser-tvm-admissions', 'iiser-tvm/admission.html']]) {
    const s = src(id);
    const pages = { [s.url]: file };
    const http = site(pages);
    const rows = (s.adapter === 'html-list' ? htmlList.parseList : htmlTable.parseTable)(await fx(file), s, s.url);
    const kept = rows.filter((r) => new RegExp(s.match, 'i').test(r.title) && !(s.exclude && new RegExp(s.exclude, 'i').test(r.title)));
    assert.ok(kept.length >= 1, id);
    assert.ok(kept.every((r) => /ph\.?\s?d/i.test(r.title) && !/result|shortlist|selected/i.test(r.title)), `${id}: ${kept.map((r) => r.title).join(' | ')}`);
    assert.ok(!http.calls.length);
  }
});

test('PhD admissions calls show in the general-calls section of a physics topic search', async () => {
  const s = src('iiser-kolkata-admissions');
  const { posts } = await crawl(htmlList, s.id, { [s.url]: 'iiser-kolkata/admission.html' });
  const docs = posts.map((p, i) => ({ ...p, id: `k${i}`, firstSeen: '2026-11-20T00:00:00Z' }));
  const holo = { ...docs[0], id: 'h', title: 'Postdoc in holography', fields: ['hep-th'], categories: [{ category: 'postdoc', confidence: 'high' }], facts: {}, body: '' };
  const idx = buildIndex([holo, ...docs], { ...(await loadIndexConfig()), built: '2026-11-23T00:00:00Z' });
  const r = search(prepare(JSON.parse(JSON.stringify(idx))), 'holography', { today });
  assert.deepEqual(r.results.map((x) => x.doc.id), ['h']);
  assert.ok(r.general?.results.some((x) => /PhD Admission/.test(x.doc.t)), 'Kolkata PhD admissions listed as a general call');
});
