// Phase 7: Indian research institutes. Category rules, rolling calls, institution aliases, the
// per-host headers and the abortable watchdog. Source fixtures are tested further down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../crawler/lib/config.mjs';
import { makeCategorizer, makeFieldTagger } from '../crawler/lib/categorize.mjs';
import { rollingCue } from '../crawler/lib/dates.mjs';
import { normalize } from '../crawler/lib/normalize.mjs';
import { makeInstitutionKey, sameInstitution } from '../crawler/lib/dedupe.mjs';
import { Http, checkSourceHeaders } from '../crawler/lib/http.mjs';
import { withWatchdog } from '../crawler/lib/watchdog.mjs';
import { caExpiries } from '../crawler/lib/ca.mjs';

const cfg = await loadConfig();
const cat = makeCategorizer(cfg.categories);
const fieldsOf = makeFieldTagger(cfg.fields);
const simple = (r) => r.map((c) => `${c.category}:${c.confidence}`);
const norm = (raw) => normalize({ source: 'x', sourceId: 'x:1', url: 'https://example.org/a', institution: 'IMSc', ...raw }, { categorize: cat, fieldsOf, sourceName: 'x' });

// ---- categories ---------------------------------------------------------------------------

test('Visiting Fellow / Visiting Scientist (TIFR, ICTS, IUCAA style) is a postdoc, medium', () => {
  assert.deepEqual(simple(cat({ title: 'Visiting Fellow positions in the Department of Theoretical Physics' })), ['postdoc:medium']);
  assert.deepEqual(simple(cat({ title: 'Visiting Scientist (Astronomy & Astrophysics)' })), ['postdoc:medium']);
  assert.deepEqual(simple(cat({ title: 'Visiting Fellowship for senior faculty' })), ['faculty:medium', 'fellowship:medium'], '"Visiting Fellowship" is not the post');
});

test('INSPIRE VISITOR is a postdoc at an Indian research institute or when the text says postdoctoral', () => {
  assert.deepEqual(simple(cat({ scheme: 'inspire', values: ['VISITOR'], title: 'Visiting Fellow', institution: 'Tata Institute of Fundamental Research; TIFR, Mumbai, Dept. Theor. Phys.' })), ['postdoc:medium']);
  assert.deepEqual(simple(cat({ scheme: 'inspire', values: ['VISITOR'], title: 'Positions 2027', institution: 'International Centre for Theoretical Sciences, Tata Institute of Fundamental Research; ICTS, Bangalore' })), ['postdoc:medium']);
  assert.deepEqual(simple(cat({ scheme: 'inspire', values: ['VISITOR'], title: 'Research visit', body: 'A two-year postdoctoral visitor position.', institution: 'CERN' })), ['postdoc:medium']);
  assert.deepEqual(simple(cat({ scheme: 'inspire', values: ['VISITOR'], title: 'Summer visitor programme', body: 'Short visits for faculty.', institution: 'CERN' })), ['other:high']);
});

test('Research Associate at SINP, ISI and JNCASR is a postdoc', () => {
  assert.deepEqual(simple(cat({ title: 'Advertisement for the post of Research Associate in Theoretical Physics Division (Advt. No. 12/2026)' })), ['postdoc:medium']);
  assert.deepEqual(simple(cat({ title: 'Recruitment to the post of Research Associate (RA)' })), ['postdoc:medium']);
  assert.deepEqual(simple(cat({ title: 'Advertisement for a Research Associate (RA-I/II/III) under Prof. Ganesh Subramanian' })), ['postdoc:medium']);
});

test('DAE grades Reader-F, Fellow-E/F/G and Scientific Officer are faculty', () => {
  for (const t of ['Reader-F (Theoretical Physics)', 'Reader F', 'Fellow-E in the School of Natural Sciences', 'Fellow F / Fellow G', 'Scientific Officer-D (Physics)', 'Scientific Officer E']) {
    assert.deepEqual(simple(cat({ title: t })), ['faculty:medium'], t);
  }
  assert.deepEqual(simple(cat({ title: 'Postdoctoral fellow eligibility' })), ['postdoc:medium'], '"fellow e…" is not Fellow-E');
});

