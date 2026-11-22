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
      expired: j.classList.contains('expired'),
    })),
  }));
};

let r = await run('?q=holography&cat=postdoc');
check('holography + Postdoc returns results', r.jobs.length > 5, r.summary);
check('… from INSPIRE and from AJO', r.jobs.some((j) => /INSPIRE/.test(j.sources)) && r.jobs.some((j) => /AcademicJobsOnline/.test(j.sources)));
check('… with highlighted terms, or a "via" chip for hits in the ad text', r.jobs.slice(0, 5).every((j) => j.marks.length > 0 || j.via.length > 0));
if (shots) await page.screenshot({ path: path.join(shots, 'holography-postdoc.png') });

r = await run('?cat=phd&q=junior+research+fellow');
check('a Pune JRF shows under PhD with a guessed marker', r.jobs.some((j) => /IISER Pune/.test(j.sources) && j.badges.includes('PhD?')), r.summary);
r = await run('?cat=postdoc&q=junior+research+fellow&expired=1');
check('… a bundled JRF + postdoc advert also shows under Postdoc (incl. expired)', r.jobs.some((j) => /IISER Pune/.test(j.sources) && j.badges.includes('PhD?')));

r = await run('?sort=deadline');
const dl = await page.evaluate(() => [...document.querySelectorAll('.job .dl')].map((e) => e.textContent));
const dates = dl.filter((l) => /^Deadline/.test(l)).map((l) => new Date(l.replace(/^Deadline (.*?) \(.*$/, '$1')).getTime());
check('sort by deadline is ascending', dates.length > 3 && dates.every((t, i) => i === 0 || t >= dates[i - 1]), dl[0]);
check('expired hidden by default', !r.jobs.some((j) => j.expired));
r = await run('?sort=deadline&expired=1&q=postdoc');
check('expired shown with the toggle', r.jobs.some((j) => j.expired) || /position/.test(r.summary), r.summary);

r = await run('?q=postdoc&cat=faculty');
check('POSTDOC + JUNIOR postings show under Faculty', r.jobs.some((j) => j.badges.includes('Postdoc') && j.badges.includes('Faculty')));

// Phase 2
r = await run('?q=chaos');
const main = r.jobs.filter((j) => !j.general);
const viaOnly = main.find((j) => !/chao/i.test(j.text) && j.via.some((v) => /quantum chaos/.test(v)));
check('"chaos" finds a posting without the word, and its chip says why', Boolean(viaOnly), viaOnly?.via.join(' | '));
check('… no control-engineering or probability posting via an expanded term', !main.some((j) => /control|probabilit|stochastic/i.test(j.title) && !/chao/i.test(j.text)));
r = await run('?q=chaos&cat=postdoc');
check('"chaos" + Postdoc shows the general-calls section', Boolean(r.generalHead) && r.jobs.some((j) => j.general), r.generalHead);
r = await run('?q=topological&cat=postdoc');
const pos = (re) => r.jobs.filter((j) => !j.general).findIndex((j) => re.test(j.where));
const physRank = Math.max(pos(/Leeds/), pos(/Shanghai Jiao Tong/), pos(/Hanyang/));
const mathRank = Math.min(...[pos(/Southern Denmark/) >= 0 && r.jobs.findIndex((j) => /Quantum Mathematics/.test(j.title)), pos(/Hautes/)].filter((x) => x !== false && x >= 0));
check('"topological" + Postdoc ranks Leeds, SJTU, Hanyang above the maths postings', physRank >= 0 && physRank < mathRank, `physics worst #${physRank + 1}, maths best #${mathRank + 1}`);
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
await page.route('**/data/index.json', async (route) => { await new Promise((res) => setTimeout(res, 1500)); await route.continue(); });
await page.goto(`${base}?q=postdoc`);
const loadingMore = await page.evaluate(() => [document.getElementById('summary').textContent, getComputedStyle(document.getElementById('more')).display]);
check('… and while "Loading postings…" is up', /Loading/.test(loadingMore[0]) && loadingMore[1] === 'none', loadingMore.join(' / '));
await page.unroute('**/data/index.json');

await page.setViewportSize({ width: 390, height: 900 });
r = await run('?q=AdS%2FCFT');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check('no horizontal scroll at phone width', !overflow);
if (shots) await page.screenshot({ path: path.join(shots, 'phone-adscft.png') });

await page.goto(`${base}status.html`);
await page.waitForFunction(() => !/Loading/.test(document.getElementById('lede').textContent));
const st = await page.evaluate(() => ({ lede: document.getElementById('lede').textContent, rows: [...document.querySelectorAll('#sources tbody tr')].map((r) => r.querySelector('.id').textContent) }));
const health = await (await fetch(`${base}data/health.json`)).json().catch(() => null);
check('status page lists every source', st.rows.length > 0 && (!health || Object.keys(health.sources).every((id) => st.rows.includes(id))) && !/null|undefined/.test(st.lede), `${st.rows.length} sources: ${st.lede}`);

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server?.close();
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
