#!/usr/bin/env node
// Reachability probe: fetch every URL in tools/probe-urls.json (plus each host's robots.txt)
// with the project User-Agent, and report status, time, size and TLS/network errors.
// Usage: node tools/probe.mjs [--label mac|runner] [--json out.json] [--md out.md]
// No dependencies, so it runs on a bare runner before `npm ci`.

import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';

// Same as crawler/lib/http.mjs: give each address family 2.5 s instead of Node's 250 ms default.
if (!process.argv.includes('--node-default-family-timeout')) net.setDefaultAutoSelectFamilyAttemptTimeout(2500);

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

const list = JSON.parse(await readFile(new URL('./probe-urls.json', import.meta.url), 'utf8'));

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

async function probe(url) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.arrayBuffer();
    return {
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
    const r = await probe(`https://${host}/robots.txt`);
    robots[host] = r;
    for (const { id, url } of byHost.get(host)) {
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
const summary = { label, when: new Date().toISOString(), ua: UA, total: results.length, ok };

const jsonOut = opt('json');
if (jsonOut) await writeFile(jsonOut, JSON.stringify({ summary, robots, results }, null, 2));

const md = [
  `### Probe from ${label} (${summary.when})`,
  '',
  `${ok}/${results.length} URLs answered 2xx/3xx.`,
  '',
  '| id | URL | status | time | bytes | robots.txt | note |',
  '|---|---|---|---|---|---|---|',
  ...results.map((r) => {
    const rb = robots[r.host];
    const note = [r.error, r.cf && `cf:${r.cf}`, r.finalUrl && `→ ${r.finalUrl}`].filter(Boolean).join(' ');
    return `| ${r.id} | ${r.url} | ${r.status || '—'} | ${r.ms} ms | ${r.bytes ?? ''} | ${rb.status || rb.error} | ${note} |`;
  }),
  '',
].join('\n');

const mdOut = opt('md');
if (mdOut) await writeFile(mdOut, md);
else process.stdout.write(md);
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, md, { flag: 'a' });