test('N-PDF, Ramanujan and INSPIRE Faculty are fellowships; INSPIRE Faculty is not a faculty post', () => {
  assert.deepEqual(simple(cat({ title: 'ANRF N-PDF applications endorsed by the institute' })), ['postdoc:medium', 'fellowship:medium']);
  assert.deepEqual(simple(cat({ title: 'Ramanujan Fellowship 2027' })), ['fellowship:medium']);
  assert.deepEqual(simple(cat({ title: 'DST INSPIRE Faculty Fellowship: host institute' })), ['fellowship:medium']);
  assert.deepEqual(simple(cat({ title: 'INSPIRE-Faculty scheme' })), ['fellowship:medium']);
  assert.deepEqual(simple(cat({ title: 'Faculty positions at ICTS-TIFR' })), ['faculty:medium'], 'plain faculty still counts');
});

// ---- rolling calls --------------------------------------------------------------------------

test('rolling-call phrases', () => {
  for (const t of [
    'Applications are accepted throughout the year.',
    'Positions for which we are accepting applications throughout the year',
    'Selection Timeline: Applications are accepted all year round.',
    'Applications will be considered on a rolling basis.',
    'There is no last date for this call.',
    'Candidates may apply at any time.',
    'Applications can be submitted at any time of the year.',
  ]) assert.ok(rollingCue(t), t);
});

test('not rolling: small print with "at any time", and ordinary deadlines', () => {
  for (const t of [
    'The Institute reserves the right to cancel the advertisement at any time without assigning any reason.',
    'The appointment may be terminated at any time with one month notice. Applications should reach us by 30.11.2026.',
    'The last date for receipt of applications is 15 December 2026.',
    'Interviews are held twice a year.',
  ]) assert.equal(rollingCue(t), null, t);
});

test('rolling precedence: a list deadline wins; an explicit text deadline wins; else the rolling phrase beats walk-in dates', () => {
  const listDl = norm({ title: 'Postdoc', deadline: '2026-12-31', body: 'Applications are accepted throughout the year.' });
  assert.equal(listDl.deadline, '2026-12-31');
  assert.equal(listDl.rolling, false);
  const textDl = norm({ title: 'Postdoc', body: 'Applications are accepted throughout the year. Last date for receipt of applications: 15.12.2026.' });
  assert.equal(textDl.deadline, '2026-12-15');
  assert.equal(textDl.rolling, false);
  const roll = norm({ title: 'Postdoc', body: 'Applications are accepted all year round. Walk-in interview on 03.02.2025.' });
  assert.equal(roll.deadline, null);
  assert.equal(roll.rolling, true);
  assert.deepEqual(roll.rollingInfo, { from: 'page', cue: 'all year round', confidence: 'medium' });
  const board = norm({ scheme: 'ajo', values: ['Postdoctoral'], title: 'Postdoc', body: 'Applications are reviewed on a rolling basis. Apply by 1 Jan 2027.' });
  assert.equal(board.deadline, null, 'boards never take text dates');
  assert.equal(board.rolling, true);
  const source = norm({ title: 'Regular Faculty', rolling: true, body: 'The last date for receipt of applications is February 16, 2025.' });
  assert.equal(source.rolling, true, 'a rolling table row ignores old dates in its prose');
  assert.equal(source.deadline, null);
});

// ---- aliases --------------------------------------------------------------------------------

test('aliases: INSPIRE full names and ICNs, AJO spellings and the institute page agree', () => {
  const key = makeInstitutionKey(cfg.institutions.aliases);
  const same = (a, b) => sameInstitution(key(a), key(b));
  assert.ok(same('International Centre for Theoretical Sciences', 'Tata Institute of Fundamental Research, International Centre for Theoretical Sciences'));
  assert.ok(same('International Centre for Theoretical Sciences', 'International Centre for Theoretical Sciences, Tata Institute of Fundamental Research; ICTS, Bangalore'));
  assert.ok(same('The Institute of Mathematical Sciences', 'Institute of Mathematical Sciences; IMSc, Chennai'));
  assert.ok(same('Saha Institute of Nuclear Physics', 'Saha Inst.'));
  assert.ok(same('Raman Research Institute', 'Raman Research Inst., Bangalore'));
  assert.ok(same('Inter-University Centre for Astronomy and Astrophysics', 'IUCAA, Pune'));
  assert.ok(same('Harish-Chandra Research Institute', 'Harish-Chandra Res. Inst.'));
  // INSPIRE's record name for IOP is just "Institute of Physics": only the ICN identifies it.
  assert.ok(same('Institute of Physics, Bhubaneswar', 'Institute of Physics; Bhubaneswar, Inst. Phys.'));
  assert.ok(!same('Institute of Physics, Bhubaneswar', 'Institute of Physics, Zagreb'));
  assert.ok(!same('International Centre for Theoretical Sciences', 'Tata institute of fundamental research, Department of theoretical physics'), 'ICTS is not TIFR DTP');
  // TIFR-H and TIFR Mumbai share the words "tata" and "fundamental", so they may be compared (the
  // block is a prefilter; a merge still needs the deadline and text checks), but their keys differ.
  const kh = key('Tata Institute of Fundamental Research, Hyderabad').keys;
  assert.ok(![...key('Tata institute of fundamental research, Department of theoretical physics').keys].some((k) => kh.has(k)), 'TIFR-H key is not TIFR Mumbai');
  const kk = key('Indian Statistical Institute, Kolkata').keys;
  assert.ok(![...key('Indian Statistical Institute, Bangalore').keys].some((k) => kk.has(k)), 'the two ISI centres keep separate keys');
});

