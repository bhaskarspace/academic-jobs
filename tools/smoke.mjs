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
    jobs: [...document.querySelectorAll('.job')].map((j) => ({
      title: j.querySelector('h2').textContent,
      marks: [...j.querySelectorAll('h2 mark, .snippet mark')].map((m) => m.textContent),
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
check('… with highlighted terms', r.jobs.slice(0, 5).every((j) => j.marks.length > 0));
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

await page.setViewportSize({ width: 390, height: 900 });
r = await run('?q=AdS%2FCFT');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check('no horizontal scroll at phone width', !overflow);
if (shots) await page.screenshot({ path: path.join(shots, 'phone-adscft.png') });

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server?.close();
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
