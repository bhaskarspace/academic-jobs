#!/usr/bin/env node
// Reachability probe: fetch every URL in tools/probe-urls.json (plus each host's robots.txt)
// with the project User-Agent, and report status, time, size and TLS/network errors.
// Usage: node tools/probe.mjs [--label mac|runner] [--json out.json] [--md out.md] [--allowed urls.txt]
//                            [--only id,id] [--robots-cache FILE]
// robots.txt is obeyed exactly as the crawler obeys it (crawler/lib/robots.mjs): retried, then the
// last good copy (--robots-cache FILE, kept between runs by probe.yml in the Actions cache) when it
// is unreachable, and disallow-all only with no copy. Blocked URLs are reported as
// "skipped: robots.txt disallows" or "skipped: robots.txt unreachable" and never fetched.
// --allowed writes the URLs that may be fetched, one per line (probe.yml's curl comparison uses it).

import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { fetchRobots, blockedReason } from '../crawler/lib/robots.mjs';
import { loadExtraCAs } from '../crawler/lib/ca.mjs';

// Same as crawler/lib/http.mjs: give each address family 2.5 s instead of Node's 250 ms default.
if (!process.argv.includes('--node-default-family-timeout')) net.setDefaultAutoSelectFamilyAttemptTimeout(2500);
// Same as the crawler: add the intermediates from config/ca/ (unless comparing against bare Node).
if (!process.argv.includes('--no-extra-ca')) loadExtraCAs();

const UA = 'academic-jobs/0.1 (+https://github.com/bhaskarspace/academic-jobs/issues)';
const TIMEOUT_MS = 30_000;
const HOST_GAP_MS = 2_000;   // politeness: one request per host every 2 s
const CONCURRENCY = 8;       // hosts probed in parallel

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const label = opt('label', 'local');

const robotsCache = opt('robots-cache') ? JSON.parse(await readFile(opt('robots-cache'), 'utf8').catch(() => '{}')) : {};
const only = opt('only', '').split(',').filter(Boolean); // --only hri,ipr: probe just these ids
const list = JSON.parse(await readFile(new URL('./probe-urls.json', import.meta.url), 'utf8'))
  .filter(([id]) => !only.length || only.includes(id));

// Group by host so each host is hit sequentially with a gap.
const byHost = new Map();
for (const [id, url] of list) {
  const host = new URL(url).host;
  if (!byHost.has(host)) byHost.set(host, []);
  byHost.get(host).push({ id, url });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function errCode(e) {
  // undici wraps the real reason in e.cause
  const c = e?.cause ?? e;
  if (e?.name === 'TimeoutError' || c?.name === 'TimeoutError') return 'TIMEOUT';
  return c?.code || c?.name || String(c?.message || e).slice(0, 60);
}

async function probe(url, { text = false } = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.arrayBuffer();
    return {
      ...(text ? { text: new TextDecoder().decode(body) } : {}),
      status: res.status,
      ms: Math.round(performance.now() - t0),
      bytes: body.byteLength,
      finalUrl: res.url !== url ? res.url : undefined,
      server: res.headers.get('server') || undefined,
      cf: res.headers.get('cf-mitigated') || undefined,
    };
  } catch (e) {
    return { status: 0, ms: Math.round(performance.now() - t0), error: errCode(e) };
  }
}

const results = [];
const robots = {};
const hosts = [...byHost.keys()];

async function worker() {
  while (hosts.length) {
    const host = hosts.shift();
    const r = await fetchRobots(`https://${host}`, {
      cache: robotsCache,
      get: async (url) => { const p = await probe(url, { text: true }); if (!p.status) throw Object.assign(new Error(p.error), { code: p.error }); return p; },
    });
    robots[host] = { status: r.status, source: r.source, error: r.error ?? undefined, cachedAt: r.cachedAt, attempts: r.attempts };
    for (const { id, url } of byHost.get(host)) {
      const why = blockedReason(r, url);
      if (why) {
        const skipped = why === 'unreachable' ? 'robots.txt unreachable' : 'robots.txt disallows';
        results.push({ id, url, host, status: 0, ms: 0, skipped });
        process.stderr.write(`skipped: ${skipped}\t${url}\n`);
        continue;
      }
      await sleep(HOST_GAP_MS);
      const p = await probe(url);
      results.push({ id, url, host, ...p });
      process.stderr.write(`${p.status || p.error}\t${p.ms}ms\t${url}\n`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

results.sort((a, b) => list.findIndex((x) => x[1] === a.url) - list.findIndex((x) => x[1] === b.url));

const ok = results.filter((r) => r.status >= 200 && r.status < 400).length;
const skipped = results.filter((r) => r.skipped).length;
const skippedBy = (w) => results.filter((r) => r.skipped === w).length;
const summary = { label, when: new Date().toISOString(), ua: UA, total: results.length, ok, skipped };
const allowedOut = opt('allowed');
if (allowedOut) await writeFile(allowedOut, results.filter((r) => !r.skipped).map((r) => r.url).join('\n') + '\n');

if (opt('robots-cache')) await writeFile(opt('robots-cache'), JSON.stringify(robotsCache));
const jsonOut = opt('json');
if (jsonOut) await writeFile(jsonOut, JSON.stringify({ summary, robots, results }, null, 2));

const md = [
  `### Probe from ${label} (${summary.when})`,
  '',
  `${ok}/${results.length - skipped} fetched URLs answered 2xx/3xx. Skipped: ${skippedBy('robots.txt disallows')} because robots.txt disallows them, ${skippedBy('robots.txt unreachable')} because robots.txt was unreachable with no cached copy.`,
  '',
  '| id | URL | status | time | bytes | robots.txt | note |',
  '|---|---|---|---|---|---|---|',
  ...results.map((r) => {
    const rb = robots[r.host];
    const note = [r.skipped && `skipped: ${r.skipped}`, r.error, r.cf && `cf:${r.cf}`, r.finalUrl && `→ ${r.finalUrl}`].filter(Boolean).join(' ');
    return `| ${r.id} | ${r.url} | ${r.status || '—'} | ${r.skipped ? '—' : `${r.ms} ms`} | ${r.bytes ?? ''} | ${rb.status || rb.error}${rb.source === 'cache' ? ` (cached copy of ${rb.cachedAt?.slice(0, 10)})` : ''}${rb.attempts > 1 ? `, ${rb.attempts} tries` : ''} | ${note} |`;
  }),
  '',
].join('\n');

const mdOut = opt('md');
if (mdOut) await writeFile(mdOut, md);
else process.stdout.write(md);
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, md, { flag: 'a' });