test('aliases with commas stay whole (a YAML flow list would split "IMSc, Chennai")', () => {
  const all = Object.values(cfg.institutions.aliases).flat();
  for (const frag of ['Chennai', 'Bangalore', 'Pune', 'Kolkata', 'Beijing', 'St. Louis', 'Pasadena (main)']) assert.ok(!all.includes(frag), frag);
});

// ---- http: per-host headers, watchdog ---------------------------------------------------------

const server = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => resolve({ s, base: `http://127.0.0.1:${s.address().port}` }));
});
const permissive = (base) => ({ [base]: { fetched: new Date().toISOString(), status: 200, body: 'User-agent: *\nDisallow:\n' } });

test('sources may set ordinary Accept headers for their host (SINP: Accept-Encoding identity), nothing else', async () => {
  assert.throws(() => checkSourceHeaders({ 'User-Agent': 'Mozilla/5.0' }, 'x'), /not allowed/);
  assert.throws(() => checkSourceHeaders({ Cookie: 'a=b' }, 'x'), /not allowed/);
  assert.doesNotThrow(() => checkSourceHeaders({ 'Accept-Encoding': 'identity', Accept: 'text/html', 'Accept-Language': 'en' }));
  const sinp = cfg.sources.find((s) => s.id === 'sinp');
  assert.deepEqual(sinp.headers, { 'Accept-Encoding': 'identity' });
  let seen;
  const { s, base } = await server((req, res) => { if (req.url === '/robots.txt') { res.end('User-agent: *\nDisallow:\n'); return; } seen = req.headers; res.end('ok'); });
  try {
    const c = new Http({ minGapMs: 0, retries: 0, robotsCache: {} });
    c.setHostHeaders(new URL(base).host, sinp.headers);
    await c.get(`${base}/web/job-opportunities`);
    assert.equal(seen['accept-encoding'], 'identity');
    assert.match(seen['user-agent'], /^academic-jobs\/0\.1 \(\+https:\/\/github\.com\/bhaskarspace\/academic-jobs\/issues\)$/);
  } finally { s.close(); }
});

test('ARIES watchdog: a host that never answers is cut off at the limit, and its requests are aborted', async () => {
  const open = new Set();
  let hits = 0;
  const { s, base } = await server((req, res) => { if (req.url === '/robots.txt') { res.end('User-agent: *\nDisallow:\n'); return; } hits++; open.add(res); /* never answers */ });
  try {
    const c = new Http({ minGapMs: 0, retries: 2, timeoutMs: 60_000, robotsCache: permissive(base) });
    const t0 = Date.now();
    const crawl = (signal) => (async () => { const h = c.withSignal(signal); for (let i = 0; i < 5; i++) await h.get(`${base}/page${i}`); return []; })();
    await assert.rejects(withWatchdog(crawl, 300, 'aries'), (e) => e.code === 'WATCHDOG');
    assert.ok(Date.now() - t0 < 2000, 'gave up at the limit, not after the 60 s request timeout');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(hits, 1, 'no further requests after the watchdog fired (no retries, no next page)');
    // An unrelated source on the same client still works.
    const ok = await withWatchdog(async () => 'done', 1000, 'other');
    assert.equal(ok, 'done');
  } finally { for (const r of open) r.destroy(); s.close(); }
});

