import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as inspire from '../crawler/adapters/inspire.mjs';
import * as ajo from '../crawler/adapters/ajo.mjs';
import * as htmlList from '../crawler/adapters/html-list.mjs';
import * as htmlPage from '../crawler/adapters/html-page.mjs';
import { loadConfig } from '../crawler/lib/config.mjs';

const fx = (p) => readFile(new URL(`./fixtures/${p}`, import.meta.url), 'utf8');
const { sources } = await loadConfig();
const src = (id) => sources.find((s) => s.id === id);
const memCache = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); } }; };
const quiet = () => {};

test('INSPIRE: fields, ranks, weak AJO aliases, no contact details', async () => {
  const page = JSON.parse(await fx('inspire/page1.json'));
  page.links.next = null;
  const http = { json: async () => ({ data: page }) };
  const items = await inspire.crawl(src('inspire'), { http, log: quiet });
  assert.equal(items.length, page.hits.hits.length);
  const it = items[0];
  assert.match(it.url, /^https:\/\/inspirehep\.net\/jobs\/\d+$/);
  assert.ok(it.title && it.institution && Array.isArray(it.values));
  assert.ok(items.every((i) => !JSON.stringify(i).includes('contact_details')));
  for (const i of items) for (const a of i.weakAliases) assert.match(a, /academicjobsonline|mathjobs|inspirehep/);
});

test('AJO: deadline falls back to close date, type validated', async () => {
  const page = JSON.parse(await fx('ajo/page1.json'));
  const http = { json: async () => ({ data: { ...page, total_count: page.results.length } }) };
  const items = await ajo.crawl({ ...src('ajo'), pageSize: 500 }, { http, log: quiet });
  assert.equal(items.length, page.results.length);
  const lbl = items.find((i) => i.sourceId === 'ajo:32681');
  assert.equal(lbl.deadline, '2026-12-18'); // deadline_raw is 0000-00-00
  assert.deepEqual(lbl.values, ['Postdoctoral']);
  assert.equal(lbl.country, 'US');
  assert.ok(lbl.body.length > 20 && !lbl.body.includes('<')); // fixture text is trimmed
});

test('IISER Pune list: rows, ref, bilingual title, dates', async () => {
  const s = src('iiser-pune-openings');
  const rows = htmlList.parseList(await fx('iiser-pune/openings.html'), s, s.url);
  assert.ok(rows.length >= 200, `only ${rows.length} rows`);
  const r = rows.find((x) => x.url.endsWith('id=2318'));
  assert.equal(r.ref, '88/2026');
  assert.equal(r.deadline, '2026-11-27');
  assert.equal(r.posted, '2026-11-18');
});

test('IISER Pune crawl: English title, detail text and PDF, cached detail', async () => {
  const s = src('iiser-pune-openings');
  const list = await fx('iiser-pune/openings.html');
  const detail = await fx('iiser-pune/opening-2318.html');
  const calls = [];
  const http = { get: async (url) => { calls.push(url); return { body: url === s.url ? list : detail, url }; } };
  const cache = memCache();
  const today = '2026-11-22';
  const items = await htmlList.crawl({ ...s, list: { ...s.list } }, { http, log: quiet, cache, today });
  const it = items.find((x) => x.url.endsWith('id=2318'));
  assert.match(it.title, /ANRF Project Associate-I/); // raw; englishTitle runs in normalize
  assert.match(it.body, /Physics/);
  assert.match(it.pdfUrls[0], /\/storage\/recruitment\/job-posts\/2318\/.*\.pdf$/);
  // A second crawl fetches no detail pages: everything is cached.
  calls.length = 0;
  await htmlList.crawl(s, { http, log: quiet, cache });
  assert.deepEqual(calls, [s.url]);
});

test('standing call page becomes one rolling posting', async () => {
  const s = src('iiser-pune-postdoc');
  const text = htmlPage.parsePage(await fx('iiser-pune/postdoctoral-research.html'), s);
  assert.match(text, /Postdoctoral Research Associate/);
  assert.ok(!/Explore ways of giving/.test(text), 'footer must not leak into the text');
});

test('INSPIRE: institution abbreviations become full names (bulk lookup, cached), the ICN stays searchable', async () => {
  const page = JSON.parse(await fx('inspire/page1.json'));
  page.links.next = null;
  const ref = /\/institutions\/(\d+)/.exec(page.hits.hits[0].metadata.institutions[0].record.$ref)[1];
  const inst = { hits: { hits: [{ metadata: { control_number: Number(ref), legacy_ICN: 'U. Hamburg (main)', institution_hierarchy: [{ name: 'II. Institut für Theoretische Physik' }, { name: 'Universität Hamburg' }], addresses: [{ country_code: 'DE' }] } }] } };
  const calls = [];
  const http = { json: async (url) => { calls.push(url); return { data: url.includes('/api/institutions') ? inst : page }; } };
  const cache = memCache();
  const items = await inspire.crawl(src('inspire'), { http, log: quiet, cache });
  const it = items.find((i) => i.institutionAlt?.startsWith('U. Hamburg (main)'));
  assert.ok(it, 'first job is at U. Hamburg');
  assert.match(it.institution, /^Universität Hamburg, II\. Institut für Theoretische Physik/);
  assert.equal(it.country, 'DE');
  assert.equal(calls.filter((u) => u.includes('/api/institutions')).length, 1, 'one bulk request');
  calls.length = 0;
  await inspire.crawl(src('inspire'), { http, log: quiet, cache });
  assert.ok(!calls.some((u) => u.includes(`control_number%3A(${ref}`) || u.includes(`${ref}%20OR`) || u.includes(`${ref})`)), 'cached ids are not looked up again');
});

test('MathJobs: same feed as AJO; type validated ("BEGIN" dropped), close date when the deadline is 0000-00-00', async () => {
  const page = JSON.parse(await fx('mathjobs/page1.json'));
  const http = { json: async () => ({ data: { ...page, total_count: page.results.length } }) };
  const items = await ajo.crawl(src('mathjobs'), { http, log: quiet });
  assert.equal(items.length, page.results.length);
  const pd = items.find((i) => i.sourceId === 'mathjobs:29253');
  assert.equal(pd.deadline, '2026-10-30');
  assert.deepEqual(pd.values, ['Postdoctoral']);
  assert.ok(pd.aliases.includes('https://mathjobs.org/jobs/list/29253'));
  const begin = items.find((i) => i.sourceId === 'mathjobs:27107');
  assert.deepEqual(begin.values, []);
  assert.equal(begin.deadline, '2027-06-30');
  assert.ok(items.every((i) => i.body.length < 600), 'fixture text is trimmed');
});
