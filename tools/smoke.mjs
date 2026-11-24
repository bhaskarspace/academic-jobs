#!/usr/bin/env node
// Browser smoke test of dist/ (or a live URL): loads the page, runs the acceptance queries and
// saves screenshots. Usage: node tools/smoke.mjs [--url https://codebpr.com/academic-jobs/] [--shots DIR]
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
let base = opt('url');
const shots = opt('shots');
let server;
if (!base) {
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  server = createServer(async (req, res) => {
    const p = path.join('dist', decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
    try { res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream' }); res.end(await readFile(p)); }
    catch { res.writeHead(404); res.end(); }
  }).listen(0);
  base = `http://localhost:${server.address().port}/`;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
// Checks that depend on what is posted right now (a particular advert, an open admissions round).
// Against the live site a miss is a warning, not a failure: a quiet month between rounds must not
// turn the smoke test red. Against a local build they stay strict; fixture tests are in npm test.
const LIVE = Boolean(opt('url'));
const warnings = [];
const posted = (name, ok, detail = '') => {
  if (ok || !LIVE) return check(name, ok, detail);
  warnings.push(name);
  console.log(`warn ${name}${detail ? `: ${detail}` : ''} (depends on current postings)`);
};
const run = async (qs) => {
  await page.goto(`${base}${qs}`);
  await page.waitForFunction(() => !/Loading/.test(document.getElementById('summary').textContent));
  return page.evaluate(() => ({
    summary: document.getElementById('summary').textContent,
    more: getComputedStyle(document.getElementById('more')).display !== 'none',
    moreText: document.getElementById('more').textContent,
    generalHead: document.getElementById('general').hidden ? null : document.getElementById('general-head').textContent,
    jobs: [...document.querySelectorAll('.job')].map((j) => ({
      title: j.querySelector('h2').textContent,
      marks: [...j.querySelectorAll('h2 mark, .snippet mark')].map((m) => m.textContent),
      where: j.querySelector('.where')?.textContent ?? '',
      why: j.querySelector('.why')?.textContent ?? '',
      via: [...j.querySelectorAll('.via')].map((v) => v.textContent),
      text: `${j.querySelector('h2').textContent} ${j.querySelector('.snippet')?.textContent ?? ''}`,
      general: Boolean(j.closest('#general')),
      sources: j.querySelector('.sources').textContent,
      badges: [...j.querySelectorAll('.badge')].map((b) => b.textContent),
      line: j.querySelector('.line').textContent,
      facts: j.querySelector('.facts')?.textContent ?? '',
      expired: j.classList.contains('expired'),
    })),
  }));
};

let r = await run('?q=holography&cat=postdoc');
check('holography + Postdoc returns results', r.jobs.length > 5, r.summary);
check('… from INSPIRE and from AJO', r.jobs.some((j) => /INSPIRE/.test(j.sources)) && r.jobs.some((j) => /AcademicJobsOnline/.test(j.sources)));
check('… with highlighted terms, or a "via" chip for hits in the ad text', r.jobs.slice(0, 5).every((j) => j.marks.length > 0 || j.via.length > 0));
if (shots) await page.screenshot({ path: path.join(shots, 'holography-postdoc.png') });

// expired=1: Pune JRFs are walk-ins that close within weeks (their PDFs now give the dates).
r = await run('?cat=phd&q=junior+research+fellow&expired=1');
posted('a Pune JRF shows under PhD with a guessed marker', r.jobs.some((j) => /IISER Pune/.test(j.sources) && j.badges.includes('PhD?')), r.summary);
r = await run('?cat=postdoc&q=junior+research+fellow&expired=1');
posted('… a bundled JRF + postdoc advert also shows under Postdoc (incl. expired)', r.jobs.some((j) => /IISER Pune/.test(j.sources) && j.badges.includes('PhD?')));

r = await run('?sort=deadline');
const dl = await page.evaluate(() => [...document.querySelectorAll('.job .dl')].map((e) => e.textContent));
const dates = dl.filter((l) => /^Deadline/.test(l)).map((l) => new Date(l.replace(/^Deadline (.*?) \(.*$/, '$1')).getTime());
check('sort by deadline is ascending', dates.length > 3 && dates.every((t, i) => i === 0 || t >= dates[i - 1]), dl[0]);
check('expired hidden by default', !r.jobs.some((j) => j.expired));
r = await run('?sort=deadline&expired=1&q=postdoc');
check('expired shown with the toggle', r.jobs.some((j) => j.expired) || /position/.test(r.summary), r.summary);

r = await run('?q=postdoc&cat=faculty');
posted('POSTDOC + JUNIOR postings show under Faculty', r.jobs.some((j) => j.badges.includes('Postdoc') && j.badges.includes('Faculty')));

// Phase 2
r = await run('?q=chaos');
const main = r.jobs.filter((j) => !j.general);
const viaOnly = main.find((j) => !/chao/i.test(j.text) && j.via.some((v) => /quantum chaos/.test(v)));
posted('"chaos" finds a posting without the word, and its chip says why', Boolean(viaOnly), viaOnly?.via.join(' | '));
check('… no control-engineering or probability posting via an expanded term', !main.some((j) => /control|probabilit|stochastic/i.test(j.title) && !/chao/i.test(j.text)));
r = await run('?q=chaos&cat=postdoc');
posted('"chaos" + Postdoc shows the general-calls section', Boolean(r.generalHead) && r.jobs.some((j) => j.general), r.generalHead);
r = await run('?q=topological&cat=postdoc');
const pos = (re) => r.jobs.filter((j) => !j.general).findIndex((j) => re.test(j.where));
const physRank = Math.max(pos(/Leeds/), pos(/Shanghai Jiao Tong/), pos(/Hanyang/));
const mathRank = Math.min(...[pos(/Southern Denmark/) >= 0 && r.jobs.findIndex((j) => /Quantum Mathematics/.test(j.title)), pos(/Hautes/)].filter((x) => x !== false && x >= 0));
posted('"topological" + Postdoc ranks Leeds, SJTU, Hanyang above the maths postings', physRank >= 0 && physRank < mathRank, `physics worst #${physRank + 1}, maths best #${mathRank + 1}`);
r = await run('?q=topological&cat=postdoc&f=physics');
check('Physics field group drops the maths postings', r.jobs.length > 5 && !r.jobs.some((j) => /Quantum Mathematics|Simons Collaboration on Perfection/.test(j.title)), r.summary);
const all = (await run('?q=postdoc')).summary.match(/\d+/)?.[0];
const hep = (await run('?q=postdoc&f=hep-th')).summary.match(/\d+/)?.[0];
const cm = (await run('?q=postdoc&f=cond-mat')).summary.match(/\d+/)?.[0];
check('hep-th and cond-mat facets filter', +hep > 0 && +cm > 0 && +hep < +all && +cm < +all, `all ${all}, hep-th ${hep}, cond-mat ${cm}`);
r = await run('?q=postdoc&ap=theory');
check('Theory filter hides obviously experimental postings', !r.jobs.some((j) => /experimental/i.test(j.title) && !/theor/i.test(j.title)), r.summary);
r = await run('?q=celestial+holography');
check('"Show more" hidden when everything is shown', r.jobs.length < 50 && !r.more, `${r.jobs.length} results, button ${r.more ? `shown: ${r.moreText}` : 'hidden'}`);
r = await run('?q=zzzzqx');
check('… and when nothing matches', !r.more);
await page.route('**/data/index.json', async (route) => { await new Promise((res) => setTimeout(res, 1500)); await route.continue().catch(() => {}); }); // the page may have moved on
await page.goto(`${base}?q=postdoc`);
const loadingMore = await page.evaluate(() => [document.getElementById('summary').textContent, getComputedStyle(document.getElementById('more')).display]);
check('… and while "Loading postings…" is up', /Loading/.test(loadingMore[0]) && loadingMore[1] === 'none', loadingMore.join(' / '));
await page.unroute('**/data/index.json');

// Phase 4
r = await run('?q=%22Three+Postdoc+Positions%22+oxford&expired=1');
const ox = r.jobs.find((j) => j.title === 'Postdoctoral Research Associate in Mathematical Physics' && /Oxford/.test(j.where));
const oxAlso = await page.evaluate(() => [...document.querySelectorAll('.job')].find((j) => /Oxford/.test(j.querySelector('.where')?.textContent ?? '') && /Mathematical Physics/.test(j.querySelector('h2').textContent))?.querySelector('.also')?.textContent ?? '');
posted('merged title names the subject; the other title is shown and found', /Three Postdoc Positions/.test(oxAlso), oxAlso);
posted('Oxford INSPIRE/AJO/MathJobs duplicate shows once, with every source', Boolean(ox) && r.jobs.filter((j) => /Oxford/.test(j.where) && /Mathematical Physics|Three Postdoc/.test(j.title)).length === 1
  && /INSPIRE/.test(ox.sources) && /AcademicJobsOnline/.test(ox.sources), ox?.sources);
posted('… and INSPIRE institutions show by full name', /University of Oxford/.test(ox?.where ?? '') && !/U\. Oxford \(main\)/.test(ox?.where ?? ''), ox?.where);
r = await run('?q=holography');
const lo = await page.evaluate(() => ({ prominent: document.getElementById('linkouts').classList.contains('prominent'), links: [...document.querySelectorAll('#linkouts a.board')].map((a) => a.href) }));
check('link-out row fills the query into each board\'s search', lo.links.length >= 8 && lo.links.every((h) => /holography/.test(h)) && !lo.prominent, lo.links.slice(0, 3).join(' '));
r = await run('?q=SYK');
const syk = await page.evaluate(() => ({ prominent: document.getElementById('linkouts').classList.contains('prominent'), first: document.querySelector('#linkouts a.board')?.href, n: document.querySelectorAll('.job').length }));
r = await run('?q=zzzzqx+syk');
const none = await page.evaluate(() => ({ prominent: document.getElementById('linkouts').classList.contains('prominent'), first: document.querySelector('#linkouts a.board')?.href }));
check('nothing found: the link-out boards take the result list\'s place', none.prominent && /zzzzqx%20syk/.test(none.first), `${none.first}; "SYK" itself: ${syk.n} results${syk.prominent ? ', link-outs shown prominently' : ''}`);
if (shots) await page.screenshot({ path: path.join(shots, 'no-results.png') });
await page.goto(`${base}?q=topological`);
await page.waitForFunction(() => !/Loading/.test(document.getElementById('summary').textContent));
await page.click('#fields button:nth-child(2)'); // Physics
r = await run('?q=topological');
const kept = await page.evaluate(() => ({ url: location.search, on: document.querySelector('#fields [aria-checked="true"]')?.firstChild.textContent }));
r = await run('?q=topological&f=');
const over = await page.evaluate(() => document.querySelector('#fields [aria-checked="true"]')?.firstChild.textContent);
check('the field facet is remembered; a URL parameter overrides it', kept.on === 'Physics' && /f=physics/.test(kept.url) && over === 'All fields', `${kept.on} ${kept.url}; with f= → ${over}`);
await page.evaluate(() => localStorage.removeItem('aj-prefs'));

await page.setViewportSize({ width: 390, height: 900 });
r = await run('?q=AdS%2FCFT');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check('no horizontal scroll at phone width', !overflow);
if (shots) await page.screenshot({ path: path.join(shots, 'phone-adscft.png') });

// Phase 6: every IISER. Expand the result list fully, then count institutions.
const allJobs = async (qs) => {
  await run(qs);
  for (let i = 0; i < 40 && await page.evaluate(() => getComputedStyle(document.getElementById('more')).display !== 'none'); i++) {
    await page.click('#more');
  }
  return page.evaluate(() => [...document.querySelectorAll('#results .job')].map((j) => ({ where: j.querySelector('.where')?.textContent ?? '', expired: j.classList.contains('expired') })));
};
const iisers = (jobs) => [...new Set(jobs.map((j) => /IISER (?:Pune|Kolkata|Mohali|Bhopal|Thiruvananthapuram|TVM|Tirupati|Berhampur)/.exec(j.where)?.[0]).filter(Boolean))];
const jrfAll = await allJobs('?q=JRF+physics&cat=phd&expired=1&f=');
posted('"JRF physics" + PhD (incl. expired) has postings from at least four IISERs', iisers(jrfAll).length >= 4, iisers(jrfAll).join(', '));
const physOpen = await allJobs('?q=physics&cat=phd&f=');
posted('"physics" + PhD shows at least one open IISER posting', iisers(physOpen).length >= 1, `${iisers(physOpen).join(', ') || 'none'} (${physOpen.length} open results)`);
r = await run('?q=holography&f=');
for (let i = 0; i < 20 && await page.evaluate(() => !document.getElementById('general-more').hidden); i++) await page.click('#general-more');
const generalIiser = await page.evaluate(() => [...document.querySelectorAll('#general .job')].filter((j) => /IISER/.test(j.querySelector('.where')?.textContent ?? '') && /ph\.?\s?d|admission/i.test(j.querySelector('h2').textContent)).map((j) => j.querySelector('h2').textContent));
posted('IISER PhD admissions calls show among the general calls of a physics topic', generalIiser.length > 0, generalIiser.slice(0, 3).join(' | '));

// Phase 5: PDF adverts.
// "condensed matter" has ~200 board hits; a Pune PDF-only hit may sit below the first page, so
// also try a rarer term from the same advert family.
let pdfHit = null;
for (const q of ['condensed+matter+pune', 'magnon', 'condensed+matter']) {
  r = await run(`?q=${q}&expired=1&f=`);
  pdfHit = r.jobs.find((j) => /IISER Pune/.test(j.sources) && /PDF advert/.test(j.why));
  if (pdfHit) break;
}
posted('a Pune ad matched only through its PDF says "matched in PDF"', Boolean(pdfHit), pdfHit ? `${pdfHit.title}: ${pdfHit.why}` : r.summary);
r = await run('?q=project+associate&expired=1&f=');
const withFacts = r.jobs.find((j) => /IISER Pune/.test(j.sources) && /Advt\. No\./.test(j.facts));
posted('… Pune cards show Advt. No. / project / age-limit facts', Boolean(withFacts), withFacts?.facts);

// Stale-data banner: none while fresh, shown when the last crawl is over 26 hours old.
const idxMeta = await (await fetch(`${base}data/index.json`)).json();
const ageH = (Date.now() - Date.parse(idxMeta.built)) / 3.6e6;
r = await run('?q=holography');
const staleNow = await page.evaluate(() => !document.getElementById('stale').hidden);
check('no stale-data banner while the data is fresh', staleNow === (ageH > 26), `data ${ageH.toFixed(1)} h old, banner ${staleNow ? 'shown' : 'hidden'}`);
const later = await browser.newPage();
await later.addInitScript((skew) => { const now = Date.now; Date.now = () => now() + skew; }, Math.max(0, (27 - ageH) * 3.6e6));
await later.goto(`${base}?q=holography`);
await later.waitForFunction(() => !/Loading/.test(document.getElementById('summary').textContent));
const staleSearch = await later.evaluate(() => (document.getElementById('stale').hidden ? '' : document.getElementById('stale').textContent));
await later.goto(`${base}status.html`);
await later.waitForFunction(() => !/Loading/.test(document.getElementById('lede').textContent));
const staleStatus = await later.evaluate(() => (document.getElementById('stale').hidden ? '' : document.getElementById('stale').textContent));
await later.close();
check('"data is N hours old" warning on search and status pages after 26 h', /data is 2\d hours old/.test(staleSearch) && /data is 2\d hours old/.test(staleStatus), staleSearch.slice(0, 60));

// Phase 7: an institute's own postdoc call is searchable; ICTS's merges with its INSPIRE/AJO copies;
// a standing call reads as rolling. All depend on what is posted now: warnings on the live site.
{
  const inst = await run('?q=ICTS%20IMSc%20postdoctoral&cat=postdoc&expired=1&f=');
  const hit = inst.jobs.find((j) => /ICTS|Theoretical Sciences|Mathematical Sciences|IMSc/.test(`${j.where} ${j.sources}`));
  posted('an IMSc or ICTS postdoc call is searchable', Boolean(hit), hit ? `${hit.title} (${hit.sources})` : inst.summary);
  const icts = (await run('?q=ICTS%20Postdoctoral%20Program%202027&expired=1&f=')).jobs.filter((j) => /ICTS.{0,10}Postdoctoral Program 2027/i.test(j.title));
  posted('ICTS Postdoctoral Program 2027 shows once, with INSPIRE + AJO + ICTS sources', icts.length === 1 && /INSPIRE/.test(icts[0].sources) && /AcademicJobsOnline/.test(icts[0].sources) && /ICTS/.test(icts[0].sources),
    icts.map((j) => `${j.title} [${j.sources}]`).join(' | ') || 'not found');
  const roll = (await run('?q=post-doctoral%20fellowships%20IMSc%20RRI&cat=postdoc&f=')).jobs.find((j) => /IMSc|RRI|Raman/.test(`${j.title} ${j.where}`));
  posted('a standing call (IMSc or RRI postdoc) reads "Rolling call" and never "possibly closed"', Boolean(roll && /Rolling call/.test(roll.line) && !/possibly closed/.test(roll.line)), roll ? roll.line : 'not found');
}

await page.goto(`${base}status.html`);
await page.waitForFunction(() => !/Loading/.test(document.getElementById('lede').textContent));
const st = await page.evaluate(() => ({
  lede: document.getElementById('lede').textContent,
  summary: document.getElementById('summary').textContent,
  rows: [...document.querySelectorAll('#sources tbody tr .id')].map((e) => e.textContent),
  groups: [...document.querySelectorAll('#sources tr.inst th')].map((e) => e.textContent),
  pills: [...document.querySelectorAll('#sources tbody tr .pill')].map((e) => e.className.replace('pill ', '')),
  dateWraps: [...document.querySelectorAll('#sources td.date')].some((td) => { const r = document.createRange(); r.selectNodeContents(td); return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size > 1; }),
}));
const health = await (await fetch(`${base}data/health.json`)).json().catch(() => null);
check('status page lists every source', st.rows.length > 0 && (!health || Object.keys(health.sources).every((id) => st.rows.includes(id))) && !/null|undefined/.test(st.lede), `${st.rows.length} sources: ${st.lede}`);

// Phase 7: every research-institute source is on the status page (crawled or link-out), and ARIES,
// the slow host, finished or was cut off within its watchdog.
const PHASE7 = ['iisc-contractual', 'icts-opportunities', 'iop', 'sinp', 'rri-postdoc', 'bose', 'iucaa',
  'tifrh-postdoc', 'tifrh-jrf', 'ncra-postdoc', 'isi-bangalore', 'aries', 'niser-fixed-term', 'jncasr', 'iia',
  'imsc-programmes', 'imsc-other', 'isi-kolkata-linkout', 'iacs', 'cmi', 'tifr', 'hri', 'ipr', 'prl'];
check('status page lists every Phase 7 institute source (crawled, partial or link-out)', PHASE7.every((id) => st.rows.includes(id)), PHASE7.filter((id) => !st.rows.includes(id)).join(', ') || `${PHASE7.length} listed`);
{
  const a = health?.sources?.aries;
  const ARIES_LIMIT_MS = 5 * 60_000; // config/sources.yaml timeoutMin: 5
  check('ARIES finished or was cut off within its watchdog', !health || (a && a.ms <= ARIES_LIMIT_MS + 5000 && (a.ok || a.error === 'WATCHDOG' || a.staleItems != null)),
    a ? `${a.ok ? 'ok' : a.error} in ${(a.ms / 1000).toFixed(0)} s` : 'no aries entry');
  const ok7 = PHASE7.filter((id) => health?.sources?.[id]?.crawled && !health.sources[id].ok);
  posted('Phase 7 crawled sources are green', ok7.length === 0, ok7.join(', ') || 'all OK');
}

// A source with more new PDFs than one run fetches shows "Backfilling, N waiting", not OK.
{
  const fill = await browser.newPage();
  await fill.route('**/data/health.json', async (route) => {
    const res = await route.fetch();
    const h = await res.json();
    const id = Object.keys(h.sources).find((k) => h.sources[k].crawled && h.sources[k].ok);
    if (id) h.sources[id].pdf = { ...(h.sources[id].pdf ?? {}), deferred: 37 };
    await route.fulfill({ response: res, json: h });
  });
  await fill.goto(`${base}status.html`);
  await fill.waitForFunction(() => !/Loading/.test(document.getElementById('lede').textContent));
  const pills = await fill.evaluate(() => [...document.querySelectorAll('#sources .pill')].map((p) => p.textContent));
  await fill.close();
  check('a PDF backlog shows "Backfilling, N waiting" on the status page', pills.includes('Backfilling, 37 waiting'), pills.filter((p) => !/^OK$/.test(p)).slice(0, 4).join(' | '));
}

check('status summary line counts OK, link-outs, warnings, failing', /^\d+ OK · \d+ link-outs? · \d+ warnings? · \d+ failing/.test(st.summary), st.summary);
const ORDER = { fail: 0, warn: 1, skip: 2, ok: 3, idle: 4 };
check('… problem rows first, institution pages grouped, Last OK on one line',
  st.pills.length > 0 && st.groups.some((g) => /IISER Pune/.test(g)) && !st.dateWraps
  && st.pills.slice(0, st.pills.findIndex((p) => ORDER[p] >= 2) >>> 0).every((p) => ORDER[p] < 2),
  `groups: ${st.groups.join(' | ')}`);

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server?.close();
if (warnings.length) console.log(`${warnings.length} warning${warnings.length > 1 ? 's' : ''} (checks that depend on current postings; not failures on the live site)`);
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