test('ARIES: its source has a short watchdog and its missing intermediate is in config/ca/', () => {
  const aries = cfg.sources.find((s) => s.id === 'aries');
  assert.equal(aries.timeoutMin, 5);
  const cert = caExpiries().find((c) => c.file === 'globalsign-gcc-r46-alphassl-2025.pem');
  assert.ok(cert, 'intermediate loaded by ca.mjs');
  assert.equal(cert.subject, 'GlobalSign GCC R46 AlphaSSL CA 2025');
  assert.ok(cert.daysLeft > 30);
});

test('robots verdicts: IACS, IMSc other_positions, CMI, TIFR, HRI, IPR and PRL are link-outs; NISER, JNCASR and IIA never fetch PDFs', () => {
  const by = Object.fromEntries(cfg.sources.map((s) => [s.id, s]));
  for (const id of ['iacs', 'imsc-programmes', 'imsc-other', 'isi-kolkata-linkout', 'cmi', 'tifr', 'hri', 'ipr', 'prl']) {
    assert.equal(by[id].adapter, 'link-out', id);
    assert.ok(by[id].note, `${id} says why`);
  }
  for (const id of ['niser-fixed-term', 'jncasr', 'iia']) assert.equal(by[id].pdfs, false, id);
  // Runner-blocked: configured and fixture-tested, but not crawled until they answer.
  for (const id of ['imsc-postdoc', 'imsc-faculty', 'isi-kolkata']) assert.equal(by[id].enabled, false, id);
});

// ---- source fixtures (trimmed pages fetched 2026-11-24) --------------------------------------

import { readFile } from 'node:fs/promises';
import * as htmlList from '../crawler/adapters/html-list.mjs';
import * as htmlTable from '../crawler/adapters/html-table.mjs';
import * as htmlPage from '../crawler/adapters/html-page.mjs';
import * as rss from '../crawler/adapters/rss.mjs';
import { findDuplicates } from '../crawler/lib/dedupe.mjs';

const ADAPTER = { 'html-list': htmlList, 'html-table': htmlTable, 'html-page': htmlPage, rss };
const src = (id) => cfg.sources.find((s) => s.id === id);
const fx = (p) => readFile(new URL(`./fixtures/${p}`, import.meta.url), 'utf8');
const today = '2026-11-24';
/** Crawl one source from fixtures: {url: file}, '' standing for the source URL. Unknown URLs 404. */
async function crawlFx(id, pages) {
  const s = src(id);
  const map = Object.fromEntries(Object.entries(pages).map(([k, v]) => [k || s.url, v]));
  const calls = [];
  const h = { get: async (u) => { calls.push(u); if (!(u in map)) throw Object.assign(new Error(`unexpected ${u}`), { code: 'HTTP_404' }); return { url: u, status: 200, body: await fx(map[u]) }; } };
  const m = new Map();
  const items = await ADAPTER[s.adapter].crawl(s, { http: h, log: () => {}, cache: { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); } }, today });
  const posts = items.map((it) => normalize(it, { categorize: cat, fieldsOf, sourceName: s.name }));
  return { items, posts, calls, find: (re) => posts.find((p) => re.test(p.title)) };
}
const cats = (p) => simple(p.categories).join(',');

test('ICTS: postings from the opportunities grid, deadline from the detail page', async () => {
  const { posts, find } = await crawlFx('icts-opportunities', {
    '': 'icts/opportunities.html',
    'https://www.icts.res.in/opportunities/postdoc-prog2027': 'icts/postdoc-prog2027.html',
    'https://www.icts.res.in/opportunities/posdoc-pos': 'icts/posdoc-pos.html',
  });
  assert.equal(posts.length, 7);
  const pd = find(/^ICTS Postdoctoral Program 2027/);
  assert.equal(pd.deadline, '2026-11-30');
  assert.equal(pd.posted ? pd.posted <= today : true, true);
  assert.equal(cats(pd), 'postdoc:medium');
  assert.equal(cats(find(/S\. N\. Bhatt Memorial Excellence Fellowship/)), 'fellowship:medium');
  assert.equal(cats(find(/^Faculty positions at ICTS/)), 'faculty:medium');
  assert.equal(find(/Ministry of Earth Sciences/).deadline, '2026-11-30');
});

