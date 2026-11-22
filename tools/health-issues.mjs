#!/usr/bin/env node
// Open and close GitHub issues from the crawl's health report (.out/health.json).
//   - a source with no items for ISSUE_STREAK runs in a row  -> open "[health] <id> returns no items"
//     it recovers (items again)                               -> comment and close
//   - a config/ca/ certificate within 30 days of expiry      -> open; closed once it is replaced
// Issues carry the `source-health` label and a hidden key in the body, so each condition has at
// most one open issue. Runs from a branch other than main get the branch in the key and title,
// so a test run can't close (or duplicate) a real issue.
// Usage: node tools/health-issues.mjs [--health .out/health.json] [--dry]
// Needs GITHUB_TOKEN (issues: write) and GITHUB_REPOSITORY.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ISSUE_STREAK, CERT_WARN_DAYS } from '../crawler/lib/health.mjs';

export const LABEL = 'source-health';
const keyOf = (body) => /<!-- health:(\S+) -->/.exec(body ?? '')?.[1] ?? null;

/**
 * Pure planning step.
 * @param {object} health      the report
 * @param {Array<{number, title, body}>} open  open issues with the label
 * @param {string} [branch]    'main' for real issues
 * @returns {Array<{action: 'open'|'close', key, title?, body?, number?, comment?}>}
 */
export function planIssues(health, open, branch = 'main') {
  const tag = branch === 'main' ? '' : `@${branch}`;
  const tTag = branch === 'main' ? '' : ` [test: ${branch}]`;
  const openByKey = new Map(open.map((i) => [keyOf(i.body), i]).filter(([k]) => k));
  const want = new Map();
  const recovered = new Set();
  for (const [id, s] of Object.entries(health.sources ?? {})) {
    const key = `source:${id}${tag}`;
    if ((s.zeroStreak ?? 0) >= ISSUE_STREAK) {
      want.set(key, {
        title: `[health] ${id} returns no or too few items${tTag}`,
        body: [
          `The source \`${id}\` (${s.name ?? id}, ${s.url}) has returned no items, or a suspect drop, for ${s.zeroStreak} runs in a row.`,
          '',
          `- Last good run: ${s.lastOk ?? 'never'}`,
          `- Last error: ${s.skipped ? `skipped (${s.skipped})` : s.error ?? (s.suspect ? s.suspect : 'none (the page parsed but matched nothing; check the selectors)')}`,
          s.staleItems ? `- The site still shows ${s.staleItems} items from the last good run.` : null,
          health.run ? `- Run: ${health.run}` : null,
          '',
          'This issue closes itself when the source returns items again.',
          '',
          `<!-- health:${key} -->`,
        ].filter((l) => l !== null).join('\n'),
      });
    } else if (s.crawled && s.items > 0 && !s.suspect) recovered.add(key);
  }
  const certKeys = new Set();
  for (const c of health.certs ?? []) {
    const key = `cert:${c.file}${tag}`;
    certKeys.add(key);
    if (c.daysLeft <= CERT_WARN_DAYS) {
      want.set(key, {
        title: `[health] config/ca/${c.file} ${c.daysLeft < 0 ? 'has expired' : `expires ${c.notAfter.slice(0, 10)}`}${tTag}`,
        body: [
          `The extra CA certificate \`config/ca/${c.file}\` (${c.subject}) ${c.daysLeft < 0 ? 'expired' : 'expires'} on ${c.notAfter.slice(0, 10)} (${c.daysLeft} days).`,
          'Download its replacement from the issuer (see config/ca/README.md) and update the README row.',
          '',
          `<!-- health:${key} -->`,
        ].join('\n'),
      });
    }
  }
  const actions = [];
  for (const [key, w] of want) if (!openByKey.has(key)) actions.push({ action: 'open', key, ...w });
  for (const [key, issue] of openByKey) {
    if (want.has(key) || !key.endsWith(tag) || (tag === '' && key.includes('@'))) continue;
    if (key.startsWith('source:') && recovered.has(key)) {
      actions.push({ action: 'close', key, number: issue.number, comment: `Recovered: the source returned items again${health.run ? ` (${health.run})` : ''}.` });
    } else if (key.startsWith('cert:')) {
      actions.push({ action: 'close', key, number: issue.number, comment: certKeys.has(key) ? 'The certificate has been replaced.' : 'The certificate is no longer in config/ca/.' });
    }
  }
  return actions;
}

async function api(method, url, body) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${url}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'academic-jobs' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const healthFile = argv.includes('--health') ? argv[argv.indexOf('--health') + 1] : '.out/health.json';
  const dry = argv.includes('--dry');
  const health = JSON.parse(await readFile(healthFile, 'utf8'));
  const branch = process.env.GITHUB_REF_NAME || 'main';
  const open = dry && !process.env.GITHUB_TOKEN ? [] : await api('GET', `/issues?state=open&labels=${LABEL}&per_page=100`);
  const actions = planIssues(health, open, branch);
  for (const a of actions) {
    console.error(`${a.action} ${a.key}${a.number ? ` #${a.number}` : ''}${a.title ? `: ${a.title}` : ''}`);
    if (dry) continue;
    if (a.action === 'open') {
      const i = await api('POST', '/issues', { title: a.title, body: a.body, labels: [LABEL] });
      console.error(`  opened #${i.number}`);
    } else {
      await api('POST', `/issues/${a.number}/comments`, { body: a.comment });
      await api('PATCH', `/issues/${a.number}`, { state: 'closed', state_reason: 'completed' });
    }
  }
  if (!actions.length) console.error('health issues: nothing to do');
}
