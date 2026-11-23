import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { makePdf } from './helpers/make-pdf.mjs';
import { pdfToText, pdfAdvert, attachPdfs, isResultNotice, usableText, PDF_MAX_PAGES } from '../crawler/lib/pdf.mjs';
import { dropGarbled, lineStats } from '../crawler/lib/garble.mjs';
import { extractDeadlineInfo } from '../crawler/lib/dates.mjs';
import { advertFacts, postDescription, advtAlias, normalizeAdvt } from '../crawler/lib/advert.mjs';
import { normalize } from '../crawler/lib/normalize.mjs';
import { Http } from '../crawler/lib/http.mjs';

const fx = (p) => readFile(new URL(`./fixtures/${p}`, import.meta.url), 'utf8');
const memCache = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); } }; };
const fakeHttp = (map) => ({ calls: [], async get(url) { this.calls.push(url); const r = map[url]; if (r instanceof Error) throw r; return { url, status: 200, contentType: r.type ?? 'application/pdf', body: r.body }; } });

// --- legacy Hindi fonts -------------------------------------------------------------------------
test('Kruti Dev lines ("Hkkjr" for भारत) are dropped; the English lines stay', async () => {
  const text = await fx('pdf/krutidev.txt');
  const { text: kept, dropped } = dropGarbled(text);
  assert.equal(dropped, 6);
  assert.ok(!/Hkkjrh|foKkiu|vkosnu|osru/.test(kept), kept);
  for (const l of ['Indian Institute of Science Education and Research', 'condensed matter physics', 'Upper age limit: 35 years', 'Last date for receipt of applications: 30.11.2026']) assert.ok(kept.includes(l), l);
});

test('real text in other languages and odd tokens is not taken for gibberish', () => {
  for (const l of [
    'GSI Helmholtzzentrum für Schwerionenforschung GmbH',
    '• sehr gute Kommunikations- und Kooperationsfähigkeit sowie Freude an der Zusammenarbeit mit Akteurinnen',
    'Le laboratoire recrute un postdoctorant en physique théorique pour une durée de deux ans',
    'A doctoral degree (e.g., PhD, ScD, DrPH, MD/PhD) in physics; IceCube-DeepCore, KM3NeT-ORCA, NOvA',
    'Skills and track-record:',
    '【Work location】 Skill Requirements：',
  ]) assert.equal(lineStats(l).garbled, false, l);
});

// --- deadlines ----------------------------------------------------------------------------------
test('deadline phrases: last date for receipt, on or before, walk-in, within N days of publication', () => {
  const d = (t, o) => extractDeadlineInfo(t, o);
  assert.deepEqual(d('Last date for receipt of applications: 30.11.2026. Walk-in on 05.12.2026'), { date: '2026-11-30', kind: 'deadline', confidence: 'medium', cue: 'Last date for receipt of applications', rank: 0 });
  assert.equal(d('send the application by email to x on or before 25.11.2026. Please mention').date, '2026-11-25');
  const w = d('Walk-in interviews will be held on 3rd December 2026 and 4th December 2026 at 10 AM');
  assert.equal(w.kind, 'walk-in');
  assert.equal(w.date, '2026-12-04', 'the last interview day');
  const r = d('Applications should reach the Registrar within 21 days of the publication of this advertisement.', { posted: '2026-11-10' });
  assert.deepEqual([r.date, r.kind, r.confidence], ['2026-12-01', 'relative', 'low']);
  assert.equal(d('within twenty one (21) days from the date of advertisement', { posted: '2026-11-10' }).date, '2026-12-01');
  assert.equal(d('within 21 days of publication'), null, 'no posted date, no guess');
});