test('ICTS Postdoctoral Program 2027: the ICTS page, INSPIRE and AJO merge into one posting', async () => {
  const raw = JSON.parse(await fx('dedupe/icts.json'));
  const ps = raw.map((r, i) => ({ id: `p${i}`, firstSeen: `2026-11-1${i}`, sources: [{ source: r.source, sourceId: r.sourceId }], ...r }));
  const dups = findDuplicates(ps, cfg.institutions);
  const groups = new Map(ps.map((p) => [p.id, new Set([p.sourceId])]));
  for (const { keep, drop } of dups) { for (const x of groups.get(drop)) groups.get(keep).add(x); groups.delete(drop); }
  assert.deepEqual([...groups.values()].map((g) => [...g].sort().join(' + ')),
    ['ajo:33081 + icts-opportunities:https://www.icts.res.in/opportunities/postdoc-prog2027 + inspire:3218317']);
});

test('IMSc: the postdoc programme is a rolling call; the faculty page reads its deadline from the text', async () => {
  const pd = (await crawlFx('imsc-postdoc', { '': 'imsc/post_doctoral_programme.html' })).posts[0];
  assert.equal(pd.rolling, true);
  assert.equal(pd.deadline, null);
  assert.match(cats(pd), /^postdoc:high/);
  assert.ok(pd.fields.includes('hep-th'));
  const fac = (await crawlFx('imsc-faculty', { '': 'imsc/facultyrecruitment.html' })).posts[0];
  assert.equal(fac.rolling, false);
  assert.equal(fac.deadline, '2026-11-15');
  assert.equal(cats(fac), 'faculty:high');
});

test('IOP Bhubaneswar RSS: postdoc/RA adverts by group; result notices filtered out', async () => {
  const { posts, items } = await crawlFx('iop', { '': 'iop/job_opening.rss' });
  assert.equal(posts.length, 7);
  assert.equal(items.partial, true, 'a newest-10 feed');
  assert.ok(!posts.some((p) => /short-?listed|results/i.test(p.title)));
  const cmt = posts.find((p) => /Condensed Matter Physics Theory/.test(p.title));
  assert.equal(cats(cmt), 'postdoc:medium');
});

test('SINP: RA adverts kept, merit lists / Hindi copies / undated old rows dropped, closing date in the title', async () => {
  const { posts, find } = await crawlFx('sinp', { '': 'sinp/job-opportunities.html' });
  assert.ok(!posts.some((p) => /merit list|hindi version|counsellor|swarna jayanti|chanakya/i.test(p.title)), posts.map((p) => p.title).join('\n'));
  const ra = find(/Advt\. No\. 13\/2026/);
  assert.equal(ra.deadline, '2026-09-13');
  assert.equal(ra.deadlineInfo.from, 'list', 'read from "Closing Date: 13.09.2026" in the list title');
  assert.equal(cats(ra), 'postdoc:medium');
  assert.match(ra.url, /saha\.ac\.in\/web\/portal\/applications\/vacancy\/file\//);
});

test('RRI and IUCAA: standing postdoc and faculty calls are rolling; IUCAA dated openings keep their deadline', async () => {
  const rri = (await crawlFx('rri-postdoc', { '': 'rri/post-doctoral-fellowships.html' })).posts[0];
  assert.equal(rri.rolling, true);
  const { posts, find } = await crawlFx('iucaa', { '': 'iucaa/opportunities.html' });
  for (const t of [/^Regular Faculty$/, /^Post-doctoral Fellowships$/, /UV \/ Optical \/ IR Instrumentation/]) {
    const p = find(t);
    assert.equal(p.rolling, true, t);
    assert.equal(p.deadline, null, `${t}: the old rounds in its prose don't date it`);
  }
  assert.match(cats(find(/^Post-doctoral Fellowships$/)), /^postdoc:medium/);
  assert.equal(find(/Scientific Trainee \(AstroSat/).deadline, '2026-12-04');
  assert.ok(!posts.some((p) => /administrative|section officer/i.test(p.title)));
  assert.ok(posts.every((p) => p.pdfUrls.every((u) => /\.pdf($|\?)/.test(u))), 'the "Apply Online" form links are not PDFs');
});

test('S.N. Bose, TIFR-H, NCRA, NISER, JNCASR and IIA tables', async () => {
  const bose = (await crawlFx('bose', { '': 'bose/job-openings.html' })).posts;
  assert.equal(bose.length, 1);
  assert.equal(bose[0].deadline, '2026-12-10');
  assert.equal(bose[0].ref, 'SNB/Advt/26-27/011');
  const th = (await crawlFx('tifrh-postdoc', { '': 'tifrh/post-doctoral-and-visiting-positions.html' })).posts;
  assert.deepEqual(th.map((p) => p.title), ['Post-Doctoral Fellow'], 'header row in <td>s is not a posting');
  assert.match(cats(th[0]), /^postdoc:high/);
  const ncra = (await crawlFx('ncra-postdoc', { '': 'ncra/pdf.html', 'https://www.ncra.tifr.res.in/jobs/academic/opportunities/jawaharlal-nehru-post-doctoral-fellowships': 'ncra/jawaharlal-nehru.html' })).posts;
  assert.deepEqual(ncra.map((p) => p.title).sort(), ['Jawaharlal Nehru Post-Doctoral Fellowships', 'Open Post-Doctoral Fellowships']);
  const niser = await crawlFx('niser-fixed-term', { '': 'niser/ft-cr.html' });
  assert.equal(niser.find(/^JRF in EPS/).deadline, '2026-11-26');
  assert.ok(niser.items.every((it) => it.noPdfFetch), 'robots.txt disallows /storage/');
  const jn = await crawlFx('jncasr', { '': 'jncasr/announcements.html', 'https://www.jncasr.ac.in/announcements/advertisement-research-associate-ra-iiiiii-under-prof-ganesh-subramanian': 'jncasr/ra-ganesh-subramanian.html' });
  assert.equal(jn.posts.length, 1, 'non-job announcements filtered out');
  assert.equal(cats(jn.posts[0]), 'postdoc:medium');
  assert.ok(jn.items[0].noPdfFetch);
  const iia = await crawlFx('iia', { '': 'iia/iia_jobs.html' });
  assert.equal(iia.posts[0].title, 'Research Trainee (Observations)', 'not the POSTED ON date');
  assert.equal(iia.posts[0].deadline, '2026-12-09');
  assert.equal(iia.posts[0].ref, 'IIA/14/2026-27');
  assert.ok(iia.items[0].noPdfFetch, 'robots.txt disallows /*.pdf$');
});

test('ISI Kolkata and Bangalore: title without the description, RA as postdoc, PDFs from the homepage list', async () => {
  const k = await crawlFx('isi-kolkata', { '': 'isi-kolkata/jobs.html', 'https://www.isical.ac.in/isical_web/public/jobs_view.php?id=96': 'isi-kolkata/jobs_view-96.html' });
  const ra = k.find(/Research Associate/);
  assert.equal(ra.title, 'Recruitment to the post of Research Associate (RA)');
  assert.equal(ra.deadline, '2026-12-13');
  assert.equal(cats(ra), 'postdoc:medium');
  assert.ok(!k.posts.some((p) => /doctor|ophthalmolog/i.test(p.title)));
  const b = await crawlFx('isi-bangalore', { '': 'isi-bangalore/home.html' });
  assert.ok(!b.posts.some((p) => /application format|instructions|physician/i.test(p.title)));
  const pd = b.find(/Post Doc Fellow/);
  assert.equal(cats(pd), 'postdoc:medium');
  assert.deepEqual(pd.pdfUrls, ['https://www.isibang.ac.in/Job_Notifications/PDF.pdf']);
});

test('ARIES: current adverts above the table, "[Last date: …]" read from the list, old rows skip their detail page', async () => {
  const { posts, find, calls } = await crawlFx('aries', { '': 'aries/project-position.html', 'https://www.aries.res.in/adityaL1PostDocPositions2026': 'aries/adityaL1PostDocPositions2026.html' });
  const pd = find(/^Advertisement for Postdoctoral Positions under the Aditya-L1/);
  assert.equal(pd.deadline, '2026-06-05');
  assert.equal(cats(pd), 'postdoc:medium');
  assert.ok(!posts.some((p) => /selection|shortlisted/i.test(p.title)));
  assert.ok(!calls.includes('https://www.aries.res.in/adityaL1PostDocPositions2026'), 'expired by its list date, so no detail fetch');
  assert.ok(!calls.includes('https://www.aries.res.in/ProjectAssociate_software2026'));
});

test('IISc contractual table: advert PDF as the URL, closing date as the deadline', async () => {
  const { posts } = await crawlFx('iisc-contractual', { '': 'iisc/contractual-positions.html' });
  assert.equal(posts.length, 4);
  const lim = posts.find((p) => /^Library and Information Management/.test(p.title));
  assert.equal(lim.deadline, '2026-11-19');
  assert.equal(lim.posted, '2026-10-29');
  assert.match(lim.url, /wp-content\/uploads\/.*\.pdf$/);
});

// ---- review-start dates and display names (PR #11 review) --------------------------------------

import { reviewStart } from '../crawler/lib/dates.mjs';
import { buildIndex } from '../search/build-index.mjs';
import { compileDisplay, displayInstitution } from '../crawler/lib/display.mjs';

test('a stated last date beats a rolling phrase; a review-start date of an until-filled call stays rolling ("review from")', async () => {
  const of = async (f, raw = {}) => {
    const [title, ...rest] = (await fx(`rolling/${f}.txt`)).trim().split('\n');
    return norm({ title, body: rest.join('\n'), ...raw });
  };
  const last = await of('last-date-beats-rolling');
  assert.equal(last.deadline, '2026-12-15');
  assert.equal(last.rolling, false);
  assert.equal(last.reviewFrom, null);
  for (const [f, date] of [['review-begins', '2026-12-01'], ['first-consideration', '2027-01-15'], ['priority-deadline', '2027-01-10']]) {
    const p = await of(f);
    assert.equal(p.rolling, true, f);
    assert.equal(p.deadline, null, `${f}: the review date is not a deadline`);
    assert.equal(p.reviewFrom, date, f);
  }
  const both = await of('review-with-separate-closing-date');
  assert.equal(both.deadline, '2027-01-31', 'a separate closing date is still the deadline');
  assert.equal(both.rolling, false);
  const noFill = await of('consideration-without-until-filled');
  assert.equal(noFill.rolling, false, 'no "until filled": not a standing call');
  // Boards: no deadline field, review-start text → rolling with the review date; a deadline field still wins.
  const body = (await fx('rolling/review-begins.txt')).split('\n').slice(1).join('\n');
  const ajo = norm({ scheme: 'ajo', values: ['Postdoctoral'], title: 'Postdoc', body });
  assert.deepEqual([ajo.rolling, ajo.deadline, ajo.reviewFrom], [true, null, '2026-12-01']);
  const ajoDl = norm({ scheme: 'ajo', values: ['Postdoctoral'], title: 'Postdoc', body, deadline: '2026-12-01' });
  assert.deepEqual([ajoDl.rolling, ajoDl.deadline], [false, '2026-12-01']);
  assert.equal(reviewStart('Review begins 1 Dec 2026.'), null);
  // The card record carries the review date only for a rolling call.
  const idx = buildIndex([{ id: 'a', firstSeen: '2026-11-24', ...(await of('review-begins')) }, { id: 'b', firstSeen: '2026-11-24', ...last }], { built: '2026-11-24T00:00:00Z' });
  assert.deepEqual(idx.docs.map((d) => [d.roll ?? 0, d.rv ?? null]), [[1, '2026-12-01'], [0, null]]);
});

test('display names: "Institute of Physics" shows its city only when the ICN, city or country says Bhubaneswar', () => {
  const rules = compileDisplay(cfg.institutions.display);
  const inspire = displayInstitution({ institution: 'Institute of Physics', institutionAlt: 'Bhubaneswar, Inst. Phys.' }, rules);
  assert.equal(inspire.institution, 'Institute of Physics, Bhubaneswar');
  assert.equal(inspire.institutionSource, 'Institute of Physics', 'the source name stays searchable');
  const ajo = displayInstitution({ institution: 'Institute of Physics', city: 'Bhubaneswar', country: 'IN' }, rules);
  assert.equal(ajo.institution, 'Institute of Physics, Bhubaneswar');
  const multi = displayInstitution({ institution: 'Institute of Physics; Utkal University', institutionAlt: 'Bhubaneswar, Inst. Phys.; Utkal U.' }, rules);
  assert.equal(multi.institution, 'Institute of Physics, Bhubaneswar; Utkal University');
  for (const other of [
    { institution: 'Institute of Physics', institutionAlt: 'Zagreb, Inst. Phys.' },
    { institution: 'Institute of Physics', city: 'Prague' },
    { institution: 'Institute of Physics, Chinese Academy of Sciences' },
  ]) assert.equal(displayInstitution(other, rules), other, JSON.stringify(other));
  assert.throws(() => compileDisplay([{ name: 'X', show: 'Y' }]), /when/);
});