// --- facts and snippets from a real PDF (trimmed excerpt) --------------------------------------
test('IISER Pune 86/2026: Advt. No., project, funding agency, age limit; snippet skips the letterhead', async () => {
  const { text } = usableText(await fx('pdf/iiser-pune-86-2026.txt'));
  const f = advertFacts(text);
  assert.deepEqual(f.advt, { value: '86/2026', confidence: 'medium' });
  assert.equal(f.project.value, 'Magnon Controlled Stochasticity for Secure Quantum Applications');
  assert.match(f.funding.value, /^United States-India Science & Technology Endowment/);
  assert.deepEqual(f.age.value, [35]);
  assert.equal(extractDeadlineInfo(text).date, '2026-11-25');
  const desc = postDescription(text);
  assert.match(desc, /^Institute invites applications from Indian nationals/);
  assert.ok(!/premier|Act of Parliament|ADVERTISEMENT NO/.test(desc.slice(0, 300)));
  assert.equal(advertFacts(text, { listRef: '86/2026' }).advt.confidence, 'high');
});

test('labelled PI, project, funding, age limit and relaxation', () => {
  const f = advertFacts('Principal Investigator: Dr. A. K. Sharma, Department of Physics\nProject Title: Quantum transport in twisted bilayers\nFunded by the Science and Engineering Research Board (SERB).\nThe upper age limit is 35 years, relaxable by 5 years for SC/ST candidates.');
  assert.deepEqual(f.pi, { value: 'Dr. A. K. Sharma', confidence: 'medium' });
  assert.equal(f.project.value, 'Quantum transport in twisted bilayers');
  assert.deepEqual(f.funding, { value: 'Science and Engineering Research Board (SERB)', confidence: 'low' });
  assert.deepEqual(f.age, { value: [35], confidence: 'medium' });
  assert.match(f.ageRelax.value, /relaxable by 5 years for SC\/ST/);
  assert.equal(advertFacts('presentation to the PI and team work').pi, undefined);
});

test('Advt. No. is a dedupe key within an institution, never across institutions or for boards', () => {
  assert.equal(normalizeAdvt('ADVERTISEMENT NO. : 88 / 2026'), '88/2026');
  const a = advtAlias({ institution: 'IISER Pune', ref: 'Advt. No. 88/2026' });
  assert.equal(a, 'advt:iiser pune:88/2026');
  assert.equal(advtAlias({ institution: 'IISER Pune', ref: '88 / 2026' }), a, 'same advert on another list page');
  assert.notEqual(advtAlias({ institution: 'IISER Kolkata', ref: '88/2026' }), a);
  assert.equal(advtAlias({ institution: 'IISER Pune', ref: '12' }), null, 'a bare serial repeats every year');
  assert.equal(advtAlias({ institution: 'X', ref: '1/2026', scheme: 'ajo' }), null);
});

test('result notices are recognised (their text names people, not a position)', () => {
  assert.ok(isResultNotice('ADVT. NO.: 76/2026\nCandidate selected for appointment purely on temporary and contractual Basis\nSr. No. Name'));
  assert.ok(isResultNotice('Result of the selection process\nPost Counsellor\nSelected Candidate(s)*'));
  assert.ok(!isResultNotice('Institute invites applications for the following post. Selected candidates will be informed by email.'.replace('Selected candidates', 'Shortlisted applicants')));
});

// --- pdftotext, caps and the fetch path ----------------------------------------------------------
test('pdftotext reads at most the first 10 pages', async () => {
  const pdf = makePdf(Array.from({ length: 12 }, (_, i) => `Page ${i + 1} of the advert`));
  const r = await pdfToText(pdf);
  assert.equal(r.pages, 12);
  assert.equal(r.readPages, PDF_MAX_PAGES);
  assert.match(r.text, /Page 10 of the advert/);
  assert.ok(!/Page 11/.test(r.text));
});

test('pdfAdvert: text once per URL (cached), notices emptied, non-PDFs and robots skips reported', async () => {
  const notice = makePdf(['Result of the walk-in interview held on 10.11.2026 for the post of Project Associate\nSelected candidates: A. Person']);
  const advert = makePdf(['Applications are invited for a Project Associate in condensed matter physics.\nLast date for receipt of applications: 30.11.2026']);
  const robots = Object.assign(new Error('robots'), { code: 'ROBOTS_DISALLOWED' });
  const http = fakeHttp({ 'https://x/a.pdf': { body: advert }, 'https://x/n.pdf': { body: notice }, 'https://x/h.pdf': { body: Buffer.from('<html>Not found</html>'), type: 'text/html' }, 'https://x/r.pdf': robots });
  const cache = memCache();
  const a = await pdfAdvert('https://x/a.pdf', { http, cache });
  assert.match(a.text, /condensed matter physics/);
  await pdfAdvert('https://x/a.pdf', { http, cache });
  assert.equal(http.calls.filter((u) => u === 'https://x/a.pdf').length, 1, 'fetched once');
  const n = await pdfAdvert('https://x/n.pdf', { http, cache });
  assert.equal(n.notice, true);
  assert.equal(n.text, '');
  assert.match((await pdfAdvert('https://x/h.pdf', { http, cache })).skipped, /^not a PDF \(text\/html\)/);
  assert.equal((await pdfAdvert('https://x/r.pdf', { http, cache })).skipped, 'robots.txt disallows');
});

test('attachPdfs: skips expired postings, reports skips, and the PDF text drives deadline and facts', async () => {
  const advert = makePdf(['Applications are invited for a Project Associate in condensed matter physics.\nAge limit: not more than 35 years.\nLast date for receipt of applications: 30.11.2026']);
  const http = fakeHttp({ 'https://x/a.pdf': { body: advert }, 'https://x/old.pdf': { body: advert }, 'https://x/big.pdf': Object.assign(new Error('big'), { code: 'TOO_LARGE', bytes: 20e6 }) });
  const items = [
    { source: 's', sourceId: 's:1', url: 'https://x/1', title: 'Project Associate', institution: 'IISER Pune', pdfUrls: ['https://x/a.pdf', 'https://x/big.pdf'] },
    { source: 's', sourceId: 's:2', url: 'https://x/2', title: 'Old post', deadline: '2025-01-01', pdfUrls: ['https://x/old.pdf'] },
  ];
  const rep = await attachPdfs(items, { http, cache: memCache(), log: () => {}, today: '2026-11-23' });
  assert.equal(rep.fetched, 1);
  assert.deepEqual(rep.skipped.map((s) => s.reason), ['over 15 MB (19.1 MB or more)']);
  assert.ok(!http.calls.includes('https://x/old.pdf'), 'expired: not fetched');
  const p = normalize(items[0], { categorize: () => [{ category: 'other', confidence: 'low' }], fieldsOf: () => [], sourceName: 'IISER Pune' });
  assert.equal(p.deadline, '2026-11-30');
  assert.deepEqual(p.deadlineInfo, { kind: 'deadline', confidence: 'medium', from: 'pdf' });
  assert.deepEqual(p.facts.age.value, [35]);
  assert.match(p.snippet, /^Applications are invited for a Project Associate in condensed matter physics/);
});

test('http maxBytes: a declared or streamed size over the cap stops the download', async () => {
  const big = Buffer.alloc(300_000, 65);
  const srv = createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    if (req.url === '/declared.pdf') { res.writeHead(200, { 'content-length': big.length, 'content-type': 'application/pdf' }); return res.end(big); }
    res.writeHead(200, { 'content-type': 'application/pdf' }); // chunked, no length
    res.write(big.subarray(0, 150_000)); res.end(big.subarray(150_000));
  }).listen(0);
  try {
    const http = new Http({ log: () => {} });
    const base = `http://localhost:${srv.address().port}`;
    for (const p of ['/declared.pdf', '/streamed.pdf']) {
      await assert.rejects(http.get(base + p, { binary: true, conditional: false, maxBytes: 100_000 }), (e) => e.code === 'TOO_LARGE', p);
    }
    const ok = await http.get(`${base}/streamed.pdf`, { binary: true, conditional: false, maxBytes: 1_000_000 });
    assert.equal(ok.body.length, big.length);
  } finally { srv.close(); }
});
